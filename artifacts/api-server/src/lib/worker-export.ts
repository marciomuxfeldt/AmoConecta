import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  csvHeaderLine,
  csvPreamble,
  csvRowLine,
  type BiExportRow,
} from "./csv-export";
import { supabaseAdminClient } from "./supabase";
import { logger } from "./logger";

const PAGE_SIZE = 500;
const SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

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
  });
  if (!response.ok) throw new Error(`App Storage URL falhou (${response.status}).`);
  const payload = (await response.json()) as { signed_url?: string };
  if (!payload.signed_url) throw new Error("App Storage não retornou uma URL assinada.");
  return payload.signed_url;
}

export async function uploadBiExportCsv(
  jobId: string,
  source: NodeJS.ReadableStream,
): Promise<string> {
  const objectPath = `/objects/bi-exports/${jobId}-${randomUUID()}.csv`;
  const url = await signedObjectUrl(objectLocation(objectPath), "PUT");
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "text/csv; charset=utf-8" },
    body: source as never,
    duplex: "half",
  } as RequestInit);
  if (!response.ok) throw new Error(`Upload App Storage falhou (${response.status}).`);
  return objectPath;
}

export async function openBiExportCsv(
  objectPath: string,
): Promise<NodeJS.ReadableStream> {
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
  const { data, error: loadError } = await client
    .from("exportacao_csv")
    .select("id,caminho_objeto")
    .lt("expira_em", new Date().toISOString())
    .not("caminho_objeto", "is", null);
  if (loadError) throw loadError;
  for (const row of data ?? []) {
    if (typeof row.caminho_objeto !== "string") continue;
    try {
      const response = await fetch(
        await signedObjectUrl(objectLocation(row.caminho_objeto), "DELETE"),
        { method: "DELETE" },
      );
      if (!response.ok) logger.warn({ exportId: row.id }, "Expired BI object cleanup failed");
    } catch (error) {
      logger.warn({ error, exportId: row.id }, "Expired BI object cleanup failed");
    }
  }
  const { error: updateError } = await client
    .from("exportacao_csv")
    .update({ status: "expirada", erro: "Arquivo expirado." })
    .lt("expira_em", new Date().toISOString())
    .in("status", ["pendente", "processando", "concluida"]);
  if (updateError) throw updateError;
}

async function processExport(job: ExportJob): Promise<boolean> {
  const client = supabaseAdminClient();
  const started = new Date().toISOString();
  const { data: claimed, error: claimError } = await client.from("exportacao_csv").update({
    status: "processando",
    iniciado_em: started,
    erro: null,
  }).eq("id", job.id).eq("status", "pendente").select("id").maybeSingle();
  if (claimError) throw claimError;
  if (!claimed) return false;

  let processed = 0;
  const filter = job.filtro ?? "todos";
  const campaignId = job.campanha_id;
  const csv = async function* (): AsyncGenerator<string> {
    yield csvPreamble();
    yield csvHeaderLine();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = client.from("destinatario").select(
        "email,nome,id_usuario,regiao,data_ultima_compra,campanha_id,is_lembrete,status,enviado_em,entregue_em,aberto_em,clicado_em,motivo_nao_envio",
      ).order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
      if (campaignId) query = query.eq("campanha_id", campaignId);
      if (job.periodo_inicio) query = query.gte("enviado_em", `${job.periodo_inicio}T00:00:00.000Z`);
      if (job.periodo_fim) {
        const exclusiveEnd = new Date(`${job.periodo_fim}T00:00:00.000Z`);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        query = query.lt("enviado_em", exclusiveEnd.toISOString());
      }
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) break;
      const emails = [...new Set((data ?? [])
        .map((row) => (typeof row.email === "string" ? row.email : null))
        .filter((email): email is string => Boolean(email))
        .map((email) => email.trim().toLowerCase()))];
      const campaignIds = [
        ...new Set(
          (data ?? [])
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
          .in("id", campaignIds);
        if (campaignError) throw campaignError;
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
          const { data: events, error: eventsError } = await client
            .from("evento_email")
            .select("id,email,tipo,campanha_id")
            .in("email", emails)
            .in("campanha_id", campaignIds)
            .in("tipo", ["email.bounced", "email.complained"])
            .order("id", { ascending: true })
            .range(eventOffset, eventOffset + PAGE_SIZE - 1);
          if (eventsError) throw eventsError;
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
      for (const raw of data ?? []) {
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
        yield csvRowLine({
        email: typeof row.email === "string" ? row.email : null,
        nome: typeof row.nome === "string" ? row.nome : null,
        id_usuario: (row.id_usuario as string | number | null) ?? null,
        regiao: typeof row.regiao === "string" ? row.regiao : null,
        data_ultima_compra: typeof row.data_ultima_compra === "string" ? row.data_ultima_compra : null,
        campanha_id: (row.campanha_id as string | number | null) ?? null,
        campanha_nome: campaignName,
        is_lembrete: typeof row.is_lembrete === "boolean" ? row.is_lembrete : null,
        status: typeof row.status === "string" ? row.status : null,
        enviado_em: (row.enviado_em as string | null) ?? null,
        entregue_em: (row.entregue_em as string | null) ?? null,
        aberto_em: (row.aberto_em as string | null) ?? null,
        clicado_em: (row.clicado_em as string | null) ?? null,
        motivo_nao_envio: typeof row.motivo_nao_envio === "string" ? row.motivo_nao_envio : null,
        } satisfies BiExportRow);
        processed += 1;
      }
      const { error: progressError } = await client
        .from("exportacao_csv")
        .update({ linhas_processadas: processed })
        .eq("id", job.id)
        .eq("status", "processando");
      if (progressError) throw progressError;
      if ((data?.length ?? 0) < PAGE_SIZE) break;
    }
  };
  const path = await uploadBiExportCsv(job.id, Readable.from(csv()));
  const { data: completed, error: completeError } = await client
    .from("exportacao_csv")
    .update({
      status: "concluida",
      total_linhas: processed,
      linhas_processadas: processed,
      caminho_objeto: path,
      concluido_em: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "processando")
    .select("id")
    .maybeSingle();
  if (completeError) throw completeError;
  if (!completed) {
    const deleteResponse = await fetch(
      await signedObjectUrl(objectLocation(path), "DELETE"),
      { method: "DELETE" },
    );
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      logger.warn({ exportId: job.id }, "Orphaned BI object cleanup failed");
    }
    return false;
  }
  return true;
}

export async function processBiExportJobs(): Promise<number> {
  const client = supabaseAdminClient();
  await expireExports();
  const { data, error } = await client.from("exportacao_csv")
    .select("id,campanha_id,filtro,periodo_inicio,periodo_fim,status,expira_em")
    .eq("status", "pendente").order("criado_em", { ascending: true }).limit(1);
  if (error) throw error;
  let count = 0;
  for (const row of data ?? []) {
    try {
      if (Date.parse(String(row.expira_em)) <= Date.now()) continue;
      if (await processExport(row as ExportJob)) count += 1;
    } catch (error) {
      const { error: persistError } = await client
        .from("exportacao_csv")
        .update({
          status: "erro",
          erro: error instanceof Error ? error.message : String(error),
        })
        .eq("id", row.id)
        .eq("status", "processando");
      if (persistError) {
        logger.error(
          { error: persistError, exportId: row.id },
          "Failed to persist BI export failure",
        );
      }
      logger.error({ error, exportId: row.id }, "BI export failed");
    }
  }
  return count;
}