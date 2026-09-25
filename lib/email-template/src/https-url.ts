/**
 * Returns true only for a complete, secure URL.
 *
 * The prefix check is intentionally performed before constructing URL: the
 * WHATWG parser treats values such as `https:example.com` as valid and
 * resolves them relative to a base in some environments.
 */
export function isStrictHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  if (/\s/u.test(value)) return false;
  const authority = value.slice("https://".length).split(/[/?#]/u, 1)[0];
  if (!authority) return false;

  try {
    const URLConstructor = (globalThis as unknown as {
      URL: new (input: string) => {
        protocol: string;
        hostname: string;
        username: string;
        password: string;
      };
    }).URL;
    const parsed = new URLConstructor(value);
    return parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0;
  } catch {
    return false;
  }
}

/**
 * Suggests the value that would be used when an operator entered a bare
 * hostname/path. The caller must display this suggestion and obtain
 * confirmation; this function never mutates the supplied value.
 */
export function getHttpsUrlSuggestion(value: unknown): string | null {
  if (typeof value !== "string" || !value || /\s/u.test(value)) return null;
  if (value.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(value)) return null;

  const candidate = `https://${value}`;
  try {
    const URLConstructor = (globalThis as unknown as {
      URL: new (input: string) => { protocol: string; hostname: string };
    }).URL;
    const parsed = new URLConstructor(candidate);
    const hostname = parsed.hostname.toLowerCase();
    if (
      !hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local")
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}