import { Router, type IRouter, type Request } from "express";
import {
  ConfirmCampaignImportBody,
  GetCampaignImportParams,
  GetCampaignImportResponse,
  LookupCampaignImportMappingBody,
  LookupCampaignImportMappingResponse,
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
  getPublicImportValidationErrorMessage,
  IMPORT_COLUMN_TARGETS,
  type ImportColumnTarget,
  ImportValidationError,
  campaignImportHeaderSignature,
  validateAndImportCsv,
} from "../lib/csv-import";
import { logger } from "../lib/logger";
import {
  getPublicTechnicalError,
  getTechnicalError,
  getTechnicalErrorText,
} from "../lib/technical-error";
import { recipientDeliveryProjection } from "../lib/recipient-delivery-projection";
import {
  referenceDateLabel,
  sameReferenceDateMeaning,
} from "../lib/reference-date-label";

const router: IRouter = Router();
const IMPORT_BUCKET = "amoconecta-imports";
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const IMPORT_JOB_COLUMNS =
  "id,campanha_id,caminho_arquivo,status,linhas_processadas,total_linhas,resultado,erro,criado_em,concluido_em";
const IMPORT_JOB_STATUSES = [
  "pendente",
  "processando",
  "aguardando_confirmacao",
  "concluida",
  "erro",
  "cancelada",
] as const;
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
  expectedHeaders,
  columnMapping,
  referenceDateType,
  referenceDateCustomLabel,
  confirmedInvalidDates,
}: {
  importId: string;
  campaignId: string;
  storagePath: string;
  deduplicatePhone: boolean;
  expectedHeaders: string[];
  columnMapping: ImportColumnTarget[];
  referenceDateType: string | null;
  referenceDateCustomLabel: string | null;
  confirmedInvalidDates: boolean;
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
    await updateJob({
      status: "processando" satisfies ImportJobStatus,
      linhas_processadas: 0,
      total_linhas: null,
    });
    const { data: campaign, error: campaignError } = await client
      .from("campanha")
      .select("data_referencia_tipo,data_referencia_rotulo")
      .eq("id", campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) throw new ImportValidationError("Campanha não encontrada.");
    if (
      referenceDateType &&
      campaign.data_referencia_tipo &&
      !sameReferenceDateMeaning(
        campaign.data_referencia_tipo,
        campaign.data_referencia_rotulo,
        referenceDateType,
        referenceDateCustomLabel,
      )
    ) {
      throw new ImportValidationError(
        "Esta campanha já usa outro tipo de data de referência. Crie outra campanha para importar uma data com significado diferente.",
      );
    }

    const currentMeaning = referenceDateType ?? campaign.data_referencia_tipo ?? null;
    const currentCustomLabel =
      referenceDateType === "outro"
        ? referenceDateCustomLabel
        : campaign.data_referencia_rotulo ?? null;
    const summaryLabel = referenceDateLabel(currentMeaning, currentCustomLabel);
    const runParser = async (previewOnly: boolean) => {
      const { data: file, error: downloadError } = await client.storage
        .from(IMPORT_BUCKET)
        .download(storagePath);
      if (downloadError) throw downloadError;
      if (!file) throw new Error("O Storage não retornou conteúdo para o arquivo.");
      return validateAndImportCsv({
        client,
        stream: file.stream(),
        campaignId,
        storagePath,
        deduplicatePhone,
        expectedHeaders,
        columnMapping,
        referenceDateLabel: summaryLabel,
        previewOnly,
        beforeCommit:
          !previewOnly && referenceDateType
            ? () =>
                saveCampaignReferenceMeaning({
                  client,
                  campaignId,
                  meaning: referenceDateType,
                  customLabel: referenceDateCustomLabel,
                })
            : undefined,
        onProgress: async (linesProcessed) => {
          await updateJob({ linhas_processadas: linesProcessed });
        },
      });
    };
    const preview = await runParser(true);
    if (preview.datas_invalidas > 0 && !confirmedInvalidDates) {
      await updateJob({
        status: "aguardando_confirmacao" satisfies ImportJobStatus,
        linhas_processadas: preview.total_linhas,
        total_linhas: preview.total_linhas,
        resultado: preview,
        erro: null,
        concluido_em: null,
      });
      return;
    }

    await updateJob({ linhas_processadas: 0, total_linhas: null });
    const summary = await runParser(false);
    let completedSummary = summary;
    try {
      const delivery = await recipientDeliveryProjection(client, campaignId);
      completedSummary = {
        ...summary,
        total_na_lista: delivery.total_na_lista,
        suprimidos_no_envio: delivery.suprimidos_no_envio,
        receberao_de_fato: delivery.receberao_de_fato,
      };
    } catch (error) {
      logger.error(
        {
          technicalError: getTechnicalError(error),
          importacaoId: importId,
          campaignId,
        },
        "Campaign import delivery projection failed",
      );
    }
    await updateJob({
      status: "concluida" satisfies ImportJobStatus,
      linhas_processadas: summary.total_linhas,
      total_linhas: summary.total_linhas,
      resultado: completedSummary,
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

async function saveCampaignReferenceMeaning({
  client,
  campaignId,
  meaning,
  customLabel,
}: {
  client: ReturnType<typeof supabaseAdminClient>;
  campaignId: string;
  meaning: string;
  customLabel: string | null;
}): Promise<void> {
  const { data: current, error: readError } = await client
    .from("campanha")
    .select("data_referencia_tipo,data_referencia_rotulo")
    .eq("id", campaignId)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) throw new ImportValidationError("Campanha não encontrada.");
  if (current.data_referencia_tipo) {
    if (
      !sameReferenceDateMeaning(
        current.data_referencia_tipo,
        current.data_referencia_rotulo,
        meaning,
        customLabel,
      )
    ) {
      throw new ImportValidationError(
        "Esta campanha já usa outro tipo de data de referência. Crie outra campanha para importar uma data com significado diferente.",
      );
    }
    return;
  }
  const { data: updated, error: updateError } = await client
    .from("campanha")
    .update({
      data_referencia_tipo: meaning,
      data_referencia_rotulo: meaning === "outro" ? customLabel : null,
    })
    .eq("id", campaignId)
    .is("data_referencia_tipo", null)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (updated) return;

  const { data: raced, error: raceReadError } = await client
    .from("campanha")
    .select("data_referencia_tipo,data_referencia_rotulo")
    .eq("id", campaignId)
    .maybeSingle();
  if (raceReadError) throw raceReadError;
  if (
    !raced ||
    !sameReferenceDateMeaning(
      raced.data_referencia_tipo,
      raced.data_referencia_rotulo,
      meaning,
      customLabel,
    )
  ) {
    throw new ImportValidationError(
      "Outra importação definiu um tipo diferente de data de referência para esta campanha.",
    );
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

router.post("/campaigns/:campaignId/imports/mapping-lookup", async (req, res) => {
  const body = LookupCampaignImportMappingBody.safeParse(req.body);
  const campaignId = req.params.campaignId;
  if (!body.success || !campaignId) {
    res.status(422).json({ error: "Informe os cabeçalhos do CSV." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    if (!(await findCampaign(campaignId))) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const signature = campaignImportHeaderSignature(body.data.cabecalhos);
    const { data, error } = await supabaseAdminClient()
      .from("importacao_mapeamento_cabecalho")
      .select("mapeamento")
      .eq("assinatura", signature)
      .maybeSingle();
    if (error) throw error;
    const mapping = Array.isArray(data?.mapeamento) &&
      data.mapeamento.every(
        (target) =>
          typeof target === "string" &&
          (IMPORT_COLUMN_TARGETS as readonly string[]).includes(target),
      )
      ? data.mapeamento as ImportColumnTarget[]
      : null;
    res.json(LookupCampaignImportMappingResponse.parse({ mapeamento: mapping }));
  } catch (error) {
    logSupabaseError(req, "Campaign import mapping lookup failed", error, {
      campaignId,
    });
    res.status(502).json({ error: "Não foi possível consultar o mapeamento salvo." });
  }
});

router.post("/campaigns/:campaignId/imports/validate", async (req, res) => {
  const body = ValidateCampaignImportBody.safeParse(req.body);
  const campaignId = req.params.campaignId;
  if (!body.success || !campaignId) {
    res.status(422).json({ error: "Informe o caminho do arquivo enviado." });
    return;
  }
  const storagePath = body.data.storage_path;
  const expectedPrefix = `${campaignId}/`;
  if (
    !storagePath.startsWith(expectedPrefix) ||
    !/^[^/]+\/[a-f0-9-]+-[a-z0-9._-]+\.csv$/iu.test(storagePath)
  ) {
    res.status(422).json({ error: "Caminho de importação inválido." });
    return;
  }
  const { cabecalhos, mapeamento, data_referencia_tipo, data_referencia_rotulo } =
    body.data;
  if (cabecalhos.length !== mapeamento.length) {
    res.status(422).json({ error: "O mapeamento não corresponde às colunas do CSV." });
    return;
  }
  if (!mapeamento.includes("email")) {
    res.status(422).json({ error: "Escolha qual coluna contém o e-mail." });
    return;
  }
  if (new Set(mapeamento.filter((target) => target !== "ignore")).size !==
      mapeamento.filter((target) => target !== "ignore").length) {
    res.status(422).json({ error: "Cada campo pode ser associado a apenas uma coluna." });
    return;
  }
  const hasReferenceDate = mapeamento.includes("reference_date");
  if (hasReferenceDate !== Boolean(data_referencia_tipo)) {
    res.status(422).json({
      error: hasReferenceDate
        ? "Escolha o significado da data de referência."
        : "O tipo de data só pode ser definido quando uma coluna de data estiver mapeada.",
    });
    return;
  }
  const customLabel = data_referencia_rotulo?.trim() || null;
  if (
    (data_referencia_tipo === "outro" && !customLabel) ||
    (data_referencia_tipo !== "outro" && customLabel)
  ) {
    res.status(422).json({
      error: data_referencia_tipo === "outro"
        ? "Informe o rótulo da outra data de referência."
        : "O rótulo personalizado só é válido para o tipo “Outro”.",
    });
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
    if (
      hasReferenceDate &&
      campaign.data_referencia_tipo &&
      !sameReferenceDateMeaning(
        campaign.data_referencia_tipo,
        campaign.data_referencia_rotulo,
        data_referencia_tipo,
        customLabel,
      )
    ) {
      res.status(409).json({
        error:
          "Esta campanha já usa outro tipo de data de referência. Crie outra campanha para importar uma data com significado diferente.",
      });
      return;
    }
    const client = supabaseAdminClient();
    const mappingSignature = campaignImportHeaderSignature(cabecalhos);
    const { error: mappingError } = await client
      .from("importacao_mapeamento_cabecalho")
      .upsert(
        {
          assinatura: mappingSignature,
          mapeamento,
          atualizado_em: new Date().toISOString(),
        },
        { onConflict: "assinatura" },
      );
    if (mappingError) throw mappingError;
    const { data: job, error } = await client
      .from("importacao")
      .insert({
        campanha_id: campaignId,
        caminho_arquivo: storagePath,
        status: "pendente",
        linhas_processadas: 0,
        cabecalhos,
        mapeamento,
        deduplicar_por_telefone: body.data.deduplicar_por_telefone,
        data_referencia_tipo,
        data_referencia_rotulo: customLabel,
        confirmar_datas_invalidas: false,
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
        entityId: campaignId,
        metadata: {
          import_id: response.id,
          deduplicate_phone: body.data.deduplicar_por_telefone,
          ignored_columns: mapeamento.filter((target) => target === "ignore").length,
          reference_date_type: data_referencia_tipo,
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
        campaignId,
        storagePath,
        deduplicatePhone: body.data.deduplicar_por_telefone,
        expectedHeaders: cabecalhos,
        columnMapping: mapeamento,
        referenceDateType: data_referencia_tipo,
        referenceDateCustomLabel: customLabel,
        confirmedInvalidDates: false,
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

router.post(
  "/campaigns/:campaignId/imports/:importId/confirm",
  async (req, res) => {
    const params = GetCampaignImportParams.safeParse(req.params);
    const body = ConfirmCampaignImportBody.safeParse(req.body);
    if (!params.success || !body.success || !body.data.continuar_com_datas_invalidas) {
      res.status(422).json({ error: "Confirme que deseja importar mesmo com datas inválidas." });
      return;
    }
    try {
      const session = await getSupabaseUser(req, res);
      if (!session) {
        res.status(401).json({ error: "Sessão expirada. Entre novamente." });
        return;
      }
      if (!(await findCampaign(params.data.campaignId))) {
        res.status(404).json({ error: "Campanha não encontrada." });
        return;
      }
      const client = supabaseAdminClient();
      const { data: settings, error: settingsError } = await client
        .from("importacao")
        .select(
          "id,status,caminho_arquivo,cabecalhos,mapeamento,deduplicar_por_telefone,data_referencia_tipo,data_referencia_rotulo",
        )
        .eq("id", params.data.importId)
        .eq("campanha_id", params.data.campaignId)
        .maybeSingle();
      if (settingsError) throw settingsError;
      if (!settings) {
        res.status(404).json({ error: "Importação não encontrada." });
        return;
      }
      if (settings.status !== "aguardando_confirmacao") {
        res.status(409).json({ error: "Esta importação não aguarda confirmação." });
        return;
      }
      const headers = Array.isArray(settings.cabecalhos) &&
        settings.cabecalhos.every((item) => typeof item === "string")
        ? settings.cabecalhos as string[]
        : [];
      const mapping = Array.isArray(settings.mapeamento) &&
        settings.mapeamento.every(
          (item) =>
            typeof item === "string" &&
            (IMPORT_COLUMN_TARGETS as readonly string[]).includes(item),
        )
        ? settings.mapeamento as ImportColumnTarget[]
        : [];
      if (headers.length === 0 || headers.length !== mapping.length) {
        res.status(409).json({ error: "O mapeamento salvo não pode ser retomado." });
        return;
      }
      const { data: job, error: updateError } = await client
        .from("importacao")
        .update({
          status: "pendente",
          confirmar_datas_invalidas: true,
          linhas_processadas: 0,
          total_linhas: null,
          resultado: null,
          erro: null,
          concluido_em: null,
        })
        .eq("id", params.data.importId)
        .eq("campanha_id", params.data.campaignId)
        .eq("status", "aguardando_confirmacao")
        .select(IMPORT_JOB_COLUMNS)
        .maybeSingle();
      if (updateError) throw updateError;
      if (!job) {
        res.status(409).json({ error: "Esta importação não aguarda confirmação." });
        return;
      }
      const response = ValidateCampaignImportResponse.parse(job);
      res.status(202).json(response);
      setImmediate(() => {
        void processImportJob({
          importId: response.id,
          campaignId: params.data.campaignId,
          storagePath: settings.caminho_arquivo,
          deduplicatePhone: settings.deduplicar_por_telefone === true,
          expectedHeaders: headers,
          columnMapping: mapping,
          referenceDateType:
            typeof settings.data_referencia_tipo === "string"
              ? settings.data_referencia_tipo
              : null,
          referenceDateCustomLabel:
            typeof settings.data_referencia_rotulo === "string"
              ? settings.data_referencia_rotulo
              : null,
          confirmedInvalidDates: true,
        });
      });
    } catch (error) {
      logSupabaseError(req, "Campaign import confirmation failed", error, {
        campaignId: params.data.campaignId,
        importId: params.data.importId,
      });
      res.status(502).json({ error: "Não foi possível retomar a importação." });
    }
  },
);

router.post(
  "/campaigns/:campaignId/imports/:importId/cancel",
  async (req, res) => {
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
      if (!(await findCampaign(params.data.campaignId))) {
        res.status(404).json({ error: "Campanha não encontrada." });
        return;
      }
      const client = supabaseAdminClient();
      const { data: job, error } = await client
        .from("importacao")
        .update({
          status: "cancelada",
          erro: null,
          concluido_em: new Date().toISOString(),
        })
        .eq("id", params.data.importId)
        .eq("campanha_id", params.data.campaignId)
        .eq("status", "aguardando_confirmacao")
        .select("caminho_arquivo")
        .maybeSingle();
      if (error) throw error;
      if (!job) {
        const { data: existing, error: readError } = await client
          .from("importacao")
          .select("id")
          .eq("id", params.data.importId)
          .eq("campanha_id", params.data.campaignId)
          .maybeSingle();
        if (readError) throw readError;
        if (!existing) {
          res.status(404).json({ error: "Importação não encontrada." });
        } else {
          res.status(409).json({ error: "Esta importação não aguarda confirmação." });
        }
        return;
      }
      const { data: responseJob, error: responseError } = await client
        .from("importacao")
        .select(IMPORT_JOB_COLUMNS)
        .eq("id", params.data.importId)
        .eq("campanha_id", params.data.campaignId)
        .single();
      if (responseError) throw responseError;
      const response = GetCampaignImportResponse.parse(responseJob);
      try {
        const { error: removeError } = await client.storage
          .from(IMPORT_BUCKET)
          .remove([job.caminho_arquivo]);
        if (removeError) throw removeError;
      } catch (removeError) {
        logger.warn(
          {
            technicalError: getTechnicalError(removeError),
            importacaoId: params.data.importId,
          },
          "Cancelled campaign import file could not be removed",
        );
      }
      res.json(response);
    } catch (error) {
      logSupabaseError(req, "Campaign import cancellation failed", error, {
        campaignId: params.data.campaignId,
        importId: params.data.importId,
      });
      res.status(502).json({ error: "Não foi possível cancelar a importação." });
    }
  },
);

router.get("/campaigns/:campaignId/imports/:importId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
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
    // Polling must only serialize the persisted job. Never recompute delivery
    // projection here: old 1,000-email URL filters can exceed upstream limits
    // (431 reproduced). This does not establish the cause of later live 502s.
    res.json(
      GetCampaignImportResponse.parse({
        ...data,
        resultado: data.resultado,
        erro:
          data.status === "erro"
            ? getPublicImportValidationErrorMessage(data.erro) ??
              "Não foi possível validar o arquivo."
            : null,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Import job lookup failed", error);
    res.status(502).json({ error: "Não foi possível consultar a validação." });
  }
});

export default router;