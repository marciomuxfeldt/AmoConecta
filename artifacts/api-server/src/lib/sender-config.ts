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

export function isValidReplyToEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizeSenderEmail(email));
}

export function senderDomainValidationMessage(): string {
  return `Campo inválido: e-mail do remetente. Use um endereço do domínio @${VERIFIED_SENDER_DOMAIN}.`;
}