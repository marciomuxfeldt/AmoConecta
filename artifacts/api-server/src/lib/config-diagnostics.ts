export const REQUIRED_SECRET_NAMES = [
  "RESEND_API_KEY",
  "SENDER_EMAIL",
  "SENDER_NAME",
  "REPLY_TO_EMAIL",
  "UNSUBSCRIBE_SECRET",
  "APP_BASE_URL",
  "ENVIO_LIBERADO",
  "ENVIO_ALLOWLIST",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
] as const;

export type RequiredSecretStatus = {
  present: string[];
  missing: string[];
};

export function getRequiredSecretStatus(): RequiredSecretStatus {
  const present: string[] = [];
  const missing: string[] = [];

  for (const name of REQUIRED_SECRET_NAMES) {
    if (process.env[name]?.trim()) present.push(name);
    else missing.push(name);
  }

  return { present, missing };
}