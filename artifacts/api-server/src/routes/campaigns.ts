import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateCampaignBody,
  CreateCampaignDraftBody,
  CreateCampaignDraftResponse,
  CreateCampaignResponse,
  ClearCampaignRecipientsResponse,
  GetCampaignRecipientSummaryResponse,
  GetCampaignParams,
  GetCampaignAuditParams,
  GetCampaignAuditResponse,
  GetCampaignResponse,
  ListCampaignsResponse,
  RequestCampaignAssetUploadUrlBody,
  RequestCampaignAssetUploadUrlResponse,
  ScheduleCampaignBody,
  ResumeCampaignBody,
  UpdateCampaignBody,
  UpdateCampaignResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import { buildCampaignEmailMetrics } from "../lib/campaign-email-metrics";
import {
  recordAuditEvent,
  teamAuditActor,
} from "../lib/audit-events";
import {
  getPublicTechnicalError,
  getTechnicalError,
} from "../lib/technical-error";
import {
  normalizeEmailBlocks,
  validateEmailBlockUrls,
  validateEmailButtonDestinations,
} from "@workspace/email-template";
import { sendTestEmail } from "../lib/worker";
import {
  countChronicDisengagedContacts,
  getEmailBrandingSettings,
} from "../lib/email-branding";
import { getTestSendErrorResponse } from "../lib/test-send-error";
import { formatValidationError } from "../lib/validation";
import {
  campaignContentLockMessage,
  changedLockedCampaignFields,
} from "../lib/campaign-edit-lock";
import {
  campaignTestRequiredScheduleMessage,
  isCampaignTestRequired,
  noEligibleRecipientsScheduleMessage,
} from "../lib/campaign-schedule-policy";
import { recipientDeliveryProjection } from "../lib/recipient-delivery-projection";
import { loadReputationCounts, reputationPeriod } from "../lib/campaign-reputation";
import {
  applyConfiguredReplyTo,
  configuredSenderEmail,
  configuredSenderName,
  isVerifiedSenderEmail,
  isValidReplyToEmail,
  senderDomainValidationMessage,
  warnIfReplyToDefaultMissing,
} from "../lib/sender-config";

const router: IRouter = Router();
const CAMPAIGN_COLUMNS =
  "id,nome,assunto,assunto_lembrete,corpo_lembrete,cor_botao_snapshot,incluir_desengajados,remetente_nome,remetente_email,preheader,reply_to,valor_credito,validade_credito,teto_hora,teto_dia,status,agendada_para,lembrete_horas,teste_enviado,teste_enviado_em,corpo,criado_em,pausa_motivo,pausa_taxa_bounce,pausa_taxa_reclamacao,pausada_em,criado_por_id,criado_por_nome,criado_por_email,agendado_por_id,agendado_por_nome,agendado_por_email,agendado_em,pausado_por_id,pausado_por_nome,pausado_por_email,retomada_em,retomada_enviados_base,retomado_por_nome,retomado_por_email";
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
  context: Record<string, unknown> = {},
): void {
  req.log.error({ ...context, technicalError: getTechnicalError(error) }, operation);
}

async function recordCampaignAudit(
  req: Request,
  session: { user: { id: string; email: string | null; name: string } },
  action: string,
  campaignId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await recordAuditEvent({
      actor: teamAuditActor(session.user),
      action,
      entityType: "campaign",
      entityId: campaignId,
      metadata,
    });
  } catch (error) {
    logSupabaseError(req, "Campaign audit event could not be persisted", error, {
      campaignId,
      action,
    });
  }
}

function campaignCreatorFields(session: {
  user: { id: string; email: string | null; name: string };
}) {
  return {
    criado_por_id: session.user.id,
    criado_por_nome: session.user.name,
    criado_por_email: session.user.email,
  };
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

function emailBlocksHaveContent(value: unknown): boolean {
  return normalizeEmailBlocks(value).some((block) => {
    if (block.type === "image") return block.src !== "#";
    if (block.type === "button") return Boolean(block.label.trim() && block.href.trim());
    if (block.type === "text") {
      return block.html
        .replace(/<[^>]*>/gu, "")
        .replace(/&nbsp;/giu, " ")
        .trim().length > 0;
    }
    return false;
  });
}

function emailBlockUrlError(value: unknown): string | null {
  const issues = validateEmailBlockUrls(value);
  if (issues.length === 0) return null;
  return issues
    .map((issue) =>
      issue.suggestion
        ? `${issue.message} Se quiser, confirme esta sugestão: ${issue.suggestion}.`
        : issue.message,
    )
    .join(" ");
}

function reminderContentError(campaign: {
  assunto?: unknown;
  assunto_lembrete?: unknown;
  corpo_lembrete?: unknown;
  lembrete_horas?: unknown;
}): string | null {
  const subject =
    typeof campaign.assunto_lembrete === "string"
      ? campaign.assunto_lembrete.trim()
      : "";
  const hasBody = emailBlocksHaveContent(campaign.corpo_lembrete);
  if (!subject && !hasBody) return null;
  if (!subject || !hasBody) {
    return "Um lembrete precisa ter assunto e corpo próprios. Sem os dois, ele não será enviado.";
  }
  const primarySubject =
    typeof campaign.assunto === "string" ? campaign.assunto.trim() : "";
  if (
    subject.toLocaleLowerCase("pt-BR") ===
    primarySubject.toLocaleLowerCase("pt-BR")
  ) {
    return "O assunto do lembrete precisa ser diferente do assunto principal.";
  }
  const hours = Number(campaign.lembrete_horas);
  if (!Number.isInteger(hours) || hours < 24 || hours > 168) {
    return "As horas até o lembrete devem estar entre 24 e 168.";
  }
  return null;
}

function campaignPayload(
  input: Record<string, unknown>,
  partial = false,
  buttonColorSnapshot?: string,
) {
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
  if (!partial || "teto_hora" in input) payload.teto_hora = input.teto_hora ?? 100;
  if (!partial || "teto_dia" in input) payload.teto_dia = input.teto_dia ?? 1000;
  if (!partial || "agendada_para" in input) {
    payload.agendada_para = dateValue(input.agendada_para);
  }
  if (!partial || "lembrete_horas" in input) {
    payload.lembrete_horas = input.lembrete_horas ?? 48;
  }
  if (!partial || "corpo_lembrete" in input) {
    const reminderBlocks = normalizeEmailBlocks(input.corpo_lembrete);
    payload.corpo_lembrete = emailBlocksHaveContent(reminderBlocks)
      ? reminderBlocks
      : null;
  }
  if (!partial || "incluir_desengajados" in input) {
    payload.incluir_desengajados = input.incluir_desengajados === true;
  }
  if (!partial && buttonColorSnapshot) {
    payload.cor_botao_snapshot = buttonColorSnapshot;
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
  if (!Object.prototype.hasOwnProperty.call(result, "teto_hora")) result.teto_hora = 100;
  if (!Object.prototype.hasOwnProperty.call(result, "teto_dia")) result.teto_dia = 1000;
  return applyConfiguredReplyTo(result);
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
    isNotNull?: string;
    statuses?: readonly string[];
  },
  isReminder = false,
): Promise<number> {
  let request = supabaseAdminClient()
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .eq("is_lembrete", isReminder);

  if (query?.gte) request = request.gte("data_ultima_compra", query.gte);
  if (query?.lt) request = request.lt("data_ultima_compra", query.lt);
  if (query?.lte) request = request.lte("data_ultima_compra", query.lte);
  if (query?.isNull) request = request.is("data_ultima_compra", null);
  if (query?.isNotNull) request = request.not(query.isNotNull, "is", null);
  if (query?.statuses) request = request.in("status", query.statuses).is("excluido_em", null);

  const { count, error } = await request;
  if (error) throw error;
  return count ?? 0;
}

type CampaignEmailRollup = {
  destinatarios: number;
  enviados: number;
  entregues: number;
  aberturas: number;
  cliques: number;
  bounces: number;
  bouncesPermanentes: number;
  bouncesTemporarios: number;
  bouncesIndeterminados: number;
  reclamacoes: number;
  descadastros: number;
};

type BounceClassification = "permanente" | "temporario" | "indeterminado";

type CampaignEmailContact = {
  recipient?: {
    status: string;
    enviado_em: string | null;
    entregue_em: string | null;
    aberto_em: string | null;
    clicado_em: string | null;
    descadastrado_em: string | null;
  };
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  bounceClassification: BounceClassification | null;
  complained: boolean;
};

function emptyEmailRollup(): CampaignEmailRollup {
  return {
    destinatarios: 0,
    enviados: 0,
    entregues: 0,
    aberturas: 0,
    cliques: 0,
    bounces: 0,
    bouncesPermanentes: 0,
    bouncesTemporarios: 0,
    bouncesIndeterminados: 0,
    reclamacoes: 0,
    descadastros: 0,
  };
}

function classifyBounceType(value: unknown): BounceClassification {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (type === "permanent" || type === "hard") return "permanente";
  if (["transient", "temporary", "soft", "delayed"].includes(type)) {
    return "temporario";
  }
  return "indeterminado";
}

async function loadCampaignEmailRollups(
  campaignIds: string[],
  isReminder = false,
): Promise<Map<string, CampaignEmailRollup>> {
  const output = new Map<string, CampaignEmailRollup>();
  for (const id of campaignIds) output.set(id, emptyEmailRollup());
  if (campaignIds.length === 0) return output;

  const contacts = new Map<string, Map<string, CampaignEmailContact>>();
  const getContact = (campaignId: string, email: unknown) => {
    if (typeof email !== "string" || !email.trim()) return null;
    const normalizedEmail = email.trim().toLowerCase();
    let campaignContacts = contacts.get(campaignId);
    if (!campaignContacts) {
      campaignContacts = new Map();
      contacts.set(campaignId, campaignContacts);
    }
    let contact = campaignContacts.get(normalizedEmail);
    if (!contact) {
      contact = {
        sent: false,
        delivered: false,
        opened: false,
        clicked: false,
        bounced: false,
        bounceClassification: null,
        complained: false,
      };
      campaignContacts.set(normalizedEmail, contact);
    }
    return contact;
  };

  const client = supabaseAdminClient();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await client
      .from("destinatario")
      .select(
        "campanha_id,email,status,enviado_em,entregue_em,aberto_em,clicado_em,descadastrado_em",
      )
      .in("campanha_id", campaignIds)
      .eq("is_lembrete", isReminder)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const rollup = output.get(row.campanha_id);
      const contact = getContact(row.campanha_id, row.email);
      if (!rollup || !contact) continue;
      rollup.destinatarios += 1;
      contact.recipient = {
        status: row.status,
        enviado_em: row.enviado_em,
        entregue_em: row.entregue_em,
        aberto_em: row.aberto_em,
        clicado_em: row.clicado_em,
        descadastrado_em: row.descadastrado_em,
      };
      contact.sent ||= Boolean(row.enviado_em) ||
        ["enviado", "entregue", "aberto", "clicado", "bounce"].includes(row.status);
      contact.delivered ||= Boolean(row.entregue_em) ||
        ["entregue", "aberto", "clicado"].includes(row.status);
      contact.opened ||= Boolean(row.aberto_em);
      contact.clicked ||= Boolean(row.clicado_em);
      contact.bounced ||= row.status === "bounce";
    }
    if ((data?.length ?? 0) < pageSize) break;
    offset += pageSize;
  }

  offset = 0;
  while (true) {
    const { data, error } = await client
      .from("evento_email")
      .select("campanha_id,email,tipo,bounce_permanente,bounce_tipo_bruto")
      .in("campanha_id", campaignIds)
      .not("email", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const contact = getContact(row.campanha_id, row.email);
      if (!contact) continue;
      switch (row.tipo) {
        case "email.sent":
          contact.sent = true;
          break;
        case "email.delivered":
          contact.delivered = true;
          break;
        case "email.opened":
          contact.delivered = true;
          contact.opened = true;
          break;
        case "email.clicked":
          contact.delivered = true;
          contact.clicked = true;
          break;
        case "email.bounced":
          contact.bounced = true;
          {
            const classification =
              row.bounce_permanente === true
                ? "permanente"
                : classifyBounceType(row.bounce_tipo_bruto);
            if (
              contact.bounceClassification === null ||
              classification === "permanente" ||
              (classification === "temporario" &&
                contact.bounceClassification === "indeterminado")
            ) {
              contact.bounceClassification = classification;
            }
          }
          break;
        case "email.complained":
          contact.delivered = true;
          contact.complained = true;
          break;
      }
    }
    if ((data?.length ?? 0) < pageSize) break;
    offset += pageSize;
  }

  for (const [campaignId, campaignContacts] of contacts) {
    const rollup = output.get(campaignId);
    if (!rollup) continue;
    for (const contact of campaignContacts.values()) {
      if (contact.sent) rollup.enviados += 1;
      if (contact.delivered) rollup.entregues += 1;
      if (contact.opened) rollup.aberturas += 1;
      if (contact.clicked) rollup.cliques += 1;
      if (contact.bounced) {
        rollup.bounces += 1;
        if (contact.bounceClassification === "permanente") {
          rollup.bouncesPermanentes += 1;
        } else if (contact.bounceClassification === "temporario") {
          rollup.bouncesTemporarios += 1;
        } else {
          rollup.bouncesIndeterminados += 1;
        }
      }
      if (contact.complained) rollup.reclamacoes += 1;
      if (contact.recipient?.descadastrado_em) rollup.descadastros += 1;
    }
  }
  return output;
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
    ["bounce", ["bounce"]],
    ["bloqueado", ["bloqueado_modo_teste", "bloqueado_desengajado"]],
    ["suprimido", ["suprimido"]],
    ["erro", ["erro"]],
  ] as const;
  const statusCounts = await Promise.all(
    statusQueries.map(async ([, statuses]) => countMainRecipients(campaignId, { statuses })),
  );
  const { count: excludedCount, error: excludedError } = await supabaseAdminClient()
    .from("destinatario").select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId).eq("is_lembrete", false).not("excluido_em", "is", null);
  if (excludedError) throw excludedError;
  const reminderStatusCounts = await Promise.all(
    statusQueries.map(async ([, statuses]) =>
      countMainRecipients(campaignId, { statuses }, true),
    ),
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
  const [
    deliveryProjection,
    emailRollups,
    reminderRollups,
    disengagedCount,
  ] = await Promise.all([
    recipientDeliveryProjection(supabaseAdminClient(), campaignId),
    loadCampaignEmailRollups([campaignId]),
    loadCampaignEmailRollups([campaignId], true),
    countChronicDisengagedContacts(),
  ]);
  const email = emailRollups.get(campaignId) ?? emptyEmailRollup();
  const reminderEmail = reminderRollups.get(campaignId) ?? emptyEmailRollup();
  const totalSent = email.enviados;
  const totalDelivered = email.entregues;
  const bounceRate =
    totalSent > 0 ? (email.bouncesPermanentes / totalSent) * 100 : 0;
  const complaintRate =
    totalDelivered > 0 ? (email.reclamacoes / totalDelivered) * 100 : 0;

  return GetCampaignRecipientSummaryResponse.parse({
    campanha_id: campaignId,
    total: deliveryProjection.total_na_lista,
    total_na_lista: deliveryProjection.total_na_lista,
    excluidos: excludedCount ?? 0,
    suprimidos_no_envio: deliveryProjection.suprimidos_no_envio,
    permitidos_modo_teste: deliveryProjection.permitidos_modo_teste,
    bloqueados_modo_teste: deliveryProjection.bloqueados_modo_teste,
    receberao_de_fato: deliveryProjection.receberao_de_fato,
    status: {
      pendente: statusCounts[0],
      enviado: statusCounts[1],
      entregue: statusCounts[2],
      bounce: statusCounts[3],
      bloqueado: statusCounts[4],
      suprimido: statusCounts[5],
      erro: statusCounts[6],
    },
    status_lembrete: {
      pendente: reminderStatusCounts[0],
      enviado: reminderStatusCounts[1],
      entregue: reminderStatusCounts[2],
      bounce: reminderStatusCounts[3],
      bloqueado: reminderStatusCounts[4],
      suprimido: reminderStatusCounts[5],
      erro: reminderStatusCounts[6],
    },
    metricas_email_lembrete: {
      ...buildCampaignEmailMetrics(reminderEmail),
    },
    desengajados_total: disengagedCount,
    desengajados_na_lista: deliveryProjection.desengajados_na_lista,
    bloqueados_desengajados: deliveryProjection.bloqueados_desengajados,
    reputacao: {
      total_enviado: totalSent,
      total_entregue: totalDelivered,
      bounce: {
        quantidade: email.bouncesPermanentes,
        percentual: bounceRate,
        limite_percentual: 2,
      },
      reclamacao: {
        quantidade: email.reclamacoes,
        percentual: complaintRate,
        limite_percentual: 0.2,
      },
    },
    metricas_email: {
      ...buildCampaignEmailMetrics(email, deliveryProjection.total_na_lista),
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
      "id,status,assunto,preheader,assunto_lembrete,corpo_lembrete,cor_botao_snapshot,incluir_desengajados,remetente_nome,remetente_email,reply_to,valor_credito,validade_credito,agendada_para,lembrete_horas,teste_enviado,corpo,pausa_motivo,pausa_taxa_bounce,pausa_taxa_reclamacao,retomada_em",
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
      .select(
        "id,nome,status,agendada_para,criado_em,criado_por_nome,criado_por_email",
      )
      .order("criado_em", { ascending: false });

    if (error) {
      logSupabaseError(req, "Supabase campaign listing failed", error);
      res.status(502).json({ error: "Não foi possível carregar as campanhas." });
      return;
    }

    const rollups = await loadCampaignEmailRollups(
      (campaigns ?? []).map((campaign) => campaign.id),
    );
    const campaignsWithRecipientCounts = (campaigns ?? []).map((campaign) => {
      const metrics = rollups.get(campaign.id) ?? emptyEmailRollup();
      return {
        ...campaign,
        enviados: metrics.enviados,
        entregues: metrics.entregues,
        abertos: metrics.aberturas,
        clicados: metrics.cliques,
        destinatarios_total: metrics.destinatarios,
      };
    });
    res.json(ListCampaignsResponse.parse(campaignsWithRecipientCounts));
  } catch (error) {
    logSupabaseError(req, "Campaign listing failed", error);
    res.status(502).json({ error: "Não foi possível carregar as campanhas." });
  }
});

router.post("/campaigns/drafts", async (req, res): Promise<void> => {
  const parsed = CreateCampaignDraftBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(422).json({ error: formatValidationError(parsed.error) });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }

    const draftInput = withDefaultSender({
      nome: "Nova campanha",
      assunto: "",
      remetente_nome: configuredSenderName() || "AmoConecta",
      corpo: [],
    });
    const senderError = senderValidationError(draftInput.remetente_email);
    if (senderError) {
      res.status(422).json({ error: senderError });
      return;
    }

    const buttonColorSnapshot =
      (await getEmailBrandingSettings()).cor_botao_email;
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .insert({
        ...campaignPayload(draftInput, false, buttonColorSnapshot),
        ...campaignCreatorFields(session),
      })
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign draft initialization failed", error);
      res.status(502).json({
        error: "Não foi possível iniciar o rascunho.",
        request_id: String(req.id),
        technical_error: getPublicTechnicalError(error),
      });
      return;
    }
    warnIfReplyToDefaultMissing(data.reply_to, "draft", (bindings, message) => {
      req.log.warn(bindings, message);
    });
    await recordCampaignAudit(req, session, "campaign_created", data.id, {
      status: data.status,
      draft: true,
    });
    res.status(201).json(CreateCampaignDraftResponse.parse(data));
  } catch (error) {
    logSupabaseError(req, "Campaign draft initialization failed", error);
    res.status(502).json({
      error: "Não foi possível iniciar o rascunho.",
      request_id: String(req.id),
      technical_error: getPublicTechnicalError(error),
    });
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
  const contentUrlError =
    emailBlockUrlError(parsed.data.corpo) ??
    emailBlockUrlError(parsed.data.corpo_lembrete);
  if (contentUrlError) {
    res.status(422).json({ error: contentUrlError });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }
    const buttonColorSnapshot =
      (await getEmailBrandingSettings()).cor_botao_email;
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .insert(
        {
          ...campaignPayload(
            parsed.data as Record<string, unknown>,
            false,
            buttonColorSnapshot,
          ),
          ...campaignCreatorFields(session),
        },
      )
      .select(CAMPAIGN_COLUMNS)
      .single();
    if (error) {
      logSupabaseError(req, "Supabase campaign creation failed", error);
      res.status(502).json({ error: "Não foi possível criar a campanha." });
      return;
    }
    warnIfReplyToDefaultMissing(
      data.reply_to,
      "campaign",
      (bindings, message) => {
        req.log.warn(bindings, message);
      },
    );
    await recordCampaignAudit(req, session, "campaign_created", data.id, {
      status: data.status,
      draft: false,
    });
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

router.get("/campaigns/:campaignId/audit", async (req, res) => {
  const params = GetCampaignAuditParams.safeParse(req.params);
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
    const { data, error } = await supabaseAdminClient()
      .from("evento_auditoria")
      .select("id,action,actor_name,actor_email,created_at,metadata")
      .eq("entity_type", "campaign")
      .eq("entity_id", params.data.campaignId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json(GetCampaignAuditResponse.parse({ events: data ?? [] }));
  } catch (error) {
    logSupabaseError(req, "Campaign audit history could not be loaded", error, {
      campaignId: params.data.campaignId,
    });
    res.status(503).json({ error: "Não foi possível carregar o histórico da campanha." });
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

async function campaignHasSentMessages(campaignId: string): Promise<boolean> {
  const client = supabaseAdminClient();
  const sentStatuses = ["enviado", "entregue", "aberto", "clicado", "bounce"];
  const sentEventTypes = [
    "email.sent",
    "email.delivered",
    "email.opened",
    "email.clicked",
    "email.bounced",
    "email.complained",
  ];
  const [byTimestamp, byStatus, byEvent] = await Promise.all([
    client
      .from("destinatario")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaignId)
      .not("enviado_em", "is", null),
    client
      .from("destinatario")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaignId)
      .in("status", sentStatuses),
    client
      .from("evento_email")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaignId)
      .in("tipo", sentEventTypes),
  ]);
  if (byTimestamp.error) throw byTimestamp.error;
  if (byStatus.error) throw byStatus.error;
  if (byEvent.error) throw byEvent.error;
  return (byTimestamp.count ?? 0) > 0 ||
    (byStatus.count ?? 0) > 0 ||
    (byEvent.count ?? 0) > 0;
}

async function countInFlightCampaignRecipients(
  campaignId: string,
): Promise<number> {
  const { count, error } = await supabaseAdminClient()
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .eq("status", "processando");
  if (error) throw error;
  return count ?? 0;
}

async function validateSchedule(
  campaign: Awaited<ReturnType<typeof findCampaign>>,
  confirmation: string | null | undefined,
): Promise<string | null> {
  if (!campaign) return "Campanha não encontrada.";
  if (campaign.status !== "rascunho") {
    return "Somente campanhas em rascunho podem ser agendadas.";
  }
  if (!campaign.agendada_para || Number.isNaN(Date.parse(campaign.agendada_para))) {
    return "Informe uma data e hora válidas para o agendamento.";
  }
  if (Date.parse(campaign.agendada_para) <= Date.now()) {
    return "O agendamento precisa estar no futuro.";
  }
  const reminderError = reminderContentError(campaign);
  if (reminderError) return reminderError;
  const mainUrlError = emailBlockUrlError(campaign.corpo);
  const reminderUrlError = emailBlockUrlError(campaign.corpo_lembrete);
  if (mainUrlError || reminderUrlError) return mainUrlError ?? reminderUrlError;
  const buttonDestinationErrors = [
    ...validateEmailButtonDestinations(campaign.corpo),
    ...validateEmailButtonDestinations(campaign.corpo_lembrete),
  ];
  if (buttonDestinationErrors.length > 0) {
    return buttonDestinationErrors.map((issue) => issue.message).join(" ");
  }
  const blocks = normalizeEmailBlocks(campaign.corpo);
  const delivery = await recipientDeliveryProjection(
    supabaseAdminClient(),
    campaign.id,
    campaign.incluir_desengajados === true,
  );
  if (delivery.total_na_lista === 0) {
    return noEligibleRecipientsScheduleMessage(delivery);
  }
  const testRequired =
    isCampaignTestRequired(delivery.total_na_lista) &&
    campaign.teste_enviado !== true;
  const noEligibleRecipients =
    delivery.receberao_de_fato === 0
      ? noEligibleRecipientsScheduleMessage(delivery)
      : null;
  if (noEligibleRecipients && testRequired) {
    return `${noEligibleRecipients} ${campaignTestRequiredScheduleMessage(delivery.total_na_lista)}`;
  }
  if (noEligibleRecipients) return noEligibleRecipients;
  if (testRequired) return campaignTestRequiredScheduleMessage(delivery.total_na_lista);
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
    confirmReputationPause?: boolean;
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
      const message =
        config.targetStatus === "pausada"
          ? "Só é possível pausar uma campanha enquanto ela está enviando."
          : config.targetStatus === "enviando"
            ? "Só é possível retomar uma campanha pausada."
            : "Só é possível cancelar uma campanha agendada, enviando ou pausada.";
      res.status(409).json({ error: message });
      return;
    }
    if (config.requireTest && existing.teste_enviado !== true) {
      res.status(422).json({ error: "Envie e confirme o teste antes de retomar a campanha." });
      return;
    }
    if (
      config.targetStatus === "enviando" &&
      existing.pausa_motivo?.startsWith("Pausa automática:") &&
      config.confirmReputationPause !== true
    ) {
      res.status(409).json({
        error: `Confirme explicitamente a retomada da pausa por reputação. ${existing.pausa_motivo}`,
      });
      return;
    }
    if (config.targetStatus === "pausada" || config.targetStatus === "enviando") {
      const client = supabaseAdminClient();
      const [cumulative, period] = await Promise.all([
        loadReputationCounts(client, params.data.campaignId),
        loadReputationCounts(client, params.data.campaignId, existing.retomada_em),
      ]);
      const rates = reputationPeriod(period);
      const { data, error } = await client.rpc("transition_campaign_with_audit", {
        p_campanha_id: params.data.campaignId, p_expected: existing.status, p_target: config.targetStatus,
        p_actor_id: session.user.id, p_actor_nome: session.user.name, p_actor_email: session.user.email,
        p_motivo: config.targetStatus === "pausada"
          ? `Pausa manual por ${session.user.email ?? session.user.id}.` : existing.pausa_motivo,
        p_bounce: config.targetStatus === "pausada" ? rates.taxa_bounce : existing.pausa_taxa_bounce,
        p_reclamacao: config.targetStatus === "pausada" ? rates.taxa_reclamacao : existing.pausa_taxa_reclamacao,
        p_metadata: { periodo_atual: rates, acumulada: reputationPeriod(cumulative) },
      });
      if (error) throw error;
      if (!data) {
        res.status(409).json({ error: "O estado mudou. Atualize a campanha antes de tentar novamente." }); return;
      }
      res.json(GetCampaignResponse.parse(await withSendMetrics(data)));
      return;
    }
    const update = { status: config.targetStatus };
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update(update)
      .eq("id", params.data.campaignId)
      .eq("status", existing.status)
      .select(CAMPAIGN_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({
        error: "O estado da campanha mudou antes da operação. Atualize a página e tente novamente.",
      });
      return;
    }
    await recordCampaignAudit(req, session, "campaign_cancelled", params.data.campaignId, {
      from_status: existing.status,
      to_status: config.targetStatus,
    });
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
    if (campaign.status !== "rascunho") {
      res.status(409).json({
        error:
          campaign.status === "cancelada"
            ? "Esta campanha está cancelada. Reabra-a como rascunho antes de agendar."
            : "Somente campanhas em rascunho podem ser agendadas.",
      });
      return;
    }
    const validationError = await validateSchedule(
      campaign,
      body.data.confirmacao_destinatarios,
    );
    if (validationError) {
      res.status(422).json({ error: validationError });
      return;
    }
    const scheduledAt = new Date().toISOString();
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update({
        status: "agendada",
        agendado_por_id: session.user.id,
        agendado_por_nome: session.user.name,
        agendado_por_email: session.user.email,
        agendado_em: scheduledAt,
      })
      .eq("id", params.data.campaignId)
      .eq("status", "rascunho")
      .select(CAMPAIGN_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({
        error: "O estado da campanha mudou antes do agendamento. Atualize a página e tente novamente.",
      });
      return;
    }
    await recordCampaignAudit(
      req,
      session,
      "campaign_scheduled",
      params.data.campaignId,
      {
        scheduled_at: scheduledAt,
        scheduled_for: data.agendada_para,
      },
    );
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

router.post("/campaigns/:campaignId/retomar", (req, res) => {
  const body = ResumeCampaignBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(422).json({ error: formatValidationError(body.error) });
    return;
  }
  return runSimpleCampaignTransition(req, res, {
    targetStatus: "enviando",
    allowedStatuses: ["pausada"],
    requireTest: true,
    confirmReputationPause: body.data.confirmar_reputacao,
  });
});

router.post("/campaigns/:campaignId/cancelar", async (req, res): Promise<void> => {
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
    const allowedStatuses = ["agendada", "enviando", "pausada", "cancelada"];
    if (!allowedStatuses.includes(existing.status)) {
      res.status(409).json({
        error: "Só é possível cancelar ou reabrir uma campanha agendada, enviando, pausada ou cancelada.",
      });
      return;
    }

    let current = existing;
    let hasSentMessages = await campaignHasSentMessages(existing.id);
    if (existing.status === "cancelada" && hasSentMessages) {
      res.status(409).json({
        error: "Esta campanha já teve envios e está cancelada em estado terminal. Crie uma nova campanha para enviar novamente.",
      });
      return;
    }

    let pausedForSafeCancellation = false;
    if (current.status === "enviando" && !hasSentMessages) {
      const pausedAt = new Date().toISOString();
      const { data, error } = await supabaseAdminClient()
        .from("campanha")
        .update({
          status: "pausada",
          pausa_motivo: "Pausa temporária para interromper novos lotes antes de cancelar uma campanha sem envios.",
          pausada_em: pausedAt,
          pausa_taxa_bounce: null,
          pausa_taxa_reclamacao: null,
          pausado_por_id: session.user.id,
          pausado_por_nome: session.user.name,
          pausado_por_email: session.user.email,
        })
        .eq("id", existing.id)
        .eq("status", "enviando")
        .select(CAMPAIGN_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        current = data;
        pausedForSafeCancellation = true;
      } else {
        const refreshed = await findCampaign(existing.id);
        if (!refreshed || !allowedStatuses.includes(refreshed.status)) {
          res.status(409).json({
            error: "O estado da campanha mudou durante o cancelamento. Atualize a página e tente novamente.",
          });
          return;
        }
        current = refreshed;
      }
    }

    const inFlightCount = await countInFlightCampaignRecipients(existing.id);
    hasSentMessages = await campaignHasSentMessages(existing.id);
    if (!hasSentMessages && inFlightCount > 0) {
      if (pausedForSafeCancellation && current.status === "pausada") {
        await recordCampaignAudit(req, session, "campaign_paused", existing.id, {
          from_status: "enviando",
          to_status: "pausada",
          reason: "Pausa temporária enquanto o lote em andamento é concluído antes do cancelamento.",
        });
      }
      res.status(409).json({
        error: "A campanha foi mantida pausada para evitar novos lotes. Ainda há destinatários em processamento; aguarde a conclusão do lote e clique em cancelar novamente.",
      });
      return;
    }

    if (current.status === "cancelada" && hasSentMessages) {
      res.status(409).json({
        error: "Esta campanha já teve envios e está cancelada em estado terminal. Crie uma nova campanha para enviar novamente.",
      });
      return;
    }

    const targetStatus = hasSentMessages ? "cancelada" : "rascunho";
    const update =
      targetStatus === "rascunho"
        ? {
            status: targetStatus,
            agendada_para: null,
            agendado_por_id: null,
            agendado_por_nome: null,
            agendado_por_email: null,
            agendado_em: null,
            pausa_motivo: null,
            pausa_taxa_bounce: null,
            pausa_taxa_reclamacao: null,
            pausada_em: null,
            pausado_por_id: null,
            pausado_por_nome: null,
            pausado_por_email: null,
          }
        : { status: targetStatus };
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .update(update)
      .eq("id", existing.id)
      .eq("status", current.status)
      .select(CAMPAIGN_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(409).json({
        error: "O estado da campanha mudou durante o cancelamento. Atualize a página e tente novamente.",
      });
      return;
    }

    const action =
      existing.status === "cancelada" && targetStatus === "rascunho"
        ? "campaign_reopened"
        : "campaign_cancelled";
    await recordCampaignAudit(req, session, action, existing.id, {
      from_status: existing.status,
      to_status: targetStatus,
      sent_messages: hasSentMessages,
      in_flight_recipients: inFlightCount,
      paused_before_cancellation: pausedForSafeCancellation,
    });
    res.json(GetCampaignResponse.parse(await withSendMetrics(data)));
  } catch (error) {
    logSupabaseError(req, "Campaign cancellation failed", error);
    res.status(502).json({ error: "Não foi possível cancelar ou reabrir a campanha." });
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
    await recordCampaignAudit(
      req,
      session,
      "campaign_test_sent",
      params.data.campaignId,
      { resend_email_id: resendEmailId },
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
      logSupabaseError(
        req,
        "Supabase email asset signed upload URL creation failed",
        error,
        {
          campaignId: req.params.campaignId,
          fileName: body.data.nome_arquivo,
          contentType: body.data.mime_type,
          fileSize: body.data.tamanho,
        },
      );
      res.status(502).json({
        error: "Não foi possível preparar o upload da imagem.",
        request_id: String(req.id),
        technical_error: getPublicTechnicalError(error),
      });
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
    logSupabaseError(
      req,
      "Campaign email asset upload URL request failed",
      error,
      {
        campaignId: req.params.campaignId,
        fileName: body.data.nome_arquivo,
        contentType: body.data.mime_type,
        fileSize: body.data.tamanho,
      },
    );
    res.status(502).json({
      error: "Não foi possível preparar o upload da imagem.",
      request_id: String(req.id),
      technical_error: getPublicTechnicalError(error),
    });
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
  const contentUrlError =
    ("corpo" in parsed.data ? emailBlockUrlError(parsed.data.corpo) : null) ??
    ("corpo_lembrete" in parsed.data
      ? emailBlockUrlError(parsed.data.corpo_lembrete)
      : null);
  if (contentUrlError) {
    res.status(422).json({ error: contentUrlError });
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
    await recordCampaignAudit(
      req,
      session,
      "campaign_updated",
      params.data.campaignId,
      { updated_fields: Object.keys(updatePayload) },
    );
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
    await recordCampaignAudit(
      req,
      session,
      "campaign_deleted",
      params.data.campaignId,
    );
    res.status(204).send();
  } catch (error) {
    logSupabaseError(req, "Campaign deletion failed", error);
    res.status(502).json({ error: "Não foi possível excluir a campanha." });
  }
});

export { campaignParams, findCampaign };
export default router;