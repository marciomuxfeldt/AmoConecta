import { normalizeEmail } from "./email-normalization";

const DEFAULT_API_URL = "https://api.zerobounce.net/v2";
const EMAIL_STATUSES = new Set([
  "valid",
  "invalid",
  "catch-all",
  "unknown",
  "spamtrap",
  "abuse",
  "do_not_mail",
]);

export type ZeroBounceEmailResult = {
  email: string;
  status: string;
  subStatus: string | null;
  freeEmail: boolean | null;
  didYouMean: string | null;
  domain: string | null;
  smtpProvider: string | null;
  mxFound: boolean | null;
  raw: Record<string, unknown>;
};

export type ZeroBounceBatchItem =
  | { kind: "result"; value: ZeroBounceEmailResult }
  | { kind: "error"; email: string; message: string; raw: Record<string, unknown> }
  | { kind: "global_error"; message: string; raw: Record<string, unknown> };

export class ZeroBounceError extends Error {
  readonly status?: number;
  readonly insufficientCredits: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; insufficientCredits?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ZeroBounceError";
    this.status = options.status;
    this.insufficientCredits = options.insufficientCredits === true;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function apiKey(): string {
  const value = process.env.ZEROBOUNCE_API_KEY?.trim();
  if (!value) throw new ZeroBounceError("ZEROBOUNCE_API_KEY não está configurada.");
  return value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedApiError(payload: unknown): string | null {
  const root = record(payload);
  if (!root) return null;
  const candidate = root.error ?? root.message;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : null;
}

function isInsufficientCredits(message: string): boolean {
  return /insufficient\s+credits|not\s+enough\s+credits|no\s+credits|out\s+of\s+credits/i.test(message);
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZeroBounceError(
      `ZeroBounce retornou JSON inválido (HTTP ${response.status}).`,
      { status: response.status },
    );
  }
}

async function post(
  endpoint: "getcredits" | "validatebatch",
  body: string | URLSearchParams,
  contentType: string,
  fetcher: typeof fetch,
): Promise<unknown> {
  const response = await fetcher(`${DEFAULT_API_URL}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal: AbortSignal.timeout(75_000),
  });
  return validateResponse(response);
}

async function validateResponse(response: Response): Promise<unknown> {
  const payload = await responsePayload(response);
  const errorMessage = normalizedApiError(payload);
  if (!response.ok || errorMessage) {
    const message =
      errorMessage ?? `ZeroBounce respondeu com HTTP ${response.status}.`;
    throw new ZeroBounceError(message, {
      status: response.status,
      insufficientCredits: isInsufficientCredits(message),
      retryAfterMs: response.status === 429 ? 10 * 60_000 : undefined,
    });
  }
  return payload;
}

export async function getZeroBounceCredits(fetcher: typeof fetch = fetch): Promise<number> {
  const url = new URL(`${DEFAULT_API_URL}/getcredits`);
  url.searchParams.set("api_key", apiKey());
  const response = await fetcher(url, {
    method: "GET",
    signal: AbortSignal.timeout(75_000),
  });
  const payload = await validateResponse(response);
  const root = record(payload);
  const rawCredits = root?.Credits ?? root?.credits ?? root?.credits_remaining;
  const credits =
    typeof rawCredits === "number"
      ? rawCredits
      : typeof rawCredits === "string" && rawCredits.trim()
        ? Number(rawCredits)
        : Number.NaN;
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new ZeroBounceError("A resposta de saldo da ZeroBounce está malformada.");
  }
  return credits;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/iu.test(value)) {
    return value.toLowerCase() === "true";
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function resultAddress(value: Record<string, unknown>): string | null {
  const address = value.address ?? value.email_address;
  return typeof address === "string" ? normalizeEmail(address) : null;
}

function apiErrorAddress(value: Record<string, unknown>): string | null {
  const address = value.email_address ?? value.address ?? value.email;
  return typeof address === "string" ? normalizeEmail(address) : null;
}

export function parseZeroBounceBatch(
  payload: unknown,
  requestedEmails: readonly string[],
): ZeroBounceBatchItem[] {
  const root = record(payload);
  if (!root || !Array.isArray(root.email_batch) || !Array.isArray(root.errors)) {
    throw new ZeroBounceError("A resposta do lote ZeroBounce não contém email_batch e errors.");
  }
  const expected = new Set(requestedEmails.map(normalizeEmail));
  if (expected.size !== requestedEmails.length || expected.size === 0) {
    throw new ZeroBounceError("O lote enviado à ZeroBounce contém e-mails duplicados ou vazio.");
  }

  const items = new Map<string, ZeroBounceBatchItem>();
  let globalCreditsError: ZeroBounceBatchItem | null = null;
  for (const entry of root.email_batch) {
    const value = record(entry);
    const email = value && resultAddress(value);
    const status = value?.status;
    if (
      !value ||
      !email ||
      !expected.has(email) ||
      typeof status !== "string" ||
      !EMAIL_STATUSES.has(status) ||
      items.has(email)
    ) {
      throw new ZeroBounceError("A resposta email_batch da ZeroBounce está malformada.");
    }
    items.set(email, {
      kind: "result",
      value: {
        email,
        status,
        subStatus: stringValue(value.sub_status),
        freeEmail: booleanValue(value.free_email),
        didYouMean: stringValue(value.did_you_mean),
        domain: stringValue(value.domain),
        smtpProvider: stringValue(value.smtp_provider),
        mxFound: booleanValue(value.mx_found),
        raw: value,
      },
    });
  }

  for (const entry of root.errors) {
    const value = record(entry);
    const email = value && apiErrorAddress(value);
    if (!value) {
      throw new ZeroBounceError("A lista errors da ZeroBounce está malformada.");
    }
    const message = value.error ?? value.message ?? value.error_message;
    if (typeof message !== "string" || !message.trim()) {
      throw new ZeroBounceError("Um erro individual da ZeroBounce não contém descrição.");
    }
    if (
      email === "all" &&
      isInsufficientCredits(message)
    ) {
      if (globalCreditsError) {
        throw new ZeroBounceError("A lista errors da ZeroBounce contém erros globais duplicados.");
      }
      globalCreditsError = {
        kind: "global_error",
        message: message.trim(),
        raw: value,
      };
      continue;
    }
    if (!email || !expected.has(email) || items.has(email)) {
      throw new ZeroBounceError("A lista errors da ZeroBounce está malformada.");
    }
    items.set(email, {
      kind: "error",
      email,
      message: message.trim(),
      raw: value,
    });
  }

  if (items.size !== expected.size && !globalCreditsError) {
    throw new ZeroBounceError("A resposta da ZeroBounce não corresponde a todos os e-mails enviados.");
  }
  const parsed = [...items.values()];
  if (globalCreditsError) parsed.push(globalCreditsError);
  return parsed;
}

export async function validateZeroBounceBatch(
  emails: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<ZeroBounceBatchItem[]> {
  if (emails.length < 1 || emails.length > 100) {
    throw new ZeroBounceError("O lote ZeroBounce deve conter de 1 a 100 e-mails.");
  }
  const uniqueEmails = [...new Set(emails.map(normalizeEmail))];
  if (uniqueEmails.length !== emails.length) {
    throw new ZeroBounceError("O lote ZeroBounce contém e-mails duplicados.");
  }
  const payload = await post(
    "validatebatch",
    JSON.stringify({
      api_key: apiKey(),
      email_batch: uniqueEmails.map((email) => ({ email_address: email })),
    }),
    "application/json",
    fetcher,
  );
  return parseZeroBounceBatch(payload, uniqueEmails);
}
