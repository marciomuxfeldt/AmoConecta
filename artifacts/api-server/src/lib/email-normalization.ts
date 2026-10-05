/**
 * Canonical application-side e-mail normalization.
 *
 * Keep the database counterpart in the Supabase migration aligned with this
 * rule: remove controls/format characters, trim Unicode whitespace only at
 * the edges, then lowercase for Portuguese/Brazilian data. Interior whitespace
 * is preserved so malformed addresses are rejected rather than rewritten.
 */
export function normalizeEmail(value: string): string {
  return value
    .replace(/\u00A0/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .toLocaleLowerCase("pt-BR");
}
