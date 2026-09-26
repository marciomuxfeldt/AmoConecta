import { createHash } from "node:crypto";

type TransactionalEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
};

export function applicationUrl(
  path: string,
  query: Record<string, string>,
): string {
  const configuredBaseUrl = process.env.APP_BASE_URL;
  if (!configuredBaseUrl) {
    throw new Error("APP_BASE_URL é obrigatória para links de acesso.");
  }
  const baseUrl = new URL(configuredBaseUrl);
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    throw new Error("APP_BASE_URL precisa usar HTTP ou HTTPS.");
  }
  const normalizedPath = path.replace(/^\/+/u, "");
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/${normalizedPath}`;
  baseUrl.search = "";
  baseUrl.hash = "";
  for (const [key, value] of Object.entries(query)) {
    baseUrl.searchParams.set(key, value);
  }
  return baseUrl.toString();
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

export function emailIdempotencyKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sendTransactionalEmail(
  message: TransactionalEmail,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const senderEmail = process.env.SENDER_EMAIL;
  const senderName = process.env.SENDER_NAME;
  if (!apiKey || !senderEmail || !senderName) {
    throw new Error(
      "RESEND_API_KEY, SENDER_EMAIL e SENDER_NAME são obrigatórias para e-mails transacionais.",
    );
  }

  const payload: Record<string, unknown> = {
    from: `${senderName} <${senderEmail}>`,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
  };
  if (process.env.REPLY_TO_EMAIL) {
    payload.reply_to = process.env.REPLY_TO_EMAIL;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(
      `Resend recusou o e-mail transacional (HTTP ${response.status}).`,
    );
  }
}