import { createHash } from "node:crypto";
import { logger } from "./logger";

const RESEND_SEND_CONCURRENCY = 10;
export const RESEND_MIN_INTERVAL_ENV = "RESEND_MIN_INTERVAL_MS";
export const DEFAULT_RESEND_MIN_INTERVAL_MS = 125;
const MIN_RESEND_INTERVAL_MS = 100;
let warnedLowIntervalValue: string | undefined;

export type ResendResult = {
  id?: string;
  error?: { message?: string };
};

export type PreparedResendMessage = {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
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

export function testIdempotencyKey(
  campaignId: string,
  email: string,
  attemptId: string,
): string {
  return createHash("sha256")
    .update(`${campaignId}:${email.trim().toLowerCase()}:teste:${attemptId}`)
    .digest("hex");
}

export function batchIdempotencyKey(messageKeys: string[]): string {
  return createHash("sha256").update(messageKeys.join(",")).digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function configuredMinIntervalMs(): number {
  const raw = process.env[RESEND_MIN_INTERVAL_ENV]?.trim();
  if (!raw) return DEFAULT_RESEND_MIN_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${RESEND_MIN_INTERVAL_ENV} precisa ser um número maior que zero.`,
    );
  }
  if (value < MIN_RESEND_INTERVAL_MS) {
    if (warnedLowIntervalValue !== raw) {
      warnedLowIntervalValue = raw;
      logger.warn(
        {
          configuredIntervalMs: value,
          minimumIntervalMs: MIN_RESEND_INTERVAL_MS,
        },
        `${RESEND_MIN_INTERVAL_ENV} configurado abaixo de ${MIN_RESEND_INTERVAL_MS} ms foi ignorado; o mínimo evita ultrapassar 10 requisições por segundo.`,
      );
    }
    return MIN_RESEND_INTERVAL_MS;
  }
  return Math.ceil(value);
}

function resetAtMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric >= 1_000_000_000_000) return numeric;
    if (numeric >= 1_000_000_000) return numeric * 1000;
    return now + numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function remainingRequests(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
}

class ResendRateLimiter {
  private queue = Promise.resolve();
  private nextStartAt = 0;
  private adaptiveIntervalMs = 0;
  private adaptiveUntil = 0;

  async run<T>(
    operation: () => Promise<T>,
    onResult: (result: T) => void,
  ): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };

    try {
      const now = Date.now();
      const startAt = Math.max(now, this.nextStartAt);
      const delay = startAt - now;
      if (delay > 0) await sleep(delay);
      const actualStartAt = Date.now();
      this.nextStartAt =
        actualStartAt + this.intervalAt(actualStartAt);

      let request: Promise<T>;
      try {
        request = operation();
      } catch (error) {
        releaseOnce();
        throw error;
      }
      request.then(
        (result) => {
          try {
            onResult(result);
          } catch {
            // The request result must not break the global scheduling queue.
          }
        },
        () => undefined,
      );
      releaseOnce();
      return request;
    } finally {
      releaseOnce();
    }
  }

  observe(response: Response): void {
    const now = Date.now();
    const remaining = remainingRequests(
      response.headers.get("ratelimit-remaining"),
    );
    const resetAt = resetAtMilliseconds(
      response.headers.get("ratelimit-reset"),
      now,
    );
    if (remaining === null || resetAt === null || resetAt <= now) return;

    if (remaining === 0) {
      this.nextStartAt = Math.max(this.nextStartAt, resetAt);
      this.adaptiveUntil = resetAt;
      this.adaptiveIntervalMs = 0;
      return;
    }

    const interval = Math.ceil((resetAt - now) / remaining);
    const configuredInterval = configuredMinIntervalMs();
    if (interval > configuredInterval) {
      this.adaptiveIntervalMs = Math.max(this.adaptiveIntervalMs, interval);
      this.adaptiveUntil = Math.max(this.adaptiveUntil, resetAt);
    }
  }

  private intervalAt(now: number): number {
    if (this.adaptiveUntil <= now) {
      this.adaptiveUntil = 0;
      this.adaptiveIntervalMs = 0;
    }
    return Math.max(configuredMinIntervalMs(), this.adaptiveIntervalMs);
  }
}

const resendRateLimiter = new ResendRateLimiter();

async function sendOne(
  apiKey: string,
  message: PreparedResendMessage,
): Promise<ResendResult> {
  const { _idempotencyKey, headers: messageHeaders, ...messagePayload } = message;
  const headers = Object.fromEntries(
    Object.entries(messageHeaders).filter(
      ([name]) => name.toLowerCase() !== "idempotency-key",
    ),
  );
  const payload = { ...messagePayload, headers };
  const response = await resendRateLimiter.run(
    () =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": _idempotencyKey,
        },
        body: JSON.stringify(payload),
      }),
    (result) => resendRateLimiter.observe(result),
  );
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