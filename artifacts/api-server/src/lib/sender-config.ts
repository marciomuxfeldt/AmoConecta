export const VERIFIED_SENDER_DOMAIN = "marketing.amo.delivery";
export const DEFAULT_SENDER_NAME = "Amo Ofertas";

export function normalizeSenderEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isVerifiedSenderEmail(email: string): boolean {
  const normalized = normalizeSenderEmail(email);
  return /^[^\s@]+@[^\s@]+$/u.test(normalized) &&
    normalized.endsWith(`@${VERIFIED_SENDER_DOMAIN}`);
}

export function configuredSenderEmail(): string | null {
  const value = process.env.SENDER_EMAIL?.trim();
  return value ? normalizeSenderEmail(value) : null;
}

export function configuredSenderName(): string {
  return process.env.SENDER_NAME?.trim() || DEFAULT_SENDER_NAME;
}

export function configuredReplyToEmail(): string | null {
  const value = process.env.REPLY_TO_EMAIL?.trim();
  return value ? normalizeSenderEmail(value) : null;
}

export function applyConfiguredReplyTo(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...input };
  const configuredReplyTo = configuredReplyToEmail();
  if (!String(result.reply_to ?? "").trim() && configuredReplyTo) {
    result.reply_to = configuredReplyTo;
  }
  return result;
}

export function warnIfReplyToDefaultMissing(
  replyTo: unknown,
  creationPath: "draft" | "campaign",
  warn: (bindings: Record<string, unknown>, message: string) => void,
): void {
  const hasReplyTo = typeof replyTo === "string" && replyTo.trim().length > 0;
  if (configuredReplyToEmail() || hasReplyTo) return;

  warn(
    {
      setting: "REPLY_TO_EMAIL",
      campaignCreationPath: creationPath,
    },
    "Campaign created without a Reply-To default because REPLY_TO_EMAIL is not configured",
  );
}

export function isValidReplyToEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizeSenderEmail(email));
}

export function senderDomainValidationMessage(): string {
  return `Campo inválido: e-mail do remetente. Use um endereço do domínio @${VERIFIED_SENDER_DOMAIN}.`;
}