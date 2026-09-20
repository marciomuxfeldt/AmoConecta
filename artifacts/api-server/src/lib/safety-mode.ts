const SAFETY_MODE_MESSAGE = "Modo de segurança ativo — envios restritos à lista de teste";

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function readAllowlist(): Set<string> {
  return new Set(
    (process.env.ENVIO_ALLOWLIST ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

export function getSafetyMode() {
  const envioLiberado = parseBoolean(process.env.ENVIO_LIBERADO);
  const allowlist = readAllowlist();
  return {
    envio_liberado: envioLiberado,
    allowlist_count: allowlist.size,
    message: envioLiberado ? null : SAFETY_MODE_MESSAGE,
  };
}

export function isRecipientAllowed(email: string): boolean {
  const envioLiberado = parseBoolean(process.env.ENVIO_LIBERADO);
  return envioLiberado || readAllowlist().has(normalizeEmail(email));
}

export function getSafetyModeMessage(): string {
  return SAFETY_MODE_MESSAGE;
}