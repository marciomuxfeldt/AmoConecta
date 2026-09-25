export type TechnicalError = {
  name: string;
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
  stack: string | null;
  cause: TechnicalError | string | null;
};

export type PublicTechnicalError = {
  name: string;
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
  cause: string | null;
};

export function getTechnicalError(error: unknown): TechnicalError {
  const seen = new WeakSet<object>();
  if (typeof error === "object" && error !== null) seen.add(error);
  return getTechnicalErrorAt(error, seen, 0);
}

export function getPublicTechnicalError(error: unknown): PublicTechnicalError {
  return withoutStack(getTechnicalError(error));
}

function withoutStack(error: TechnicalError): PublicTechnicalError {
  const cause = error.cause;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
    cause: cause && typeof cause === "object"
      ? JSON.stringify(withoutStack(cause))
      : typeof cause === "string"
        ? cause
        : null,
  };
}

function getTechnicalErrorAt(
  error: unknown,
  seen: WeakSet<object>,
  depth: number,
): TechnicalError {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  const syntheticError = new Error(message);

  return {
    name:
      error instanceof Error
        ? error.name
        : typeof record?.name === "string"
          ? record.name
          : record?.code
            ? "SupabaseError"
            : "UnknownError",
    message,
    code: typeof record?.code === "string" ? record.code : null,
    details: typeof record?.details === "string" ? record.details : null,
    hint: typeof record?.hint === "string" ? record.hint : null,
    stack:
      error instanceof Error && error.stack
        ? error.stack
        : syntheticError.stack ?? null,
    cause: causeValue(error, record, seen, depth),
  };
}

function causeValue(
  error: unknown,
  record: Record<string, unknown> | null,
  seen: WeakSet<object>,
  depth: number,
): TechnicalError | string | null {
  const cause =
    error instanceof Error
      ? error.cause
      : record?.cause;
  if (cause == null) return null;
  if (typeof cause === "string") return cause;
  if (typeof cause !== "object" || depth >= 4 || seen.has(cause)) return String(cause);
  seen.add(cause);
  return getTechnicalErrorAt(cause, seen, depth + 1);
}

export function getTechnicalErrorText(error: unknown): string {
  return JSON.stringify(getTechnicalError(error));
}
