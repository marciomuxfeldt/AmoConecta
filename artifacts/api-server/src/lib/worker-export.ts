import { Readable } from "node:stream";
import {
  csvHeaderLine,
  csvPreamble,
  csvRowLine,
  type BiExportRow,
} from "./csv-export";
import { supabaseAdminClient } from "./supabase";
import { logger } from "./logger";
import { getTechnicalError, getTechnicalErrorText } from "./technical-error";

const PAGE_SIZE = 500;
// Stay well below the scheduled worker's two-minute ceiling and checkpoint
// each page before starting another one.
const BATCH_BUDGET_MS = 45_000;
const MIN_NEXT_PAGE_BUDGET_MS = 10_000;
const EXPIRED_CLEANUP_BUDGET_MS = 8_000;
const EXPIRED_PARTS_PER_RUN = 10;
const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
const PARTS_MARKER = "manifest.csv";

class ExportBatchDeferredError extends Error {
  constructor() {
    super("BI export batch paused at its execution budget.");
    this.name = "ExportBatchDeferredError";
  }
}

function assertBeforeDeadline(deadline: number): void {
  if (Date.now() >= deadline) throw new ExportBatchDeferredError();
}

function signalBeforeDeadline(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ExportBatchDeferredError();
  return AbortSignal.timeout(remaining);
}

function partObjectPath(jobId: string, partIndex: number): string {
  return `/objects/bi-exports/${jobId}/parts/${partIndex}.csv`;
}

function manifestObjectPath(jobId: string): string {
  return `/objects/bi-exports/${jobId}/${PARTS_MARKER}`;
}

function manifestJobId(objectPath: string): string | null {
  const match =
    /^\/objects\/bi-exports\/([0-9a-f-]{36})\/manifest\.csv$/iu.exec(objectPath);
  return match?.[1] ?? null;
}

function objectLocation(objectPath: string): { bucket: string; name: string } {
  const privateDir = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR não está configurado.");
  const normalized = objectPath.replace(/^\/objects\//u, "").replace(/^\/+/u, "");
  if (!normalized || normalized.includes("..") || normalized.includes("//")) {
    throw new Error("Caminho de objeto privado inválido.");
  }
  const parts = privateDir.replace(/^\/+/u, "").split("/");
  const bucket = parts[0] || process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID?.trim();
  if (!bucket) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID não está configurado.");
  const prefix = parts.slice(1).join("/");
  return { bucket, name: prefix ? `${prefix}/${normalized}` : normalized };
}

async function signedObjectUrl(
  location: { bucket: string; name: string },
  method: "GET" | "PUT" | "DELETE",
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${SIDECAR_ENDPOINT}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: location.bucket,
      object_name: location.name,
      method,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`App Storage URL falhou (${response.status}).`);
  const payload = (await response.json()) as { signed_url?: string };
  if (!payload.signed_url) throw new Error("App Storage não retornou uma URL assinada.");
  return payload.signed_url;
}

async function uploadBiExportPart(
  jobId: string,
  partIndex: number,
  content: string,
  deadline: number,
): Promise<void> {
  const objectPath = partObjectPath(jobId, partIndex);
  const signal = signalBeforeDeadline(deadline);
  const url = await signedObjectUrl(objectLocation(objectPath), "PUT", signal);
  assertBeforeDeadline(deadline);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/csv; charset=utf-8" },
    body: content,
    signal,
  });
  if (!response.ok) throw new Error(`Upload App Storage falhou (${response.status}).`);
  assertBeforeDeadline(deadline);
}

async function openStoredObject(objectPath: string): Promise<NodeJS.ReadableStream> {
  const normalized = objectPath.replace(/^\/+/, "");
  if (!normalized.startsWith("objects/")) {
    throw new Error("Caminho de objeto privado inválido.");
  }
  const response = await fetch(
    await signedObjectUrl(objectLocation(`/${normalized}`), "GET"),
  );
  if (!response.ok || !response.body) {
    throw new Error(`Download App Storage falhou (${response.status}).`);
  }
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export async function openBiExportCsv(
  objectPath: string,
  partCount?: number,
): Promise<NodeJS.ReadableStream> {
  const jobId = manifestJobId(objectPath);
  if (!jobId) return openStoredObject(objectPath);
  if (!Number.isInteger(partCount) || (partCount ?? -1) < 0) {
    throw new Error("Manifesto da exportação BI inválido.");
  }

  const csv = async function* (): AsyncGenerator<string | Buffer> {
    yield csvPreamble();
    yield csvHeaderLine();
    for (let partIndex = 0; partIndex < (partCount ?? 0); partIndex += 1) {
      const part = await openStoredObject(partObjectPath(jobId, partIndex));
      for await (const chunk of part) {
        yield chunk as string | Buffer;
      }
    }
  };
  return Readable.from(csv());
}

type ExportFilter =
  | "todos"
  | "clicaram"
  | "abriram_sem_clicar"
  | "nao_abriram"
  | "bounce_ou_reclamacao";

type ExportJob = {
  id: string;
  campanha_id: string | null;
  filtro: ExportFilter;
  periodo_inicio?: string | null;
  periodo_fim?: string | null;
  status: string;
  expira_em: string;
  cursor_destinatario_id: string | null;
  partes_processadas: number;
  fonte_concluida: boolean;
  linhas_processadas: number;
};

function matchesFilter(row: Record<string, unknown>, filter: ExportFilter): boolean {
  if (filter === "todos") return true;
  const clicked = row.clicado_em != null;
  const opened = row.aberto_em != null;
  const status = String(row.status ?? "");
  if (filter === "clicaram") return clicked;
  if (filter === "abriram_sem_clicar") return opened && !clicked;
  if (filter === "nao_abriram") {
    return row.enviado_em != null && !opened && !clicked;
  }
  return status === "bounce" ||
    status === "reclamacao" ||
    typeof row.bounce_tipo_bruto === "string" ||
    row.reclamado_em != null ||
    row.motivo_nao_envio === "bounce" ||
    row.motivo_nao_envio === "reclamacao";
}

async function expireExports(): Promise<void> {
  const client = supabaseAdminClient();
  const deadline = Date.now() + EXPIRED_CLEANUP_BUDGET_MS;
  const { data, error: loadError } = await client
    .from("exportacao_csv")
    .select(
      "id,caminho_objeto,partes_processadas,partes_removidas,limpeza_concluida",
    )
    .lt("expira_em", new Date().toISOString())
    .eq("limpeza_concluida", false)
    .order("expira_em", { ascending: true })
    .limit(1);
  if (loadError) throw loadError;
  const row = data?.[0];
  if (row) {
    try {
      const objectPath =
        typeof row.caminho_objeto === "string" ? row.caminho_objeto : null;
      if (objectPath && !manifestJobId(objectPath)) {
        const signal = signalBeforeDeadline(deadline);
        const response = await fetch(
          await signedObjectUrl(
            objectLocation(objectPath),
            "DELETE",
            signal,
          ),
          { method: "DELETE", signal },
        );
        if (!response.ok && response.status !== 404) {
          throw new Error(`App Storage cleanup failed (${response.status}).`);
        }
      }
      const knownParts =
        typeof row.partes_processadas === "number" ? row.partes_processadas : 0;
      let removedParts =
        typeof row.partes_removidas === "number" ? row.partes_removidas : 0;
      if (!objectPath || manifestJobId(objectPath) || knownParts > 0) {
        // Include the next index: it may have been uploaded just before a
        // worker stopped, before its checkpoint reached Supabase.
        const totalPartObjects = Math.max(1, knownParts + 1);
        const stopAt = Math.min(
          totalPartObjects,
          removedParts + EXPIRED_PARTS_PER_RUN,
        );
        for (let partIndex = removedParts; partIndex < stopAt; partIndex += 1) {
          const signal = signalBeforeDeadline(deadline);
          const response = await fetch(
            await signedObjectUrl(
              objectLocation(partObjectPath(row.id, partIndex)),
              "DELETE",
              signal,
            ),
            { method: "DELETE", signal },
          );
          if (!response.ok && response.status !== 404) {
            throw new Error(
              `App Storage part cleanup failed (${response.status}).`,
            );
          }
          removedParts = partIndex + 1;
        }
        if (removedParts !== Number(row.partes_removidas ?? 0)) {
          const { error: progressError } = await client
            .from("exportacao_csv")
            .update({ partes_removidas: removedParts })
            .eq("id", row.id)
            .abortSignal(signalBeforeDeadline(deadline));
          if (progressError) throw progressError;
        }
        if (removedParts < totalPartObjects) {
          throw new ExportBatchDeferredError();
        }
      }
      const { error: cleanupError } = await client
        .from("exportacao_csv")
        .update({ limpeza_concluida: true })
        .eq("id", row.id)
        .abortSignal(signalBeforeDeadline(deadline));
      if (cleanupError) throw cleanupError;
    } catch (error) {
      if (!(error instanceof ExportBatchDeferredError) && Date.now() < deadline) {
        logger.warn(
          { technicalError: getTechnicalError(error), exportId: row.id },
          "Expired BI object cleanup failed",
        );
      }
    }
  }
  const { error: updateError } = await client
    .from("exportacao_csv")
    .update({ status: "expirada", erro: "Arquivo expirado." })
    .lt("expira_em", new Date().toISOString())
    .in("status", ["pendente", "processando", "concluida"]);
  if (updateError) throw updateError;
}

async function saveExportCheckpoint(
  jobId: string,
  values: Record<string, unknown>,
  deadline: number,
): Promise<boolean> {
  assertBeforeDeadline(deadline);
  const { data, error } = await supabaseAdminClient()
    .from("exportacao_csv")
    .update(values)
    .eq("id", jobId)
    .eq("status", "processando")
    .abortSignal(signalBeforeDeadline(deadline))
    .select("id")
    .maybeSingle();
  if (error) throw error;
  assertBeforeDeadline(deadline);
  return Boolean(data);
}

async function processExport(job: ExportJob): Promise<boolean> {
  const client = supabaseAdminClient();
  const deadline = Date.now() + BATCH_BUDGET_MS;
  let partCount = Number.isInteger(job.partes_processadas)
    ? job.partes_processadas
    : 0;
  let cursorId = job.cursor_destinatario_id ?? null;
  const resetLegacyProgress =
    !cursorId && partCount === 0 && !job.fonte_concluida;

  try {
    const { data: claimed, error: claimError } = await client
      .from("exportacao_csv")
      .update({
        status: "processando",
        iniciado_em: new Date().toISOString(),
        erro: null,
        ...(resetLegacyProgress
          ? { linhas_processadas: 0, total_linhas: null }
          : {}),
      })
      .eq("id", job.id)
      .in("status", ["pendente", "processando"])
      .abortSignal(signalBeforeDeadline(deadline))
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return false;

    let processed = resetLegacyProgress
      ? 0
      : Number.isInteger(job.linhas_processadas)
        ? job.linhas_processadas
        : 0;
    if (job.fonte_concluida) {
      return saveExportCheckpoint(
        job.id,
        {
          status: "concluida",
          total_linhas: processed,
          linhas_processadas: processed,
          caminho_objeto: manifestObjectPath(job.id),
          concluido_em: new Date().toISOString(),
        },
        deadline,
      );
    }

    while (true) {
      assertBeforeDeadline(deadline);
      let query = client
        .from("destinatario")
        .select(
          "id,email,nome,id_usuario,regiao,data_ultima_compra,campanha_id,is_lembrete,status,enviado_em,entregue_em,aberto_em,clicado_em,motivo_nao_envio",
        )
        .order("id", { ascending: true })
        .limit(PAGE_SIZE);
      if (cursorId) query = query.gt("id", cursorId);
      if (job.campanha_id) query = query.eq("campanha_id", job.campanha_id);
      if (job.periodo_inicio) {
        query = query.gte(
          "enviado_em",
          `${job.periodo_inicio}T00:00:00.000Z`,
        );
      }
      if (job.periodo_fim) {
        const exclusiveEnd = new Date(`${job.periodo_fim}T00:00:00.000Z`);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        query = query.lt("enviado_em", exclusiveEnd.toISOString());
      }
      const { data, error } = await query.abortSignal(
        signalBeforeDeadline(deadline),
      );
      if (error) throw error;
      assertBeforeDeadline(deadline);

      if (!data?.length) {
        return saveExportCheckpoint(
          job.id,
          {
            status: "concluida",
            fonte_concluida: true,
            total_linhas: processed,
            linhas_processadas: processed,
            caminho_objeto: manifestObjectPath(job.id),
            concluido_em: new Date().toISOString(),
          },
          deadline,
        );
      }

      const emails = [
        ...new Set(
          data
            .map((row) => (typeof row.email === "string" ? row.email : null))
            .filter((email): email is string => Boolean(email))
            .map((email) => email.trim().toLowerCase()),
        ),
      ];
      const campaignIds = [
        ...new Set(
          data
            .map((row) =>
              typeof row.campanha_id === "string" ? row.campanha_id : null,
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const campaignNames = new Map<string, string>();
      if (campaignIds.length > 0) {
        const { data: campaigns, error: campaignError } = await client
          .from("campanha")
          .select("id,nome")
          .in("id", campaignIds)
          .abortSignal(signalBeforeDeadline(deadline));
        if (campaignError) throw campaignError;
        assertBeforeDeadline(deadline);
        for (const campaign of campaigns ?? []) {
          if (typeof campaign.nome === "string") {
            campaignNames.set(campaign.id, campaign.nome);
          }
        }
      }

      const eventByRecipient = new Map<
        string,
        { bounce: boolean; complaint: boolean }
      >();
      if (emails.length > 0 && campaignIds.length > 0) {
        for (let eventOffset = 0; ; eventOffset += PAGE_SIZE) {
          assertBeforeDeadline(deadline);
          const { data: events, error: eventsError } = await client
            .from("evento_email")
            .select("id,email,tipo,campanha_id")
            .in("email", emails)
            .in("campanha_id", campaignIds)
            .in("tipo", ["email.bounced", "email.complained"])
            .order("id", { ascending: true })
            .range(eventOffset, eventOffset + PAGE_SIZE - 1)
            .abortSignal(signalBeforeDeadline(deadline));
          if (eventsError) throw eventsError;
          assertBeforeDeadline(deadline);
          for (const event of events ?? []) {
            const email =
              typeof event.email === "string"
                ? event.email.trim().toLowerCase()
                : "";
            const eventCampaignId =
              typeof event.campanha_id === "string" ? event.campanha_id : "";
            if (!email || !eventCampaignId) continue;
            const key = `${eventCampaignId}:${email}`;
            const current = eventByRecipient.get(key) ?? {
              bounce: false,
              complaint: false,
            };
            current.bounce ||= event.tipo === "email.bounced";
            current.complaint ||= event.tipo === "email.complained";
            eventByRecipient.set(key, current);
          }
          if ((events?.length ?? 0) < PAGE_SIZE) break;
        }
      }

      const csvRows: string[] = [];
      const filter = job.filtro ?? "todos";
      for (const raw of data) {
        const row = raw as Record<string, unknown>;
        const rowEmail =
          typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
        const rowCampaignId =
          typeof row.campanha_id === "string" ? row.campanha_id : "";
        const eventsForRow = eventByRecipient.get(
          `${rowCampaignId}:${rowEmail}`,
        );
        if (eventsForRow?.bounce) row.bounce_tipo_bruto = "bounce";
        if (eventsForRow?.complaint) row.reclamado_em = true;
        if (!matchesFilter(row, filter)) continue;
        const campaignName = rowCampaignId
          ? campaignNames.get(rowCampaignId) ?? null
          : null;
        csvRows.push(
          csvRowLine({
            email: typeof row.email === "string" ? row.email : null,
            nome: typeof row.nome === "string" ? row.nome : null,
            id_usuario: (row.id_usuario as string | number | null) ?? null,
            regiao: typeof row.regiao === "string" ? row.regiao : null,
            data_ultima_compra:
              typeof row.data_ultima_compra === "string"
                ? row.data_ultima_compra
                : null,
            campanha_id: (row.campanha_id as string | number | null) ?? null,
            campanha_nome: campaignName,
            is_lembrete:
              typeof row.is_lembrete === "boolean" ? row.is_lembrete : null,
            status: typeof row.status === "string" ? row.status : null,
            enviado_em: (row.enviado_em as string | null) ?? null,
            entregue_em: (row.entregue_em as string | null) ?? null,
            aberto_em: (row.aberto_em as string | null) ?? null,
            clicado_em: (row.clicado_em as string | null) ?? null,
            motivo_nao_envio:
              typeof row.motivo_nao_envio === "string"
                ? row.motivo_nao_envio
                : null,
          } satisfies BiExportRow),
        );
      }
      processed += csvRows.length;

      const lastRow = data[data.length - 1] as Record<string, unknown>;
      if (typeof lastRow.id !== "string") {
        throw new Error("A página de exportação não retornou o cursor do contato.");
      }
      const nextPartCount = partCount + (csvRows.length > 0 ? 1 : 0);
      if (csvRows.length > 0) {
        await uploadBiExportPart(
          job.id,
          partCount,
          csvRows.join(""),
          deadline,
        );
      }
      const sourceComplete = data.length < PAGE_SIZE;
      const checkpoint: Record<string, unknown> = {
        cursor_destinatario_id: lastRow.id,
        partes_processadas: nextPartCount,
        fonte_concluida: sourceComplete,
        linhas_processadas: processed,
      };
      if (sourceComplete) {
        Object.assign(checkpoint, {
          status: "concluida",
          total_linhas: processed,
          caminho_objeto: manifestObjectPath(job.id),
          concluido_em: new Date().toISOString(),
        });
      }
      const saved = await saveExportCheckpoint(job.id, checkpoint, deadline);
      if (!saved || sourceComplete) return saved && sourceComplete;

      cursorId = lastRow.id;
      partCount = nextPartCount;
      if (Date.now() + MIN_NEXT_PAGE_BUDGET_MS >= deadline) {
        throw new ExportBatchDeferredError();
      }
    }
  } catch (error) {
    if (error instanceof ExportBatchDeferredError || Date.now() >= deadline) {
      throw new ExportBatchDeferredError();
    }
    throw error;
  }
}

export async function processBiExportJobs(): Promise<number> {
  const client = supabaseAdminClient();
  await expireExports();
  const { data, error } = await client.from("exportacao_csv")
    .select(
      "id,campanha_id,filtro,periodo_inicio,periodo_fim,status,expira_em,cursor_destinatario_id,partes_processadas,fonte_concluida,linhas_processadas",
    )
    .in("status", ["pendente", "processando"])
    .order("criado_em", { ascending: true })
    .limit(1);
  if (error) throw error;
  let count = 0;
  for (const row of data ?? []) {
    try {
      if (Date.parse(String(row.expira_em)) <= Date.now()) continue;
      if (await processExport(row as ExportJob)) count += 1;
    } catch (error) {
      if (error instanceof ExportBatchDeferredError) {
        logger.warn(
          {
            exportId: row.id,
            technicalError: getTechnicalError(error),
          },
          "BI export batch paused; it will resume in a later worker run",
        );
        continue;
      }
      const { error: persistError } = await client
        .from("exportacao_csv")
        .update({
          status: "erro",
          erro: getTechnicalErrorText(error),
        })
        .eq("id", row.id)
        .eq("status", "processando");
      if (persistError) {
        logger.error(
          {
            technicalError: getTechnicalError(persistError),
            exportId: row.id,
          },
          "Failed to persist BI export failure",
        );
      }
      logger.error(
        { technicalError: getTechnicalError(error), exportId: row.id },
        "BI export failed",
      );
    }
  }
  return count;
}