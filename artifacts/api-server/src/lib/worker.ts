import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  normalizeEmailBlocks,
  renderEmailHtml,
  type EmailBlock,
} from "@workspace/email-template";
import { supabaseAdminClient } from "./supabase";
import { isRecipientAllowed } from "./safety-mode";

const RESEND_BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const DEFAULT_SENDER_NAME = "Amo Ofertas";
const DEFAULT_REPLY_TO = "contato@marketing.amo.delivery";
const WORKER_RPC = "reservar_destinatarios";

type Campaign = {
  id: string;
  nome: string;
  assunto: string;
  remetente_nome: string;
  remetente_email: string;
  reply_to?: string | null;
  corpo: unknown;
  status: string;
  agendada_para?: string | null;
  teto_hora?: number | null;
  teto_dia?: number | null;
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

type ResendResult = { id?: string; error?: { message?: string } };

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

export function idempotencyKey(
  campaignId: string,
  email: string,
  isReminder: boolean,
): string {
  return createHash("sha256")
    .update(`${campaignId}:${normalize(email)}:${isReminder ? "lembrete" : "principal"}`)
    .digest("hex");
}

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
): Promise<WorkerRecipient[]> {
  const { data, error } = await supabaseAdminClient().rpc(WORKER_RPC, {
    p_campanha_id: campaignId,
    p_limite: limit,
    p_is_lembrete: false,
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

async function loadCampaign(campaignId: string): Promise<Campaign | null> {
  const { data, error } = await supabaseAdminClient()
    .from("campanha")
    .select(
      "id,nome,assunto,remetente_nome,remetente_email,reply_to,corpo,status,agendada_para,teto_hora,teto_dia",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data as Campaign | null;
}

async function loadSuppressedEmails(emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const { data, error } = await supabaseAdminClient()
    .from("supressao")
    .select("email")
    .in("email", emails);
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

async function updateCampaignStatus(campaignId: string, status: string): Promise<void> {
  const { error } = await supabaseAdminClient()
    .from("campanha")
    .update({ status })
    .eq("id", campaignId);
  if (error) throw error;
}

function sender(campaign: Campaign): string {
  const email = normalize(campaign.remetente_email || requiredEnv("SENDER_EMAIL"));
  if (!email.endsWith("@marketing.amo.delivery")) {
    throw new WorkerConfigurationError(
      "O remetente da campanha precisa pertencer a marketing.amo.delivery.",
    );
  }
  return `${campaign.remetente_nome || process.env.SENDER_NAME || DEFAULT_SENDER_NAME} <${email}>`;
}

function replyTo(campaign: Campaign): string | undefined {
  const value = normalize(
    campaign.reply_to ?? process.env.REPLY_TO_EMAIL ?? DEFAULT_REPLY_TO,
  );
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? value : undefined;
}

function emailPayload(campaign: Campaign, recipient: WorkerRecipient) {
  const key = idempotencyKey(campaign.id, recipient.email, false);
  const unsubscribe = unsubscribeUrl(recipient.email, campaign.id);
  const html = renderEmailHtml(normalizeEmailBlocks(campaign.corpo) as EmailBlock[], {
    name: recipient.nome,
    unsubscribeUrl: unsubscribe,
  });
  return {
    from: sender(campaign),
    to: [recipient.email],
    subject: campaign.assunto,
    html,
    ...(replyTo(campaign) ? { reply_to: replyTo(campaign) } : {}),
    headers: {
      "Idempotency-Key": key,
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    _idempotencyKey: key,
  };
}

async function sendBatch(
  campaign: Campaign,
  recipients: WorkerRecipient[],
): Promise<ResendResult[]> {
  const apiKey = requiredEnv("RESEND_API_KEY");
  const messages = recipients.map((recipient) => emailPayload(campaign, recipient));
  const batchKey = createHash("sha256")
    .update(messages.map((message) => message._idempotencyKey).join(","))
    .digest("hex");
  const response = await fetch("https://api.resend.com/emails/batch", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": batchKey,
    },
    body: JSON.stringify(
      messages.map(({ _idempotencyKey: _ignored, ...message }) => message),
    ),
  });
  const body = (await response.json().catch(() => null)) as
    | { data?: ResendResult[]; message?: string; error?: string }
    | null;
  if (!response.ok) {
    const error = new Error(
      `Resend ${response.status}: ${body?.message ?? body?.error ?? "falha sem detalhe"}`,
    ) as Error & { status?: number; retryAfter?: number };
    error.status = response.status;
    const retryAfter = Number(response.headers.get("retry-after"));
    error.retryAfter = Number.isFinite(retryAfter) ? retryAfter : undefined;
    throw error;
  }
  return body?.data ?? [];
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
): Promise<WorkerRecipient[]> {
  const suppression = await loadSuppressedEmails(recipients.map((recipient) => recipient.email));
  const sendable: WorkerRecipient[] = [];
  for (const recipient of recipients) {
    if (suppression.has(normalize(recipient.email))) {
      await updateRecipient(recipient.id, {
        status: "suprimido",
        erro: "Destinatário presente na lista de supressão.",
      });
      continue;
    }
    if (!isRecipientAllowed(recipient.email)) {
      await updateRecipient(recipient.id, {
        status: "bloqueado_modo_teste",
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
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      const results = await sendBatch(campaign, recipients);
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
      updateRecipient(recipient.id, { status: "erro", erro: message }),
    ),
  );
}

async function maybePauseCampaign(campaignId: string): Promise<void> {
  const client = supabaseAdminClient();
  const { count: sent, error: sentError } = await client
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .in("status", ["enviado", "entregue", "aberto", "clicado", "bounce"]);
  if (sentError) throw sentError;
  if (!sent || sent < 1000) return;
  const { count: bounces, error: bounceError } = await client
    .from("destinatario")
    .select("id", { count: "exact", head: true })
    .eq("campanha_id", campaignId)
    .eq("status", "bounce");
  if (bounceError) throw bounceError;
  const { count: complaints, error: complaintError } = await client
    .from("supressao")
    .select("email", { count: "exact", head: true })
    .eq("origem", `campanha:${campaignId}`)
    .eq("motivo", "complaint");
  if (complaintError) throw complaintError;
  if (
    (bounces ?? 0) / sent > 0.02 ||
    (complaints ?? 0) / sent > 0.002
  ) {
    await updateCampaignStatus(campaignId, "pausada");
  }
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
    const remaining = await quotaRemaining(campaign);
    if (remaining <= 0) break;
    const reserved = await reserveRecipients(campaignId, remaining);
    if (reserved.length === 0) {
      await updateCampaignStatus(campaignId, "concluida");
      break;
    }
    const sendable = await markSuppressedOrBlocked(reserved);
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
  return processed;
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
  );
  const resendId = result[0]?.id;
  if (!resendId) throw new Error("Resend não retornou o ID do e-mail de teste.");
  const { error } = await supabaseAdminClient()
    .from("campanha")
    .update({ teste_enviado: true })
    .eq("id", campaign.id);
  if (error) throw error;
  return resendId;
}

export async function addSuppression(
  email: string,
  campaignId: string | null,
): Promise<void> {
  const { error } = await supabaseAdminClient().from("supressao").upsert(
    {
      email: normalize(email),
      motivo: "descadastro",
      origem: campaignId ? `campanha:${campaignId}` : "publico",
    },
    { onConflict: "email" },
  );
  if (error) throw error;
}
