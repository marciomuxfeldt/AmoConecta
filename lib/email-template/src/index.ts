import { getHttpsUrlSuggestion, isStrictHttpsUrl } from "./https-url";

export type EmailBlockType = "text" | "image" | "button" | "divider";

export type TextBlock = {
  id: string;
  type: "text";
  html: string;
};

export type ImageBlock = {
  id: string;
  type: "image";
  src: string;
  alt: string;
  href?: string;
};

export type ButtonBlock = {
  id: string;
  type: "button";
  label: string;
  href: string;
};

export type DividerBlock = {
  id: string;
  type: "divider";
};

export type EmailBlock = TextBlock | ImageBlock | ButtonBlock | DividerBlock;

export type EmailButtonDestinationIssue = {
  blockId: string;
  index: number;
  kind: "missing" | "invalid" | "test-domain";
  message: string;
};

export type EmailPreviewOptions = {
  name?: string | null;
  valorCredito?: number | null;
  validadeCredito?: string | null;
  unsubscribeUrl?: string;
  reason?: string;
  preheader?: string | null;
  /** Campaign button background, as a hex CSS color. */
  buttonColor?: string;
};

export type EmailBlockUrlIssue = {
  blockId: string;
  index: number;
  field: string;
  message: string;
  suggestion?: string;
};

const ALLOWED_TAGS = new Set(["strong", "b", "em", "i", "a", "br"]);
const DEFAULT_UNSUBSCRIBE_URL = "#descadastro";
const DEFAULT_REASON =
  "Você está recebendo este e-mail porque se cadastrou para receber comunicações da Amo Ofertas.";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(value: string | undefined, fallback = "#"): string {
  return value && isStrictHttpsUrl(value) ? value : fallback;
}

function readAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(
    new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "iu"),
  );
  return match?.[1] ?? null;
}

export function sanitizeRichTextHtml(value: string): string {
  let html = value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style|iframe|object|embed|form|svg|math)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<(?!\/?(?:strong|b|em|i|a|br)\b)[^>]*>/giu, "");

  html = html.replace(/<\s*(strong|b|em|i|br)\b[^>]*>/giu, "<$1>");
  html = html.replace(/<\s*\/\s*(strong|b|em|i)\s*>/giu, "</$1>");
  html = html.replace(/<\s*a\b([^>]*)>/giu, (_, attributes: string) => {
    const href = safeUrl(readAttribute(attributes, "href") ?? undefined);
    return href === "#" ? "<span>" : `<a href="${escapeHtml(href)}">`;
  });
  html = html.replace(/<\s*\/\s*a\s*>/giu, "</a>");
  html = html.replace(/<span>/giu, "");
  html = html.replace(/<\/span>/giu, "");
  return html;
}

function formatCredit(value: number | null | undefined): string {
  return value == null
    ? ""
    : new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(value);
}

function formatCreditExpiry(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? ""
    : new Intl.DateTimeFormat("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed);
}

function replaceTemplateTokens(
  value: string,
  options: EmailPreviewOptions,
  escapeValues: boolean,
): string {
  const replacement = (raw: string): string => (escapeValues ? escapeHtml(raw) : raw);
  const name = options.name?.trim() ?? "";
  const credit = formatCredit(options.valorCredito);
  const expiry = formatCreditExpiry(options.validadeCredito);
  let result = value
    .replace(/\{\{\s*nome\s*\}\}/giu, name ? replacement(name) : "{{nome}}")
    .replace(/\{\{\s*valor_credito\s*\}\}/giu, replacement(credit))
    .replace(/\{\{\s*validade_credito\s*\}\}/giu, replacement(expiry));

  if (!name) {
    result = result
      .replace(/\s*(?:[,;:–—-]\s*)?\{\{\s*nome\s*\}\}/giu, "")
      .replace(/\{\{\s*nome\s*\}\}/giu, "");
  }
  return result;
}

function replaceNameToken(value: string, name: string | null | undefined): string {
  return replaceTemplateTokens(value, { name }, true)
    .replace(/\s{2,}/gu, " ")
    .trim();
}

const DEFAULT_BUTTON_COLOR = "#e96527";

function normalizeButtonColor(value: string | undefined): string {
  return typeof value === "string" && /^#[\da-f]{3}(?:[\da-f]{3})?$/iu.test(value)
    ? value
    : DEFAULT_BUTTON_COLOR;
}

function relativeLuminance(hex: string): number {
  const normalized = hex.slice(1);
  const channels = normalized.length === 3
    ? normalized.split("").map((part) => Number.parseInt(part + part, 16))
    : [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
  const luminance = channels
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance;
}

function readableButtonTextColor(background: string): "#ffffff" | "#1f2937" {
  const luminance = relativeLuminance(background);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / (relativeLuminance("#1f2937") + 0.05);
  return whiteContrast >= 4.5 || whiteContrast >= darkContrast ? "#ffffff" : "#1f2937";
}

export function interpolateName(value: string, name?: string | null): string {
  return replaceNameToken(value, name);
}

function renderText(block: TextBlock, options: EmailPreviewOptions): string {
  const safeHtml = sanitizeRichTextHtml(block.html);
  return replaceTemplateTokens(safeHtml, options, true);
}

function renderBlock(block: EmailBlock, options: EmailPreviewOptions): string {
  if (block.type === "text") {
    return `<tr><td style="padding:0 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#263044;">${renderText(block, options)}</td></tr>`;
  }

  if (block.type === "image") {
    const src = safeUrl(block.src);
    if (src === "#") return "";
    const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;" />`;
    return `<tr><td style="padding:0 32px 24px;text-align:center;">${block.href ? `<a href="${escapeHtml(safeUrl(block.href))}" style="text-decoration:none;">${image}</a>` : image}</td></tr>`;
  }

  if (block.type === "button") {
    const buttonColor = normalizeButtonColor(options.buttonColor);
    const buttonTextColor = readableButtonTextColor(buttonColor);
    return `<tr><td style="padding:0 32px 24px;text-align:center;"><a href="${escapeHtml(safeUrl(block.href))}" style="display:inline-block;background-color:${buttonColor};color:${buttonTextColor};font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;line-height:20px;padding:12px 22px;text-decoration:none;border-radius:6px;">${replaceTemplateTokens(block.label, options, true)}</a></td></tr>`;
  }

  return '<tr><td style="padding:0 32px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e5ddd0;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>';
}

export function renderEmailHtml(
  blocks: EmailBlock[],
  options: EmailPreviewOptions = {},
): string {
  const unsubscribeUrl = safeUrl(options.unsubscribeUrl, DEFAULT_UNSUBSCRIBE_URL);
  const reason = escapeHtml(options.reason?.trim() || DEFAULT_REASON);
  const preheader = options.preheader?.trim().slice(0, 100);
  const hiddenPreheader = preheader
    ? `<div style="display:none!important;font-size:1px;line-height:1px;color:#f4f0e9;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(replaceTemplateTokens(preheader, options, false))}</div>`
    : "";
  const body = blocks.map((block) => renderBlock(block, options)).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Amo Ofertas</title></head><body style="margin:0;padding:0;background-color:#f4f0e9;">${hiddenPreheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f4f0e9;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#fffdf9;"><tr><td style="padding:30px 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:#247b79;">Amo Ofertas</td></tr>${body}<tr><td style="padding:20px 32px 28px;border-top:1px solid #e5ddd0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#777984;text-align:center;">${reason}<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#247b79;text-decoration:underline;">Descadastrar-se</a></td></tr></table></td></tr></table></body></html>`;
}

function htmlToPlainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6])>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function interpolateEmailText(
  value: string,
  options: EmailPreviewOptions = {},
): string {
  return replaceTemplateTokens(value, options, false);
}

export function renderEmailText(
  blocks: EmailBlock[],
  options: EmailPreviewOptions = {},
): string {
  const lines: string[] = [];
  const preheader = options.preheader?.trim();
  if (preheader) lines.push(interpolateEmailText(preheader.slice(0, 100), options));

  for (const block of blocks) {
    if (block.type === "text") {
      const html = sanitizeRichTextHtml(block.html);
      const text = htmlToPlainText(interpolateEmailText(html, options));
      if (text) lines.push(text);
    } else if (block.type === "button") {
      const label = interpolateEmailText(block.label, options).trim();
      if (label) lines.push(`${label}: ${safeUrl(block.href)}`);
    } else if (block.type === "image" && block.alt.trim()) {
      lines.push(interpolateEmailText(block.alt.trim(), options));
    }
  }

  lines.push(options.reason?.trim() || DEFAULT_REASON);
  lines.push(`Descadastrar-se: ${safeUrl(options.unsubscribeUrl, DEFAULT_UNSUBSCRIBE_URL)}`);
  return lines.join("\n\n");
}

export function normalizeEmailBlocks(value: unknown): EmailBlock[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate, index): EmailBlock[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const block = candidate as Record<string, unknown>;
    const id = typeof block.id === "string" && block.id ? block.id : `block-${index + 1}`;

    if (block.type === "text" && typeof block.html === "string") {
      return [{ id, type: "text", html: sanitizeRichTextHtml(block.html) }];
    }
    if (
      block.type === "image" &&
      typeof block.src === "string" &&
      typeof block.alt === "string"
    ) {
      return [
        {
          id,
          type: "image",
          src: safeUrl(block.src),
          alt: block.alt.slice(0, 160),
          ...(typeof block.href === "string" ? { href: safeUrl(block.href) } : {}),
        },
      ];
    }
    if (
      block.type === "button" &&
      typeof block.label === "string" &&
      typeof block.href === "string"
    ) {
      return [
        {
          id,
          type: "button",
          label: block.label.slice(0, 120),
          href: block.href.trim(),
        },
      ];
    }
    if (block.type === "divider") return [{ id, type: "divider" }];
    return [];
  });
}

const TEST_BUTTON_HOSTS = ["example.com", "example.org", "localhost"] as const;

export function validateEmailButtonDestinations(
  value: unknown,
): EmailButtonDestinationIssue[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate, arrayIndex): EmailButtonDestinationIssue[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return [];
    }
    const block = candidate as Record<string, unknown>;
    if (block.type !== "button") return [];

    const index = arrayIndex + 1;
    const blockId =
      typeof block.id === "string" && block.id
        ? block.id
        : `block-${index}`;
    const label = typeof block.label === "string" ? block.label.trim().slice(0, 80) : "";
    const identity = label ? `botão ${index} (“${label}”)` : `botão ${index}`;
    const href = typeof block.href === "string" ? block.href.trim() : "";

    if (!href) {
      return [{
        blockId,
        index,
        kind: "missing",
        message: `O ${identity} está sem destino.`,
      }];
    }

    if (!isStrictHttpsUrl(href)) {
      return [{
        blockId,
        index,
        kind: "invalid",
        message: `O ${identity} precisa de uma URL válida e segura começando com https://.`,
      }];
    }

    const URLConstructor = (globalThis as unknown as {
      URL: new (value: string) => { hostname: string };
    }).URL;
    const url = new URLConstructor(href);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const testHost = TEST_BUTTON_HOSTS.find(
      (host) => hostname === host || hostname.endsWith(`.${host}`),
    );
    if (testHost) {
      return [{
        blockId,
        index,
        kind: "test-domain",
        message: `O ${identity} usa o domínio de teste ${testHost}; informe um destino real.`,
      }];
    }

    return [];
  });
}

/**
 * Checks URL-bearing block fields without changing the supplied blocks.
 * Bare hostnames receive a suggestion, but callers must explicitly confirm
 * and apply it.
 */
export function validateEmailBlockUrls(value: unknown): EmailBlockUrlIssue[] {
  if (!Array.isArray(value)) return [];

  const issues: EmailBlockUrlIssue[] = [];
  const addIssue = (block: Record<string, unknown>, index: number, field: string, value: unknown) => {
    if (isStrictHttpsUrl(value)) return;
    const blockId = typeof block.id === "string" && block.id ? block.id : `block-${index}`;
    const suggestion = getHttpsUrlSuggestion(value);
    issues.push({
      blockId,
      index,
      field,
      message: `O campo ${field} precisa de uma URL válida e segura começando com https://.`,
      ...(suggestion ? { suggestion } : {}),
    });
  };

  value.forEach((candidate, arrayIndex) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
    const block = candidate as Record<string, unknown>;
    const index = arrayIndex + 1;
    if (block.type === "button") {
      addIssue(block, index, "href", block.href);
    } else if (block.type === "image") {
      addIssue(block, index, "src", block.src);
      if (typeof block.href === "string") addIssue(block, index, "href", block.href);
    } else if (block.type === "text" && typeof block.html === "string") {
      const anchorPattern = /<\s*a\b([^>]*)>/giu;
      let match: RegExpExecArray | null;
      while ((match = anchorPattern.exec(block.html)) !== null) {
        const href = readAttribute(match[1], "href");
        addIssue(block, index, "html.href", href);
      }
    }
  });
  return issues;
}

export function isEmailBlockType(value: unknown): value is EmailBlockType {
  return value === "text" || value === "image" || value === "button" || value === "divider";
}