import { Router, type IRouter, type Request } from "express";
import {
  CreateCampaignBody,
  CreateCampaignResponse,
  ClearCampaignRecipientsResponse,
  GetCampaignRecipientSummaryResponse,
  GetCampaignParams,
  GetCampaignResponse,
  ListCampaignsResponse,
  RequestCampaignAssetUploadUrlBody,
  RequestCampaignAssetUploadUrlResponse,
  UpdateCampaignBody,
  UpdateCampaignResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import { getTechnicalError } from "../lib/technical-error";
import { normalizeEmailBlocks } from "@workspace/email-template";
import { getSafetyMode, getSafetyModeMessage } from "../lib/safety-mode";
import { sendTestEmail } from "../lib/worker";
import { formatValidationError } from "../lib/validation";
import {
  configuredSenderEmail,
  configuredReplyToEmail,
  configuredSenderName,
  isVerifiedSenderEmail,
  isValidReplyToEmail,
  senderDomainValidationMessage,
} from "../lib/sender-config";

const router: IRouter = Router();
const CAMPAIGN_COLUMNS =
  "id,nome,assunto,assunto_lembrete,remetente_nome,remetente_email,preheader,reply_to,valor_credito,validade_credito,url_deeplink,url_landing,teto_hora,teto_dia,status,agendada_para,lembrete_ativo,lembrete_horas,teste_enviado,corpo,criado_em,pausa_motivo,pausa_taxa_bounce,pausa_taxa_reclamacao,pausada_em";
// Public by design: this bucket contains only e-mail image assets.
// Never reuse the private CSV bucket from routes/imports.ts here.
const EMAIL_ASSET_BUCKET = "amoconecta-assets";
const MAX_EMAIL_IMAGE_BYTES = 5 * 1024 * 1024;
const EMAIL_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const RECENCY_BUCKETS = [
  "até 30 dias",
  "31 a 90 dias",
  "91 a 180 dias",
  "181 a 365 dias",
  "mais de 365 dias",
  "sem data",
] as const;

function logSupabaseError(
  req: Request,
  operation: string,
  error: unknown,
): void {
  req.log.error({ technicalError: getTechnicalError(error) }, operation);
}

function dateValue(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnlyValue(value: unknown): string | null {
  const result = dateValue(value);
  return result ? result.slice(0, 10) : null;
}

function campaignPayload(input: Record<string, unknown>, partial = false) {
  const payload: Record<string, unknown> = {};
  const stringFields = [
    "nome",
    "assunto",
    "preheader",
    "remetente_nome",
    "remetente_email",
    "reply_to",
  ];
  for (const field of stringFields) {
    if (!partial || field in input) {
      const value = String(input[field] ?? "").trim();
      payload[field] = field === "preheader" || field === "reply_to" ? value || null : value;
    }
  }

  if (!partial || "assunto_lembrete" in input) {
    payload.assunto_lembrete =
      typeof input.assunto_lembrete === "string" && input.assunto_lembrete.trim()
        ? input.assunto_lembrete.trim()
        : null;
  }
  if (!partial || "valor_credito" in input) {
    payload.valor_credito = input.valor_credito ?? null;
  }
  if (!partial || "validade_credito" in input) {
    payload.validade_credito = dateOnlyValue(input.validade_credito);
  }
  if (!partial || "url_deeplink" in input) {
    payload.url_deeplink = input.url_deeplink || null;
  }
  if (!partial || "url_landing" in input) {
    payload.url_landing = input.url_landing || null;
  }
  if (!partial || "teto_hora" in input) payload.teto_hora = input.teto_hora ?? null;
  if (!partial || "teto_dia" in input) payload.teto_dia = input.teto_dia ?? null;
  if (!partial || "status" in input) payload.status = input.status ?? "rascunho";
  if (!partial || "agendada_para" in input) {
    payload.agendada_para = dateValue(input.agendada_para);
  }
  if (!partial || "lembrete_ativo" in input) {
    payload.lembrete_ativo = input.lembrete_ativo ?? false;
  }
  if (!partial || "lembrete_horas" in input) {
    payload.lembrete_horas = input.lembrete_horas ?? 48;
  }
  if (!partial || "teste_enviado" in input) {
    payload.teste_enviado = input.teste_enviado ?? false;
  }
  if (!partial || "corpo" in input) {
    payload.corpo = normalizeEmailBlocks(input.corpo);
  }
  return payload;
}

function withDefaultSender(input: Record<string, unknown>): Record<string, unknown> {
  const senderEmail = configuredSenderEmail();
  const result = { ...input };
  if (senderEmail && !String(result.remetente_email ?? "").trim()) {
    result.remetente_email = senderEmail;
  }
  if (!String(result.remetente_nome ?? "").trim()) {
    result.remetente_nome = configuredSenderName();
  }
  if (!String(result.reply_to ?? "").trim()) {
    result.reply_to = configuredReplyToEmail();
  }
  if (result.teto_hora == null) result.teto_hora = 100;
  if (result.teto_dia == null) result.teto_dia = 1000;
  return result;
}

function senderValidationError(email: unknown): string | null {
  return typeof email === "string" && isVerifiedSenderEmail(email)
    ? null
    : senderDomainValidationMessage();
}

function replyToValidationError(email: unknown): string | null {
  return email == null || (typeof email === "string" && isValidReplyToEmail(email))
    ? null
    : "Campo inválido: Reply-To precisa ser um endereço de e-mail válido.";
}

async function withSendMetrics<T extends Record<string, unknown>>(campaign: T): Promise<T> {
  const client = supabaseAdminClient();
  const now = Date.now();
  const hourStart = new Date(now - 60 * 60 * 1000).toISOString();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.toISOString();
  const [hour, dayResult] = await Promise.all([
    client
      .from("destinatario")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaign.id)
      .gte("enviado_em", hourStart),
    client
      .from("destinatario")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaign.id)
      .gte("enviado_em", dayStart),
  ]);
  if (hour.error) throw hour.error;
  if (dayResult.error) throw dayResult.error;
  return {
    ...campaign,
    enviados_hora: hour.count ?? 0,
    enviados_dia: dayResult.count ?? 0,
  };
}

async function countMainRecipients(
  campaignId: string,
  query?: {
    gte?: string;
    lt?: string;
    lte?: string;
    isNull?: boolean;
    statuses?: readonly string[];
  },
): Promise<number> {
  let request = supabaseAdminClient()
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .eq("is_lembrete", false);

  if (query?.gte) request = request.gte("data_ultima_compra", query.gte);
  if (query?.lt) request = request.lt("data_ultima_compra", query.lt);
  if (query?.lte) request = request.lte("data_ultima_compra", query.lte);
  if (query?.isNull) request = request.is("data_ultima_compra", null);
  if (query?.statuses) request = request.in("status", query.statuses);

  const { count, error } = await request;
  if (error) throw error;
  return count ?? 0;
}

function dateOnlyDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function recipientSummary(campaignId: string) {
  const today = dateOnlyDaysAgo(0);
  const statusQueries = [
    ["pendente", ["pendente", "processando"]],
    ["enviado", ["enviado"]],
    ["entregue", ["entregue", "aberto", "clicado"]],
    ["bloqueado", ["bloqueado_modo_teste"]],
    ["suprimido", ["suprimido"]],
    ["erro", ["erro", "bounce"]],
  ] as const;
  const statusCounts = await Promise.all(
    statusQueries.map(async ([, statuses]) => countMainRecipients(campaignId, { statuses })),
  );
  const recencyQueries = [
    { gte: dateOnlyDaysAgo(30), lte: today },
    { gte: dateOnlyDaysAgo(90), lt: dateOnlyDaysAgo(30) },
    { gte: dateOnlyDaysAgo(180), lt: dateOnlyDaysAgo(90) },
    { gte: dateOnlyDaysAgo(365), lt: dateOnlyDaysAgo(180) },
    { lt: dateOnlyDaysAgo(365) },
    { isNull: true },
  ];
  const recencyCounts = await Promise.all(
    recencyQueries.map((query) => countMainRecipients(campaignId, query)),
  );
  const total = await countMainRecipients(campaignId);

  return GetCampaignRecipientSummaryResponse.parse({
    campanha_id: campaignId,
    total,
    status: {
      pendente: statusCounts[0],
      enviado: statusCounts[1],
      entregue: statusCounts[2],
      bloqueado: statusCounts[3],
      suprimido: statusCounts[4],
      erro: statusCounts[5],
    },
    recencia: RECENCY_BUCKETS.map((faixa, index) => ({
      faixa,
      quantidade: recencyCounts[index],
    })),
  });
}

function safeAssetFileName(fileName: string, mimeType: string): string {
  const base = fileName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9._-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/u, "")
    .toLocaleLowerCase("pt-BR");
  const extension = mimeType.split("/")[1] === "jpeg" ? "jpg" : mimeType.split("/")[1];
  const withoutExtension = base.replace(/\.[a-z0-9]+$/iu, "") || "imagem";
  return `${withoutExtension}.${extension}`;
}

async function ensurePublicAssetBucket() {
  const client = supabaseAdminClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw listError;
  const bucket = buckets?.find((item) => item.name === EMAIL_ASSET_BUCKET);
  if (!bucket) {
    const { error } = await client.storage.createBucket(EMAIL_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_EMAIL_IMAGE_BYTES}B`,
      allowedMimeTypes: [...EMAIL_IMAGE_TYPES],
    });
    if (error && !/already exists|duplicate/iu.test(error.message ?? "")) throw error;
  } else if (!bucket.public) {
    const { error } = await client.storage.updateBucket(EMAIL_ASSET_BUCKET, {
      public: true,
      fileSizeLimit: `${MAX_EMAIL_IMAGE_BYTES}B`,
      allowedMimeTypes: [...EMAIL_IMAGE_TYPES],
    });
    if (error) throw error;
  }
  return client;
}

function campaignParams(campaignId: string) {
  return GetCampaignParams.parse({ campaignId });
}

async function findCampaign(campaignId: string) {
  const { data, error } = await supabaseAdminClient()
    .from("campanha")
    .select("id")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

router.get("/campaigns", async (req, res) => {
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }

    const { data: campaigns, error } = await supabaseAdminClient()
      .from("campanha")
      .select("id,nome,status,agendada_para,criado_em")
      .order("criado_em", { ascending: false });

    if (error) {
      logSupabaseError(req, "Supabase campaign listing failed", error);
      res.status(502).json({ error: "Não foi possível carregar as campanhas." });
      return;
    }

    const campaignsWithRecipientCounts = await Promise.all(
      (campaigns ?? []).map(async (campaign) => ({
        ...campaign,
        enviados: 0,
        entregues: 0,
        abertos: 0,
        clicados: 0,
        destinatarios_total: await countMainRecipients(campaign.id),
      })),
    );
    res.json(ListCampaignsResponse.parse(campaignsWithRecipientCounts));
  } catch (error) {
    logSupabaseError(req, "Campaign listing failed", error);
    res.status(502).json({ error: "Não foi possível carregar as campanhas." });
  }
});

router.post("/campaigns", async (req, res) => {
  const parsed = CreateCampaignBody.safeParse(withDefaultSender(req.body ?? {}));
  if (!parsed.success) {
    res.status(422).json({ error: formatValidationError(parsed.error) });
    return;
  }
  const senderError = senderValidationError(parsed.data.remetente_email);
  if (senderError) {
    res.status(422).json({ error: senderError });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !getSafetyMode().envio_liberado
    ) {
      res.status(422).json({ error: getSafetyModeMessage() });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !parsed.data.teste_enviado
    ) {
      res.status(422).json({
        error: "Envie e confirme o teste antes de agendar ou iniciar a campanha.",
      });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .insert(campaignPayload(parsed.data as Record<string, unknown>))
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign creation failed", error);
      res.status(502).json({ error: "Não foi possível criar a campanha." });
      return;
    }
    res.status(201).json(CreateCampaignResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign creation failed", error);
    res.status(502).json({ error: "Não foi possível criar a campanha." });
  }
});

router.get("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .select(CAMPAIGN_COLUMNS)
      .eq("id", params.data.campaignId)
      .maybeSingle();
    if (error) {
      logSupabaseError(req, "Supabase campaign lookup failed", error);
      res.status(502).json({ error: "Não foi possível consultar a campanha." });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    res.json(GetCampaignResponse.parse(await withSendMetrics(data)));
  } catch (error) {
    logSupabaseError(req, "Campaign lookup failed", error);
    res.status(502).json({ error: "Não foi possível consultar a campanha." });
  }
});

router.get("/campaigns/:campaignId/recipients/summary", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
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
    res.json(await recipientSummary(params.data.campaignId));
  } catch (error) {
    logSupabaseError(req, "Campaign recipient summary failed", error);
    res.status(502).json({ error: "Não foi possível consultar os destinatários." });
  }
});

router.delete("/campaigns/:campaignId/recipients", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const { data: campaign, error: campaignError } = await supabaseAdminClient()
      .from("campanha")
      .select("id,status")
      .eq("id", params.data.campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    if (campaign.status === "agendada" || campaign.status === "enviando") {
      res.status(409).json({
        error: "Não é possível limpar os destinatários enquanto a campanha está agendada ou enviando.",
      });
      return;
    }
    const { count, error } = await supabaseAdminClient()
      .from("destinatario")
      .delete({ count: "exact" })
      .eq("campanha_id", params.data.campaignId);
    if (error) throw error;
    res.json(
      ClearCampaignRecipientsResponse.parse({
        campanha_id: params.data.campaignId,
        destinatarios_removidos: count ?? 0,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Campaign recipient clearing failed", error);
    res.status(502).json({ error: "Não foi possível limpar os destinatários." });
  }
});

router.post("/campaigns/:campaignId/test", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session?.user.email) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const resendEmailId = await sendTestEmail(
      params.data.campaignId,
      session.user.email,
    );
    res.json({ sent: true, resend_email_id: resendEmailId });
  } catch (error) {
    logSupabaseError(req, "Campaign test send failed", error);
    const message =
      error instanceof Error &&
      /modo de segurança|suprimido|não encontrada|remetente da campanha|APP_BASE_URL|UNSUBSCRIBE_SECRET|RESEND_API_KEY|Resend não retornou/iu.test(
        error.message,
      )
        ? error.message
        : "Não foi possível enviar o teste.";
    res.status(422).json({ error: message });
  }
});

router.post("/campaigns/:campaignId/assets/upload-url", async (req, res) => {
  const body = RequestCampaignAssetUploadUrlBody.safeParse(req.body);
  if (!body.success || !req.params.campaignId) {
    res.status(422).json({
      error: body.success
        ? "Campo obrigatório: identificador da campanha."
        : formatValidationError(body.error),
    });
    return;
  }
  if (body.data.tamanho > MAX_EMAIL_IMAGE_BYTES) {
    res.status(422).json({ error: "A imagem deve ter até 5 MB." });
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
    const client = await ensurePublicAssetBucket();
    const path = `${req.params.campaignId}/${crypto.randomUUID()}-${safeAssetFileName(body.data.nome_arquivo, body.data.mime_type)}`;
    const { data, error } = await client.storage
      .from(EMAIL_ASSET_BUCKET)
      .createSignedUploadUrl(path);
    if (error) {
      logSupabaseError(req, "Supabase email asset signed upload URL creation failed", error);
      res.status(502).json({ error: "Não foi possível preparar o upload da imagem." });
      return;
    }
    const publicUrl = client.storage.from(EMAIL_ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
    res.json(
      RequestCampaignAssetUploadUrlResponse.parse({
        bucket: EMAIL_ASSET_BUCKET,
        path,
        signed_url: data.signedUrl,
        public_url: publicUrl,
        expires_in: 7200,
      }),
    );
  } catch (error) {
    logSupabaseError(req, "Campaign email asset upload URL request failed", error);
    res.status(502).json({ error: "Não foi possível preparar o upload da imagem." });
  }
});

router.patch("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  const parsed = UpdateCampaignBody.partial().safeParse(req.body);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  if (!parsed.success || Object.keys(req.body ?? {}).length === 0) {
    res.status(422).json({
      error:
        Object.keys(req.body ?? {}).length === 0
          ? "Nenhum dado válido foi enviado."
          : formatValidationError(parsed.error),
    });
    return;
  }
  if (parsed.success && "remetente_email" in parsed.data) {
    const senderError = senderValidationError(parsed.data.remetente_email);
    if (senderError) {
      res.status(422).json({ error: senderError });
      return;
    }
  }
  if (parsed.success && "reply_to" in parsed.data) {
    const replyToError = replyToValidationError(parsed.data.reply_to);
    if (replyToError) {
      res.status(422).json({ error: replyToError });
      return;
    }
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      !getSafetyMode().envio_liberado
    ) {
      res.status(422).json({ error: getSafetyModeMessage() });
      return;
    }
    if (
      (parsed.data.status === "agendada" || parsed.data.status === "enviando") &&
      parsed.data.teste_enviado !== true
    ) {
      res.status(422).json({
        error: "Envie e confirme o teste antes de agendar ou iniciar a campanha.",
      });
      return;
    }
    const existing = await findCampaign(params.data.campaignId);
    if (!existing) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update(campaignPayload(parsed.data as Record<string, unknown>, true))
      .eq("id", params.data.campaignId)
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign update failed", error);
      res.status(502).json({ error: "Não foi possível atualizar a campanha." });
      return;
    }
    res.json(UpdateCampaignResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign update failed", error);
    res.status(502).json({ error: "Não foi possível atualizar a campanha." });
  }
});

router.delete("/campaigns/:campaignId", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .delete()
      .eq("id", params.data.campaignId)
      .select("id")
      .maybeSingle();
    if (error) {
      logSupabaseError(req, "Supabase campaign deletion failed", error);
      res.status(502).json({ error: "Não foi possível excluir a campanha." });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    res.status(204).send();
  } catch (error) {
    logSupabaseError(req, "Campaign deletion failed", error);
    res.status(502).json({ error: "Não foi possível excluir a campanha." });
  }
});

export { campaignParams, findCampaign };
export default router;