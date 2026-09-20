export type TechnicalError = {
  name: string;
  message: string;
  code: string | null;
  details: string | null;
  hint: string | null;
  stack: string | null;
};

export function getTechnicalError(error: unknown): TechnicalError {
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
  };
}

export function getTechnicalErrorText(error: unknown): string {
  return JSON.stringify(getTechnicalError(error));
}