import { createHash } from "node:crypto";

const RESEND_SEND_CONCURRENCY = 10;

export type ResendResult = {
  id?: string;
  error?: { message?: string };
};

export type PreparedResendMessage = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  reply_to?: string;
  headers: Record<string, string>;
  _idempotencyKey: string;
};

export function idempotencyKey(
  campaignId: string,
  email: string,
  isReminder: boolean,
): string {
  return createHash("sha256")
    .update(`${campaignId}:${email.trim().toLowerCase()}:${isReminder ? "lembrete" : "principal"}`)
    .digest("hex");
}

export function batchIdempotencyKey(messageKeys: string[]): string {
  return createHash("sha256").update(messageKeys.join(",")).digest("hex");
}

async function sendOne(
  apiKey: string,
  message: PreparedResendMessage,
): Promise<ResendResult> {
  const { _idempotencyKey, ...payload } = message;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": _idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as
    | { id?: string; message?: string; error?: string }
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
  if (!body?.id) {
    throw new Error("Resend não retornou o ID do e-mail.");
  }
  return { id: body.id };
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
  return results;
}

/**
 * Resend applies Idempotency-Key to the whole HTTP request, not to individual
 * items inside /emails/batch. Sending one message per request is intentional:
 * a recovered batch can change composition, but each recipient keeps its key.
 */
export async function sendResendMessages(
  apiKey: string,
  messages: PreparedResendMessage[],
): Promise<ResendResult[]> {
  return mapConcurrent(messages, RESEND_SEND_CONCURRENCY, (message) =>
    sendOne(apiKey, message),
  );
}