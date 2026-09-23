import { Router, type IRouter, type Request, type Response } from "express";
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
  ScheduleCampaignBody,
  UpdateCampaignBody,
  UpdateCampaignResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import { getTechnicalError } from "../lib/technical-error";
import { normalizeEmailBlocks } from "@workspace/email-template";
import { sendTestEmail } from "../lib/worker";
import { getTestSendErrorResponse } from "../lib/test-send-error";
import { formatValidationError } from "../lib/validation";
import {
  campaignContentLockMessage,
  changedLockedCampaignFields,
} from "../lib/campaign-edit-lock";
import { recipientDeliveryProjection } from "../lib/recipient-delivery-projection";
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
  "id,nome,assunto,assunto_lembrete,remetente_nome,remetente_email,preheader,reply_to,valor_credito,validade_credito,url_deeplink,url_landing,teto_hora,teto_dia,status,agendada_para,lembrete_ativo,lembrete_horas,teste_enviado,teste_enviado_em,corpo,criado_em,pausa_motivo,pausa_taxa_bounce,pausa_taxa_reclamacao,pausada_em";
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

function logCampaignTestError(
  req: Request,
  campaignId: string,
  error: unknown,
): void {
  req.log.error(
    {
      requestId: req.id,
      campaignId,
      technicalError: getTechnicalError(error),
    },
    "Campaign test send failed",
  );
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
  if (!partial || "teto_hora" in input) payload.teto_hora = input.teto_hora ?? 100;
  if (!partial || "teto_dia" in input) payload.teto_dia = input.teto_dia ?? 1000;
  if (!partial || "agendada_para" in input) {
    payload.agendada_para = dateValue(input.agendada_para);
  }
  if (!partial || "lembrete_ativo" in input) {
    payload.lembrete_ativo = input.lembrete_ativo ?? false;
  }
  if (!partial || "lembrete_horas" in input) {
    payload.lembrete_horas = input.lembrete_horas ?? 48;
  }
  if (!partial) payload.teste_enviado = false;
  if (!partial || "corpo" in input) {
    payload.corpo = normalizeEmailBlocks(input.corpo);
  }
  return payload;
}

function rejectServerOwnedCampaignFields(req: Request, res: Response): boolean {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const forbidden = ["status", "teste_enviado"].filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (forbidden.length === 0) return false;
  res.status(422).json({
    error: `Não é permitido enviar ${forbidden.join(" e ")} neste endpoint. Use as ações específicas da campanha.`,
  });
  return true;
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
  const replyToEmail = configuredReplyToEmail();
  if (!String(result.reply_to ?? "").trim() && replyToEmail) {
    result.reply_to = replyToEmail;
  }
  if (!Object.prototype.hasOwnProperty.call(result, "teto_hora")) result.teto_hora = 100;
  if (!Object.prototype.hasOwnProperty.call(result, "teto_dia")) result.teto_dia = 1000;
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

async function countCampaignComplaints(campaignId: string): Promise<number> {
  const { count, error } = await supabaseAdminClient()
    .from("supressao")
    .select("email", { count: "exact", head: true })
    .eq("origem", `campanha:${campaignId}`)
    .eq("motivo", "complaint");
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
    ["erro", ["erro"]],
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
  const deliveryProjection = await recipientDeliveryProjection(
    supabaseAdminClient(),
    campaignId,
  );
  const [totalSent, bounces, complaints] = await Promise.all([
    countMainRecipients(campaignId, {
      statuses: ["enviado", "entregue", "aberto", "clicado", "bounce"],
    }),
    countMainRecipients(campaignId, { statuses: ["bounce"] }),
    countCampaignComplaints(campaignId),
  ]);
  const bounceRate = totalSent > 0 ? (bounces / totalSent) * 100 : 0;
  const complaintRate = totalSent > 0 ? (complaints / totalSent) * 100 : 0;

  return GetCampaignRecipientSummaryResponse.parse({
    campanha_id: campaignId,
    total: deliveryProjection.total_na_lista,
    total_na_lista: deliveryProjection.total_na_lista,
    suprimidos_no_envio: deliveryProjection.suprimidos_no_envio,
    permitidos_modo_teste: deliveryProjection.permitidos_modo_teste,
    bloqueados_modo_teste: deliveryProjection.bloqueados_modo_teste,
    receberao_de_fato: deliveryProjection.receberao_de_fato,
    status: {
      pendente: statusCounts[0],
      enviado: statusCounts[1],
      entregue: statusCounts[2],
      bloqueado: statusCounts[3],
      suprimido: statusCounts[4],
      erro: statusCounts[5],
    },
    reputacao: {
      total_enviado: totalSent,
      bounce: {
        quantidade: bounces,
        percentual: bounceRate,
        limite_percentual: 2,
      },
      reclamacao: {
        quantidade: complaints,
        percentual: complaintRate,
        limite_percentual: 0.2,
      },
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
    .select(
      "id,status,assunto,preheader,assunto_lembrete,remetente_nome,remetente_email,reply_to,url_deeplink,url_landing,valor_credito,validade_credito,agendada_para,lembrete_ativo,lembrete_horas,teste_enviado,corpo",
    )
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
  if (rejectServerOwnedCampaignFields(req, res)) return;
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

function validHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^(?:https?):\/\/[^\s]+$/iu.test(value.trim());
}

async function validateSchedule(
  campaign: Awaited<ReturnType<typeof findCampaign>>,
  confirmation: string | null | undefined,
): Promise<string | null> {
  if (!campaign) return "Campanha não encontrada.";
  if (campaign.status !== "rascunho") {
    return "Somente campanhas em rascunho podem ser agendadas.";
  }
  if (campaign.teste_enviado !== true) {
    return "Envie e confirme o teste antes de agendar a campanha.";
  }
  if (!campaign.agendada_para || Number.isNaN(Date.parse(campaign.agendada_para))) {
    return "Informe uma data e hora válidas para o agendamento.";
  }
  if (Date.parse(campaign.agendada_para) <= Date.now()) {
    return "O agendamento precisa estar no futuro.";
  }
  if (campaign.lembrete_ativo) {
    const reminderHours = Number(campaign.lembrete_horas);
    if (!Number.isInteger(reminderHours) || reminderHours < 24 || reminderHours > 168) {
      return "As horas até o lembrete devem estar entre 24 e 168.";
    }
    const reminderSubject = campaign.assunto_lembrete?.trim() ?? "";
    if (!reminderSubject) {
      return "Informe o assunto do lembrete quando o lembrete estiver ativo.";
    }
    if (reminderSubject.toLocaleLowerCase("pt-BR") === campaign.assunto.trim().toLocaleLowerCase("pt-BR")) {
      return "O assunto do lembrete precisa ser diferente do assunto principal.";
    }
  }
  const blocks = normalizeEmailBlocks(campaign.corpo);
  if (blocks.some((block) => block.type === "button")) {
    const missingDestinations = [
      !campaign.url_deeplink?.trim() ? "deep link" : null,
      !campaign.url_landing?.trim() ? "landing page" : null,
    ].filter((value): value is string => Boolean(value));
    if (missingDestinations.length > 0) {
      return `Preencha ${missingDestinations.join(" e ")} antes de agendar uma campanha com botão.`;
    }
  }
  if (blocks.some((block) => block.type === "button" && !validHttpUrl(block.href))) {
    return "Informe um destino http(s) válido para todos os botões.";
  }
  const delivery = await recipientDeliveryProjection(
    supabaseAdminClient(),
    campaign.id,
  );
  if (
    delivery.receberao_de_fato > 5000 &&
    (confirmation ?? "").trim() !== String(delivery.receberao_de_fato)
  ) {
    return `Digite ${delivery.receberao_de_fato} para confirmar o total que receberá o envio.`;
  }
  return null;
}

async function runSimpleCampaignTransition(
  req: Request,
  res: Response,
  config: {
    targetStatus: "pausada" | "enviando" | "cancelada";
    allowedStatuses: string[];
    requireTest?: boolean;
  },
): Promise<void> {
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
    const existing = await findCampaign(params.data.campaignId);
    if (!existing) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    if (!config.allowedStatuses.includes(existing.status)) {
      res.status(409).json({ error: "Essa transição não é permitida para o estado atual da campanha." });
      return;
    }
    if (config.requireTest && existing.teste_enviado !== true) {
      res.status(422).json({ error: "Envie e confirme o teste antes de retomar a campanha." });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update({ status: config.targetStatus })
      .eq("id", params.data.campaignId)
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) throw error;
    res.json(GetCampaignResponse.parse(await withSendMetrics(data)));
  } catch (error) {
    logSupabaseError(req, "Campaign transition failed", error);
    res.status(502).json({ error: "Não foi possível alterar o estado da campanha." });
  }
}

router.post("/campaigns/:campaignId/agendar", async (req, res) => {
  const params = GetCampaignParams.safeParse(req.params);
  const body = ScheduleCampaignBody.safeParse(req.body ?? {});
  if (!params.success) {
    res.status(422).json({ error: "Identificador de campanha inválido." });
    return;
  }
  if (!body.success) {
    res.status(422).json({ error: formatValidationError(body.error) });
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
    const validationError = await validateSchedule(
      campaign,
      body.data.confirmacao_destinatarios,
    );
    if (validationError) {
      res.status(validationError.includes("estado atual") ? 409 : 422).json({ error: validationError });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update({ status: "agendada" })
      .eq("id", params.data.campaignId)
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) throw error;
    res.json(GetCampaignResponse.parse(await withSendMetrics(data)));
  } catch (error) {
    logSupabaseError(req, "Campaign scheduling failed", error);
    res.status(502).json({ error: "Não foi possível agendar a campanha." });
  }
});

router.post("/campaigns/:campaignId/pausar", (req, res) =>
  runSimpleCampaignTransition(req, res, {
    targetStatus: "pausada",
    allowedStatuses: ["enviando"],
  }),
);

router.post("/campaigns/:campaignId/retomar", (req, res) =>
  runSimpleCampaignTransition(req, res, {
    targetStatus: "enviando",
    allowedStatuses: ["pausada"],
    requireTest: true,
  }),
);

router.post("/campaigns/:campaignId/cancelar", (req, res) =>
  runSimpleCampaignTransition(req, res, {
    targetStatus: "cancelada",
    allowedStatuses: ["agendada", "enviando", "pausada"],
  }),
);

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
    logCampaignTestError(req, params.data.campaignId, error);
    const failure = getTestSendErrorResponse(error);
    res.status(failure.status).json({
      error: failure.message,
      request_id: req.id,
    });
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
  if (rejectServerOwnedCampaignFields(req, res)) return;
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
    const existing = await findCampaign(params.data.campaignId);
    if (!existing) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const updatePayload = campaignPayload(parsed.data as Record<string, unknown>, true);
    const lockedFields = changedLockedCampaignFields(existing, updatePayload);
    if (lockedFields.length > 0) {
      res.status(409).json({ error: campaignContentLockMessage(lockedFields) });
      return;
    }
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update(updatePayload)
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