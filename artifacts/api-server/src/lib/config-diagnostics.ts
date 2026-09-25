export const API_REQUIRED_SECRET_NAMES = [
  "RESEND_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "UNSUBSCRIBE_SECRET",
  "APP_BASE_URL",
  "ENVIO_LIBERADO",
  "ENVIO_ALLOWLIST",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
  "DATABASE_URL",
  "PORT",
] as const;

export const WORKER_REQUIRED_SECRET_NAMES = [
  "RESEND_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "UNSUBSCRIBE_SECRET",
  "APP_BASE_URL",
  "ENVIO_LIBERADO",
  "ENVIO_ALLOWLIST",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DEFAULT_OBJECT_STORAGE_BUCKET_ID",
  "PRIVATE_OBJECT_DIR",
] as const;

export type RequiredSecretStatus = {
  present: string[];
  missing: string[];
};

export function getRequiredSecretStatus(
  names: readonly string[],
): RequiredSecretStatus {
  const present: string[] = [];
  const missing: string[] = [];

  for (const name of names) {
    if (process.env[name]?.trim()) present.push(name);
    else missing.push(name);
  }

  return { present, missing };
}