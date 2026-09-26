import { Router, type IRouter, type Request } from "express";
import {
  GetCampaignImportParams,
  GetCampaignImportResponse,
  RequestCampaignImportUploadUrlBody,
  RequestCampaignImportUploadUrlResponse,
  ValidateCampaignImportBody,
  ValidateCampaignImportResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { findCampaign } from "./campaigns";
import { supabaseAdminClient } from "../lib/supabase";
import { recordAuditEvent, teamAuditActor } from "../lib/audit-events";
import {
  ImportValidationError,
  validateAndImportCsv,
} from "../lib/csv-import";
import { logger } from "../lib/logger";
import {
  getPublicTechnicalError,
  getTechnicalError,
  getTechnicalErrorText,
} from "../lib/technical-error";
import { recipientDeliveryProjection } from "../lib/recipient-delivery-projection";

const router: IRouter = Router();
const IMPORT_BUCKET = "amoconecta-imports";
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const IMPORT_JOB_COLUMNS =
  "id,campanha_id,caminho_arquivo,status,linhas_processadas,total_linhas,resultado,erro,criado_em,concluido_em";
const IMPORT_JOB_STATUSES = ["pendente", "processando", "concluida", "erro"] as const;
type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

function logSupabaseError(
  req: Request,
  operation: string,
  error: unknown,
  context: Record<string, unknown> = {},
) {
  req.log.error({ ...context, technicalError: getTechnicalError(error) }, operation);
}

function safeFileName(fileName: string): string {
  const base = fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/u, "");
  return base.toLocaleLowerCase("pt-BR").endsWith(".csv") ? base : `${base}.csv`;
}

async function ensurePrivateBucket() {
  const client = supabaseAdminClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw listError;
  const bucket = buckets?.find((item) => item.name === IMPORT_BUCKET);
  if (!bucket) {
    const { error } = await client.storage.createBucket(IMPORT_BUCKET, {
      public: false,
      fileSizeLimit: `${MAX_IMPORT_BYTES}B`,
      allowedMimeTypes: ["text/csv", "application/csv", "text/plain"],
    });
    if (error && !/already exists|duplicate/iu.test(error.message ?? "")) throw error;
  } else if (bucket.public) {
    // Customer CSVs must never be exposed, even if a bucket was configured
    // incorrectly outside this application.
    logger.warn(
      {
        event: "public_import_bucket_detected",
        bucket: IMPORT_BUCKET,
        detectedAt: new Date().toISOString(),
      },
      "Import bucket was public; forcing it back to private",
    );
    const { error } = await client.storage.updateBucket(IMPORT_BUCKET, {
      public: false,
      fileSizeLimit: `${MAX_IMPORT_BYTES}B`,
      allowedMimeTypes: ["text/csv", "application/csv", "text/plain"],
    });
    if (error) throw error;
  }
  return client;
}

async function processImportJob({
  importId,
  campaignId,
  storagePath,
  deduplicatePhone,
}: {
  importId: string;
  campaignId: string;
  storagePath: string;
  deduplicatePhone: boolean;
}) {
  const client = supabaseAdminClient();
  const updateJob = async (payload: Record<string, unknown>) => {
    const { error } = await client
      .from("importacao")
      .update(payload)
      .eq("id", importId)
      .eq("campanha_id", campaignId);
    if (error) throw error;
  };

  try {
    await updateJob({ status: "processando" satisfies ImportJobStatus });
    const { data: file, error: downloadError } = await client.storage
      .from(IMPORT_BUCKET)
      .download(storagePath);
    if (downloadError) throw downloadError;
    if (!file) throw new Error("O Storage não retornou conteúdo para o arquivo.");
    const summary = await validateAndImportCsv({
      client,
      stream: file.stream(),
      campaignId,
      storagePath,
      deduplicatePhone,
      onProgress: async (linesProcessed) => {
        await updateJob({ linhas_processadas: linesProcessed });
      },
    });
    await updateJob({
      status: "concluida" satisfies ImportJobStatus,
      linhas_processadas: summary.total_linhas,
      total_linhas: summary.total_linhas,
      resultado: summary,
      erro: null,
      concluido_em: new Date().toISOString(),
    });
  } catch (error) {
    logger.error(
      {
        technicalError: getTechnicalError(error),
        importacaoId: importId,
        storageBucket: IMPORT_BUCKET,
        storagePath,
      },
      "Campaign import background job failed",
    );
    try {
      await updateJob({
        status: "erro" satisfies ImportJobStatus,
        erro: getTechnicalErrorText(error),
        concluido_em: new Date().toISOString(),
      });
    } catch (updateError) {
      logger.error(
        {
          technicalError: getTechnicalError(updateError),
          importacaoId: importId,
          storageBucket: IMPORT_BUCKET,
          storagePath,
        },
        "Campaign import job failure status update failed",
      );
    }
  }
}

router.post("/campaigns/:campaignId/imports/upload-url", async (req, res) => {
  const body = RequestCampaignImportUploadUrlBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({ error: "Informe um arquivo CSV válido." });
    return;
  }
  if (
    body.data.tamanho > MAX_IMPORT_BYTES ||
    !body.data.nome_arquivo.toLocaleLowerCase("pt-BR").endsWith(".csv")
  ) {
    res.status(422).json({ error: "O arquivo deve ser CSV e ter até 50 MB." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const client = await ensurePrivateBucket();
    const path = `${req.params.campaignId}/${crypto.randomUUID()}-${safeFileName(body.data.nome_arquivo)}`;
    const { data, error } = await client.storage
      .from(IMPORT_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      logSupabaseError(
        req,
        "Supabase signed upload URL creation failed",
        error,
        {
          campaignId: req.params.campaignId,
          fileName: body.data.nome_arquivo,
          fileSize: body.data.tamanho,
        },
      );
      res.status(502).json({
        error: "Não foi possível preparar o upload do CSV.",
        request_id: String(req.id),
        technical_error: getPublicTechnicalError(error),
      });
      return;
    }
    res.json(
      RequestCampaignImportUploadUrlResponse.parse({
        bucket: IMPORT_BUCKET,
        path,
        signed_url: data.signedUrl,
        expires_in: 7200,
      }),
    );
  } catch (error) {
    logSupabaseError(
      req,
      "Import upload URL request failed",
      error,
      {
        campaignId: req.params.campaignId,
        fileName: body.data.nome_arquivo,
        fileSize: body.data.tamanho,
      },
    );
    res.status(502).json({
      error: "Não foi possível preparar o upload do CSV.",
      request_id: String(req.id),
      technical_error: getPublicTechnicalError(error),
    });
  }
});

router.post("/campaigns/:campaignId/imports/validate", async (req, res) => {
  const body = ValidateCampaignImportBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({ error: "Informe o caminho do arquivo enviado." });
    return;
  }
  const storagePath = body.data.storage_path;
  const expectedPrefix = `${req.params.campaignId}/`;
  if (
    !storagePath.startsWith(expectedPrefix) ||
    !/^[^/]+\/[a-f0-9-]+-[a-z0-9._-]+\.csv$/iu.test(storagePath)
  ) {
    res.status(422).json({ error: "Caminho de importação inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const campaign = await findCampaign(req.params.campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const client = supabaseAdminClient();
    const { data: job, error } = await client
      .from("importacao")
      .insert({
        campanha_id: req.params.campaignId,
        caminho_arquivo: storagePath,
        status: "pendente",
        linhas_processadas: 0,
      })
      .select(IMPORT_JOB_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase import job creation failed", error);
      res.status(502).json({ error: "Não foi possível iniciar a validação." });
      return;
    }
    const response = ValidateCampaignImportResponse.parse(job);
    try {
      await recordAuditEvent({
        actor: teamAuditActor(session.user),
        action: "campaign_import_started",
        entityType: "campaign",
        entityId: req.params.campaignId,
        metadata: {
          import_id: response.id,
          deduplicate_phone: body.data.deduplicar_por_telefone,
        },
      });
    } catch (auditError) {
      req.log.error(
        { technicalError: getTechnicalError(auditError) },
        "Campaign import audit event could not be persisted",
      );
    }
    res.status(202).json(response);
    setImmediate(() => {
      void processImportJob({
        importId: response.id,
        campaignId: req.params.campaignId,
        storagePath,
        deduplicatePhone: body.data.deduplicar_por_telefone,
      });
    });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      res.status(422).json({ error: error.message });
      return;
    }
    logSupabaseError(req, "Campaign import validation failed", error);
    res.status(502).json({ error: "Não foi possível validar o arquivo." });
  }
});

router.get("/campaigns/:campaignId/imports/:importId", async (req, res) => {
  const params = GetCampaignImportParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de importação inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const campaign = await findCampaign(params.data.campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("importacao")
      .select(IMPORT_JOB_COLUMNS)
      .eq("id", params.data.importId)
      .eq("campanha_id", params.data.campaignId)
      .maybeSingle();
    if (error) {
      logSupabaseError(req, "Supabase import job lookup failed", error);
      res.status(502).json({ error: "Não foi possível consultar a validação." });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Importação não encontrada." });
      return;
    }
    const currentProjection = data.resultado
      ? await recipientDeliveryProjection(supabaseAdminClient(), params.data.campaignId)
      : null;
    res.json(
      GetCampaignImportResponse.parse({
        ...data,
        resultado: data.resultado
          ? { ...data.resultado, ...currentProjection }
          : null,
        erro:
          data.status === "erro"
            ? "Não foi possível validar o arquivo."
            : null,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Import job lookup failed", error);
    res.status(502).json({ error: "Não foi possível consultar a validação." });
  }
});

export default router;