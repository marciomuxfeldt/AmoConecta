const SAFETY_MODE_MESSAGE = "Modo de segurança ativo — envios restritos à lista de teste";

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function normalizeAllowlistEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeGmailPlusAddress(email: string): string {
  const normalized = normalizeAllowlistEmail(email);
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === normalized.length - 1) return normalized;

  const domain = normalized.slice(atIndex + 1);
  if (domain !== "gmail.com") return normalized;

  const localPart = normalized.slice(0, atIndex);
  const plusIndex = localPart.indexOf("+");
  return plusIndex > 0
    ? `${localPart.slice(0, plusIndex)}@${domain}`
    : normalized;
}

type Allowlist = {
  entries: Set<string>;
  emails: Set<string>;
  domains: Set<string>;
};

function readAllowlist(): Allowlist {
  const entries = new Set(
    (process.env.ENVIO_ALLOWLIST ?? "")
      .split(",")
      .map(normalizeAllowlistEmail)
      .filter(Boolean),
  );
  const emails = new Set<string>();
  const domains = new Set<string>();

  for (const entry of entries) {
    if (entry.startsWith("@")) {
      const domain = entry.slice(1);
      if (domain) domains.add(domain);
    } else {
      emails.add(normalizeGmailPlusAddress(entry));
    }
  }

  return { entries, emails, domains };
}

export function getSafetyMode() {
  const envioLiberado = parseBoolean(process.env.ENVIO_LIBERADO);
  const allowlist = readAllowlist();
  return {
    envio_liberado: envioLiberado,
    allowlist_count: allowlist.entries.size,
    message: envioLiberado ? null : SAFETY_MODE_MESSAGE,
  };
}

export function isRecipientAllowed(email: string): boolean {
  const envioLiberado = parseBoolean(process.env.ENVIO_LIBERADO);
  if (envioLiberado) return true;

  const normalizedEmail = normalizeGmailPlusAddress(email);
  const atIndex = normalizedEmail.lastIndexOf("@");
  const domain = atIndex > 0 && atIndex < normalizedEmail.length - 1
    ? normalizedEmail.slice(atIndex + 1)
    : null;
  const allowlist = readAllowlist();
  return allowlist.emails.has(normalizedEmail) || (domain != null && allowlist.domains.has(domain));
}

export function getSafetyModeMessage(): string {
  return SAFETY_MODE_MESSAGE;
}