import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  normalizeEmailBlocks,
  renderEmailHtml,
  renderEmailText,
  interpolateEmailText,
  validateEmailBlockUrls,
  validateEmailButtonDestinations,
  type EmailBlock,
} from "@workspace/email-template";
import { supabaseAdminClient } from "./supabase";
import { isRecipientAllowed } from "./safety-mode";
import {
  idempotencyKey,
  sendResendMessages,
  testIdempotencyKey,
  type PreparedResendMessage,
  type ResendResult,
} from "./resend-sender";
import { processBiExportJobs } from "./worker-export";
import {
  configuredSenderEmail,
  configuredReplyToEmail,
  configuredSenderName,
  DEFAULT_SENDER_NAME,
  isValidReplyToEmail,
  isVerifiedSenderEmail,
} from "./sender-config";
import { logger } from "./logger";
import { getTechnicalError } from "./technical-error";
import { recordAuditEvent, systemAuditActor } from "./audit-events";

const RESEND_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const WORKER_RPC = "reservar_destinatarios";
const RECOVERY_RPC = "recuperar_destinatarios_travados";
const RECOVERY_BATCH_SIZE = 1000;
const WORKER_LOCK_ACQUIRE_RPC = "tentar_adquirir_lock_worker";
const WORKER_LOCK_RELEASE_RPC = "liberar_lock_worker";
const missingReplyToWarnings = new Set<string>();
// Fixed database-wide lock key. It must remain stable across worker processes.
const WORKER_LOCK_KEY = 4_782_913_421;
const WORKER_LOCK_TOKEN = randomUUID();

type Campaign = {
  id: string;
  nome: string;
  assunto: string;
  remetente_nome: string;
  remetente_email: string;
  preheader?: string | null;
  valor_credito?: number | null;
  validade_credito?: string | null;
  reply_to?: string | null;
  corpo: unknown;
  cor_botao_snapshot?: string | null;
  assunto_lembrete?: string | null;
  corpo_lembrete?: unknown;
  incluir_desengajados?: boolean | null;
  status: string;
  agendada_para?: string | null;
  teto_hora?: number | null;
  teto_dia?: number | null;
  pausa_motivo?: string | null;
  pausa_taxa_bounce?: number | null;
  pausa_taxa_reclamacao?: number | null;
};

export type WorkerRecipient = {
  id: string;
  campanha_id: string;
  email: string;
  nome?: string | null;
  status: string;
  tentativas: number;
  resend_email_id?: string | null;
};

export class WorkerConfigurationError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new WorkerConfigurationError(`${name} não está configurada.`);
  return value;
}

function appBaseUrl(): string {
  const value = requiredEnv("APP_BASE_URL").replace(/\/+$/u, "");
  if (!/^https?:\/\/[^\s]+$/iu.test(value)) {
    throw new WorkerConfigurationError("APP_BASE_URL precisa ser uma URL HTTP(S).");
  }
  return value;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function createUnsubscribeToken(email: string): string {
  const normalizedEmail = normalize(email);
  const encodedEmail = base64Url(Buffer.from(normalizedEmail, "utf8"));
  const signature = base64Url(
    createHmac("sha256", requiredEnv("UNSUBSCRIBE_SECRET"))
      .update(normalizedEmail)
      .digest(),
  );
  return `${encodedEmail}.${signature}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  const [encodedEmail, encodedSignature] = token.split(".");
  if (!encodedEmail || !encodedSignature) return null;
  try {
    const email = normalize(Buffer.from(encodedEmail, "base64url").toString("utf8"));
    if (!email || !email.includes("@")) return null;
    const expected = createHmac("sha256", requiredEnv("UNSUBSCRIBE_SECRET"))
      .update(email)
      .digest();
    const received = Buffer.from(encodedSignature, "base64url");
    return received.length === expected.length && timingSafeEqual(received, expected)
      ? email
      : null;
  } catch {
    return null;
  }
}

export { batchIdempotencyKey, idempotencyKey } from "./resend-sender";

export function unsubscribeUrl(email: string, campaignId: string): string {
  const query = new URLSearchParams({
    t: createUnsubscribeToken(email),
    c: campaignId,
  });
  return `${appBaseUrl()}/api/unsubscribe?${query.toString()}`;
}

async function reserveRecipients(
  campaignId: string,
  limit = RESEND_BATCH_SIZE,
  isReminder = false,
): Promise<WorkerRecipient[]> {
  const { data, error } = await supabaseAdminClient().rpc(WORKER_RPC, {
    p_campanha_id: campaignId,
    p_limite: limit,
    p_is_lembrete: isReminder,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new WorkerConfigurationError(
        `A RPC ${WORKER_RPC} não existe. Aplique o SQL manual em supabase/functions/worker-reservation.sql.`,
      );
    }
    throw error;
  }
  return (data ?? []) as WorkerRecipient[];
}

async function recoverStuckRecipients(limit = RECOVERY_BATCH_SIZE): Promise<WorkerRecipient[]> {
  const { data, error } = await supabaseAdminClient().rpc(RECOVERY_RPC, {
    p_limite: limit,
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new WorkerConfigurationError(
        `A RPC ${RECOVERY_RPC} não existe. Aplique o SQL manual em supabase/functions/worker-reservation.sql.`,
      );
    }
    throw error;
  }
  return (data ?? []) as WorkerRecipient[];
}

function isMissingWorkerLockRpc(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

async function acquireWorkerLock(): Promise<boolean> {
  const { data, error } = await supabaseAdminClient().rpc(
    WORKER_LOCK_ACQUIRE_RPC,
    { p_chave: WORKER_LOCK_KEY, p_token: WORKER_LOCK_TOKEN },
  );
  if (error) {
    if (isMissingWorkerLockRpc(error)) {
      throw new WorkerConfigurationError(
        `A RPC ${WORKER_LOCK_ACQUIRE_RPC} não existe. Aplique a migração SQL do lock global do worker.`,
      );
    }
    throw error;
  }
  return data === true;
}

async function releaseWorkerLock(): Promise<void> {
  const { data, error } = await supabaseAdminClient().rpc(
    WORKER_LOCK_RELEASE_RPC,
    { p_chave: WORKER_LOCK_KEY, p_token: WORKER_LOCK_TOKEN },
  );
  if (error) {
    if (isMissingWorkerLockRpc(error)) {
      throw new WorkerConfigurationError(
        `A RPC ${WORKER_LOCK_RELEASE_RPC} não existe. Aplique a migração SQL do lock global do worker.`,
      );
    }
    throw error;
  }
  if (data !== true) {
    logger.warn(
      { lockKey: WORKER_LOCK_KEY },
       "AmoConecta worker lock was not owned by this worker",
    );
  }
}

async function loadCampaign(campaignId: string): Promise<Campaign | null> {
  const { data, error } = await supabaseAdminClient()
    .from("campanha")
    .select(
      "id,nome,assunto,assunto_lembrete,corpo_lembrete,cor_botao_snapshot,incluir_desengajados,remetente_nome,remetente_email,preheader,valor_credito,validade_credito,reply_to,corpo,status,agendada_para,teto_hora,teto_dia",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data as Campaign | null;
}

async function loadSuppressedEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalizedEmails = [...new Set(emails.map(normalize))];
  const { data, error } = await supabaseAdminClient()
    .from("supressao")
    .select("email")
    .in("email", normalizedEmails);
  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((row) => (typeof row.email === "string" ? normalize(row.email) : null))
      .filter((email): email is string => Boolean(email)),
  );
}

async function loadChronicEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const normalizedEmails = [...new Set(emails.map(normalize))];
  const { data, error } = await supabaseAdminClient()
    .from("contato_desengajamento")
    .select("email")
    .eq("desengajado_cronico", true)
    .in("email", normalizedEmails);
  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((row) => (typeof row.email === "string" ? normalize(row.email) : null))
      .filter((email): email is string => Boolean(email)),
  );
}

async function updateRecipient(
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("destinatario")
    .update(payload)
    .eq("id", id);
  if (error) throw error;
}

async function updateCampaignStatus(
  campaignId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("campanha")
    .update({ status, ...extra })
    .eq("id", campaignId);
  if (error) throw error;
}

function sender(campaign: Campaign): string {
  const email = normalize(campaign.remetente_email || configuredSenderEmail() || requiredEnv("SENDER_EMAIL"));
  if (!isVerifiedSenderEmail(email)) {
    throw new WorkerConfigurationError(
      "O remetente da campanha precisa pertencer a marketing.amo.delivery.",
    );
  }
  return `${campaign.remetente_nome || process.env.SENDER_NAME || DEFAULT_SENDER_NAME} <${email}>`;
}

function replyTo(campaign: Campaign): string | undefined {
  const configured = campaign.reply_to?.trim() || configuredReplyToEmail();
  if (!configured) {
    if (!missingReplyToWarnings.has(campaign.id)) {
      missingReplyToWarnings.add(campaign.id);
      logger.warn(
        { campaignId: campaign.id },
        "Reply-To ausente; as respostas usarão o endereço From da campanha",
      );
    }
    return undefined;
  }
  const value = normalize(configured);
  if (isValidReplyToEmail(value)) return value;
  logger.warn(
    { campaignId: campaign.id },
    "Reply-To inválido; o cabeçalho Reply-To será omitido",
  );
  return undefined;
}

function validatedEmailBlocks(value: unknown): EmailBlock[] {
  const blocks = normalizeEmailBlocks(value) as EmailBlock[];
  const urlIssues = validateEmailBlockUrls(blocks);
  const buttonIssues = validateEmailButtonDestinations(blocks).filter(
    (issue) => issue.kind === "missing" || issue.kind === "test-domain",
  );
  const messages = [
    ...urlIssues.map((issue) => issue.message),
    ...buttonIssues.map((issue) => issue.message),
  ];
  if (messages.length > 0) {
    throw new WorkerConfigurationError(
      `Não é possível enviar o e-mail até corrigir os destinos: ${messages.join(" ")}`,
    );
  }
  return blocks;
}

function emailPayload(
  campaign: Campaign,
  recipient: WorkerRecipient,
  options: { testAttemptId?: string; reminder?: boolean } = {},
): PreparedResendMessage {
  const reminder = options.reminder === true;
  const key = options.testAttemptId
    ? testIdempotencyKey(campaign.id, recipient.email, options.testAttemptId)
    : idempotencyKey(campaign.id, recipient.email, reminder);
  const unsubscribe = unsubscribeUrl(recipient.email, campaign.id);
  const blocks = validatedEmailBlocks(
    reminder ? campaign.corpo_lembrete : campaign.corpo,
  );
  const subject = reminder ? campaign.assunto_lembrete : campaign.assunto;
  const html = renderEmailHtml(blocks, {
    name: recipient.nome,
    valorCredito: campaign.valor_credito,
    validadeCredito: campaign.validade_credito,
    unsubscribeUrl: unsubscribe,
    preheader: campaign.preheader,
    buttonColor: campaign.cor_botao_snapshot ?? undefined,
  });
  const templateOptions = {
    name: recipient.nome,
    valorCredito: campaign.valor_credito,
    validadeCredito: campaign.validade_credito,
    unsubscribeUrl: unsubscribe,
    preheader: campaign.preheader,
    buttonColor: campaign.cor_botao_snapshot ?? undefined,
  };
  const campaignReplyTo = replyTo(campaign);
  return {
    from: sender(campaign),
    to: [recipient.email],
    subject: interpolateEmailText(subject ?? campaign.assunto, templateOptions),
    html,
    text: renderEmailText(
      blocks,
      templateOptions,
    ),
    ...(campaignReplyTo ? { reply_to: campaignReplyTo } : {}),
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    _idempotencyKey: key,
  };
}

export async function sendBatch(
  campaign: Campaign,
  recipients: WorkerRecipient[],
  options: { testAttemptId?: string; reminder?: boolean } = {},
): Promise<ResendResult[]> {
  const apiKey = requiredEnv("RESEND_API_KEY");
  const messages = recipients.map((recipient) =>
    emailPayload(campaign, recipient, options),
  );
  return sendResendMessages(apiKey, messages);
}

function retryDelay(error: unknown, attempt: number): number {
  const status = (error as { status?: number })?.status;
  const retryAfter = (error as { retryAfter?: number })?.retryAfter;
  if (status === 429 && retryAfter && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 5 * 60 * 1000);
  }
  return Math.min(1000 * 2 ** attempt, 5 * 60 * 1000);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function markSuppressedOrBlocked(
  recipients: WorkerRecipient[],
  campaign?: Campaign,
): Promise<WorkerRecipient[]> {
  const suppression = await loadSuppressedEmails(recipients.map((recipient) => recipient.email));
  const chronic = campaign?.incluir_desengajados
    ? new Set<string>()
    : await loadChronicEmails(recipients.map((recipient) => recipient.email));
  const sendable: WorkerRecipient[] = [];
  for (const recipient of recipients) {
    if (suppression.has(normalize(recipient.email))) {
      await updateRecipient(recipient.id, {
        status: "suprimido",
        processando_em: null,
        erro: "Destinatário presente na lista de supressão.",
      });
      continue;
    }
    if (chronic.has(normalize(recipient.email))) {
      await updateRecipient(recipient.id, {
        status: "suprimido",
        processando_em: null,
        erro: "Destinatário cronicamente desengajado; opt-in não confirmado.",
      });
      continue;
    }
    if (!isRecipientAllowed(recipient.email)) {
      await updateRecipient(recipient.id, {
        status: "bloqueado_modo_teste",
        processando_em: null,
        erro: "Bloqueado pelo modo de segurança.",
      });
      continue;
    }
    sendable.push(recipient);
  }
  return sendable;
}

async function sendWithRetries(
  campaign: Campaign,
  recipients: WorkerRecipient[],
  reminder = false,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const sendable = await markSuppressedOrBlocked(recipients, campaign);
      if (sendable.length !== recipients.length) return;
      const results = await sendBatch(campaign, recipients, { reminder });
      if (results.length !== recipients.length) {
        throw new Error(
          `Resend retornou ${results.length} resultado(s) para ${recipients.length} mensagem(ns).`,
        );
      }
      const sentAt = new Date().toISOString();
      await Promise.all(
        recipients.map((recipient, index) =>
          updateRecipient(recipient.id, {
            status: results[index]?.error ? "erro" : "enviado",
            resend_email_id: results[index]?.id ?? null,
            enviado_em: results[index]?.error ? null : sentAt,
            processando_em: null,
            erro: results[index]?.error?.message ?? null,
          }),
        ),
      );
      return;
    } catch (error) {
      lastError = error;
      if ((error as { status?: number })?.status !== 429 && attempt >= 1) break;
      if (attempt + 1 < MAX_RETRIES) await sleep(retryDelay(error, attempt));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await Promise.all(
    recipients.map((recipient) =>
      updateRecipient(recipient.id, {
        status: "erro",
        processando_em: null,
        erro: message,
      }),
    ),
  );
}

async function maybePauseCampaign(campaignId: string): Promise<boolean> {
  const client = supabaseAdminClient();
  const { count: sent, error: sentError } = await client
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .eq("is_lembrete", false)
    .not("enviado_em", "is", null);
  if (sentError) throw sentError;
  if (!sent || sent < 1000) return false;
  const [delivered, hardBounces, complaints] = await Promise.all([
    client
      .from("destinatario")
      .select("id", { count: "exact", head: true })
      .eq("campanha_id", campaignId)
      .eq("is_lembrete", false)
      .not("entregue_em", "is", null),
    countDistinctCampaignEventContacts(campaignId, "email.bounced", true),
    countDistinctCampaignEventContacts(campaignId, "email.complained"),
  ]);
  if (delivered.error) throw delivered.error;
  const deliveredCount = delivered.count ?? 0;
  const bounceRate = hardBounces / sent || 0;
  const complaintRate = deliveredCount > 0 ? complaints / deliveredCount : 0;
  const reasons: string[] = [];
  if (bounceRate > 0.02) {
    reasons.push(`bounce permanente ${((bounceRate * 100).toFixed(2))}% (limite 2%)`);
  }
  if (complaintRate > 0.002) {
    reasons.push(`reclamações ${((complaintRate * 100).toFixed(2))}% (limite 0,2%)`);
  }
  if (reasons.length === 0) return false;
  await updateCampaignStatus(campaignId, "pausada", {
    pausa_motivo: `Pausa automática: ${reasons.join(" e ")}.`,
    pausa_taxa_bounce: bounceRate,
    pausa_taxa_reclamacao: complaintRate,
    pausada_em: new Date().toISOString(),
    pausado_por_id: null,
    pausado_por_nome: "Sistema",
    pausado_por_email: null,
  });
  try {
    await recordAuditEvent({
      actor: systemAuditActor,
      action: "campaign_auto_paused",
      entityType: "campaign",
      entityId: campaignId,
      metadata: {
        bounce_rate: bounceRate,
        complaint_rate: complaintRate,
        reason: reasons.join(" e "),
      },
    });
  } catch (error) {
    logger.error(
      {
        campaignId,
        technicalError: getTechnicalError(error),
      },
      "Campaign automatic-pause audit event could not be persisted",
    );
  }
  return true;
}

async function countDistinctCampaignEventContacts(
  campaignId: string,
  eventType: string,
  permanentBounceOnly = false,
): Promise<number> {
  const client = supabaseAdminClient();
  const emails = new Set<string>();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    let query = client
      .from("evento_email")
      .select("email")
      .eq("campanha_id", campaignId)
      .eq("tipo", eventType)
      .not("email", "is", null)
      .order("id", { ascending: true });
    if (permanentBounceOnly) query = query.eq("bounce_permanente", true);
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (typeof row.email === "string" && row.email.trim()) {
        emails.add(normalize(row.email));
      }
    }
    if ((data?.length ?? 0) < pageSize) break;
    offset += pageSize;
  }
  return emails.size;
}

export async function processPendingEmailEvents(): Promise<number> {
  const client = supabaseAdminClient();
  const { data: pending, error: pendingError } = await client
    .from("evento_email")
    .select("id,svix_id,tipo,resend_email_id,tentativas")
    .is("processado_em", null)
    .or(`proxima_tentativa_em.is.null,proxima_tentativa_em.lte.${new Date().toISOString()}`)
    .order("recebido_em", { ascending: true })
    .limit(100);
  if (pendingError) {
    logger.error(
      { technicalError: getTechnicalError(pendingError) },
      "Could not load pending Resend events",
    );
    return 0;
  }

  let processed = 0;
  for (const event of pending ?? []) {
    const { data, error } = await client.rpc("process_resend_email_event", {
      p_event_id: event.id,
    });
    if (error) {
      const technicalError = getTechnicalError(error);
      const { error: persistError } = await client
        .from("evento_email")
        .update({
          erro_processamento: JSON.stringify(technicalError),
          tentativas: event.tentativas + 1,
          proxima_tentativa_em: new Date(Date.now() + 30_000).toISOString(),
        })
        .eq("id", event.id)
        .is("processado_em", null);
      logger.error(
        {
          svixId: event.svix_id,
          eventType: event.tipo,
          resendEmailId: event.resend_email_id,
          technicalError,
          ...(persistError
            ? { persistError: getTechnicalError(persistError) }
            : {}),
        },
        "Resend event processing failed; event remains available for retry",
      );
      continue;
    }
    const result =
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : {};
    if (result.matched === false && result.retryable === true) {
      logger.info(
        {
          svixId: event.svix_id,
          eventType: event.tipo,
          resendEmailId: event.resend_email_id,
        },
        "Resend event recipient is not ready yet; event remains queued for retry",
      );
    } else if (result.matched === false) {
      logger.warn(
        {
          svixId: event.svix_id,
          eventType: event.tipo,
          resendEmailId: event.resend_email_id,
          reason: result.reason,
        },
        "Verified Resend event could not be matched and was retained for audit",
      );
    } else if (result.supported === false) {
      logger.info(
        { svixId: event.svix_id, eventType: event.tipo },
        "Verified but unsupported Resend event was stored and ignored",
      );
    }
    if (result.processed === true) processed += 1;
  }
  return processed;
}

async function quotaRemaining(campaign: Campaign): Promise<number> {
  const client = supabaseAdminClient();
  const limits = [campaign.teto_hora, campaign.teto_dia].filter(
    (limit): limit is number => typeof limit === "number" && limit > 0,
  );
  if (limits.length === 0) return RESEND_BATCH_SIZE;
  const now = Date.now();
  const hourStart = new Date(now - 60 * 60 * 1000).toISOString();
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const dayStart = day.toISOString();
  const counts = await Promise.all([
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
  for (const result of counts) {
    if (result.error) throw result.error;
  }
  const hourRemaining =
    campaign.teto_hora && campaign.teto_hora > 0
      ? Math.max(0, campaign.teto_hora - (counts[0].count ?? 0))
      : RESEND_BATCH_SIZE;
  const dayRemaining =
    campaign.teto_dia && campaign.teto_dia > 0
      ? Math.max(0, campaign.teto_dia - (counts[1].count ?? 0))
      : RESEND_BATCH_SIZE;
  return Math.min(RESEND_BATCH_SIZE, hourRemaining, dayRemaining);
}

async function enqueueReminders(campaignId: string, limit: number): Promise<number> {
  const { data, error } = await supabaseAdminClient().rpc(
    "enqueue_campaign_reminders",
    { p_campaign_id: campaignId, p_limit: limit },
  );
  if (error) throw error;
  return typeof data === "number" ? data : Number(data ?? 0);
}

async function processReminderQueue(campaign: Campaign): Promise<number> {
  let processed = 0;
  while (true) {
    const remaining = await quotaRemaining(campaign);
    if (remaining <= 0) break;
    await enqueueReminders(campaign.id, remaining);
    const reserved = await reserveRecipients(campaign.id, remaining, true);
    if (reserved.length === 0) break;
    const sendable = await markSuppressedOrBlocked(reserved, campaign);
    if (sendable.length > 0) {
      await sendWithRetries(campaign, sendable, true);
      processed += sendable.length;
    }
  }
  return processed;
}

async function refreshChronicDisengagementIfDue(): Promise<void> {
  const client = supabaseAdminClient();
  const { data, error } = await client
    .from("estado_desengajamento")
    .select("calculado_em,ciclo_iniciado_em")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (typeof data?.ciclo_iniciado_em === "string") {
    const { error: continueError } = await client.rpc(
      "refresh_chronic_disengagement",
      { p_limit: 1000 },
    );
    if (continueError) throw continueError;
    return;
  }
  const calculatedAt =
    typeof data?.calculado_em === "string"
      ? Date.parse(data.calculado_em)
      : Number.NaN;
  if (Number.isFinite(calculatedAt) && calculatedAt > Date.now() - 15 * 60_000) {
    return;
  }
  const { error: refreshError } = await client.rpc(
    "refresh_chronic_disengagement",
    { p_limit: 1000 },
  );
  if (refreshError) throw refreshError;
}

export async function processCampaign(campaignId: string): Promise<number> {
  let campaign = await loadCampaign(campaignId);
  if (!campaign || !["agendada", "enviando"].includes(campaign.status)) return 0;
  if (campaign.status === "agendada" && campaign.agendada_para) {
    if (new Date(campaign.agendada_para).getTime() > Date.now()) return 0;
  }

  if (campaign.status === "agendada") {
    await updateCampaignStatus(campaignId, "enviando");
    campaign = { ...campaign, status: "enviando" };
  }
  let processed = 0;
  while (true) {
    if (await maybePauseCampaign(campaignId)) break;
    const remaining = await quotaRemaining(campaign);
    if (remaining <= 0) break;
    const reserved = await reserveRecipients(campaignId, remaining);
    if (reserved.length === 0) {
      await updateCampaignStatus(campaignId, "concluida");
      processed += await processReminderQueue(campaign);
      break;
    }
    const sendable = await markSuppressedOrBlocked(reserved, campaign);
    if (sendable.length > 0) {
      await sendWithRetries(campaign, sendable);
      processed += sendable.length;
    }
    await maybePauseCampaign(campaignId);
    const refreshed = await loadCampaign(campaignId);
    if (!refreshed || refreshed.status === "pausada") break;
    campaign = refreshed;
  }
  return processed;
}

export async function processDueCampaigns(): Promise<number> {
  const lockAcquired = await acquireWorkerLock();
  if (!lockAcquired) {
    logger.info(
      { lockKey: WORKER_LOCK_KEY },
      "AmoConecta worker skipped because another execution is still running",
    );
    return 0;
  }

  try {
    await processPendingEmailEvents();
    await refreshChronicDisengagementIfDue();
    await processBiExportJobs();
    await recoverStuckRecipients();
    const { data, error } = await supabaseAdminClient()
      .from("campanha")
      .select("id,status,agendada_para")
      .in("status", ["agendada", "enviando"]);
    if (error) throw error;
    let processed = 0;
    for (const campaign of data ?? []) {
      if (
        campaign.status === "enviando" ||
        !campaign.agendada_para ||
        new Date(campaign.agendada_para).getTime() <= Date.now()
      ) {
        processed += await processCampaign(campaign.id);
      }
    }
    const { data: completedWithReminders, error: reminderError } =
      await supabaseAdminClient()
        .from("campanha")
        .select(
          "id,nome,assunto,assunto_lembrete,corpo_lembrete,cor_botao_snapshot,incluir_desengajados,remetente_nome,remetente_email,preheader,valor_credito,validade_credito,reply_to,corpo,status,agendada_para,teto_hora,teto_dia",
        )
        .eq("status", "concluida")
        .not("assunto_lembrete", "is", null)
        .not("corpo_lembrete", "is", null);
    if (reminderError) throw reminderError;
    for (const campaign of completedWithReminders ?? []) {
      processed += await processReminderQueue(campaign as Campaign);
    }
    return processed;
  } finally {
    try {
      await releaseWorkerLock();
    } catch (error) {
      logger.error(
        {
          technicalError: getTechnicalError(error),
          lockKey: WORKER_LOCK_KEY,
        },
        "AmoConecta worker failed to release the global lock",
      );
    }
  }
}

export async function sendTestEmail(
  campaignId: string,
  recipientEmail: string,
): Promise<string> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) throw new Error("Campanha não encontrada.");
  const normalizedEmail = normalize(recipientEmail);
  const suppressed = await loadSuppressedEmails([normalizedEmail]);
  if (suppressed.has(normalizedEmail)) {
    throw new Error("O destinatário de teste está suprimido.");
  }
  if (!isRecipientAllowed(normalizedEmail)) {
    throw new Error(
      "Bloqueado pelo modo de segurança: este endereço não está na lista de teste.",
    );
  }
  const testRecipient: WorkerRecipient = {
    id: `teste:${campaign.id}:${normalizedEmail}`,
    campanha_id: campaign.id,
    email: normalizedEmail,
    nome: null,
    status: "processando",
    tentativas: 0,
  };
  const result = await sendBatch(
    { ...campaign, assunto: `[TESTE] ${campaign.assunto}` },
    [
    { ...testRecipient, email: normalizedEmail },
    ],
    { testAttemptId: `${Date.now()}-${randomUUID()}` },
  );
  const resendId = result[0]?.id;
  if (!resendId) throw new Error("Resend não retornou o ID do e-mail de teste.");
  const { error } = await supabaseAdminClient()
    .from("campanha")
    .update({ teste_enviado: true, teste_enviado_em: new Date().toISOString() })
    .eq("id", campaign.id);
  if (error) throw error;
  return resendId;
}

export async function addSuppression(
  email: string,
  campaignId: string | null,
): Promise<void> {
  const client = supabaseAdminClient();
  const normalizedEmail = normalize(email);
  const markCampaignUnsubscribe = async () => {
    if (!campaignId) return;
    const { error } = await client
      .from("destinatario")
      .update({ descadastrado_em: new Date().toISOString() })
      .eq("campanha_id", campaignId)
      .eq("email", normalizedEmail)
      .eq("is_lembrete", false)
      .is("descadastrado_em", null);
    if (error) throw error;
  };
  const payload = {
    email: normalizedEmail,
    motivo: "descadastro",
    origem: campaignId ? `campanha:${campaignId}` : "publico",
  };
  const { data: existing, error: lookupError } = await client
    .from("supressao")
    .select("id")
    .eq("email", normalizedEmail)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const { error } = await client
      .from("supressao")
      .update({ motivo: payload.motivo, origem: payload.origem })
      .eq("id", existing.id);
    if (error) throw error;
    await markCampaignUnsubscribe();
    return;
  }
  const { error: insertError } = await client.from("supressao").insert(payload);
  if (insertError) {
    // A second request can insert the same e-mail between the lookup and
    // insert. In that case, update the row it won.
    if (insertError.code !== "23505") throw insertError;
    const { error: retryError } = await client
      .from("supressao")
      .update({ motivo: payload.motivo, origem: payload.origem })
      .eq("email", normalizedEmail);
    if (retryError) throw retryError;
  }
  await markCampaignUnsubscribe();
}
