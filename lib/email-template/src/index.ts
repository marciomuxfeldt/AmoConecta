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

export type EmailPreviewOptions = {
  name?: string | null;
  unsubscribeUrl?: string;
  reason?: string;
  preheader?: string | null;
};

const ALLOWED_TAGS = new Set(["strong", "b", "em", "i", "a", "br"]);
const DEFAULT_UNSUBSCRIBE_URL = "#descadastro";
const PREHEADER_PADDING = "&zwnj;&nbsp;".repeat(40);
const DEFAULT_REASON =
  "Você está recebendo este e-mail porque se cadastrou para receber comunicações da AmoConecta.";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeUrl(value: string | undefined, fallback = "#"): string {
  return value && /^(?:https?):\/\/[^\s]+$/iu.test(value) ? value : fallback;
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

function replaceNameToken(value: string, name: string | null | undefined): string {
  if (name?.trim()) {
    return value.replace(/\{\{\s*nome\s*\}\}/giu, escapeHtml(name.trim()));
  }

  return value
    .replace(/\s*(?:[,;:–—-]\s*)?\{\{\s*nome\s*\}\}/giu, "")
    .replace(/\{\{\s*nome\s*\}\}/giu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export function interpolateName(value: string, name?: string | null): string {
  return replaceNameToken(value, name);
}

function renderText(block: TextBlock, name?: string | null): string {
  const safeHtml = sanitizeRichTextHtml(block.html);
  return replaceNameToken(safeHtml, name);
}

function renderBlock(block: EmailBlock, name?: string | null): string {
  if (block.type === "text") {
    return `<tr><td style="padding:0 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#263044;">${renderText(block, name)}</td></tr>`;
  }

  if (block.type === "image") {
    const src = safeUrl(block.src);
    if (src === "#") return "";
    const image = `<img src="${escapeHtml(src)}" alt="${escapeHtml(block.alt)}" width="536" style="display:block;width:100%;max-width:536px;height:auto;border:0;" />`;
    return `<tr><td style="padding:0 32px 24px;text-align:center;">${block.href ? `<a href="${escapeHtml(safeUrl(block.href))}" style="text-decoration:none;">${image}</a>` : image}</td></tr>`;
  }

  if (block.type === "button") {
    return `<tr><td style="padding:0 32px 24px;text-align:center;"><a href="${escapeHtml(safeUrl(block.href))}" style="display:inline-block;background-color:#e96527;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;line-height:20px;padding:12px 22px;text-decoration:none;border-radius:6px;">${escapeHtml(block.label)}</a></td></tr>`;
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
    ? `<div style="display:none!important;font-size:1px;line-height:1px;color:#f4f0e9;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}${PREHEADER_PADDING}</div>`
    : "";
  const body = blocks.map((block) => renderBlock(block, options.name)).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AmoConecta</title></head><body style="margin:0;padding:0;background-color:#f4f0e9;">${hiddenPreheader}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f4f0e9;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#fffdf9;"><tr><td style="padding:30px 32px 24px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:#247b79;">AmoConecta</td></tr>${body}<tr><td style="padding:20px 32px 28px;border-top:1px solid #e5ddd0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#777984;text-align:center;">${reason}<br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#247b79;text-decoration:underline;">Descadastrar-se</a></td></tr></table></td></tr></table></body></html>`;
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
          href: safeUrl(block.href),
        },
      ];
    }
    if (block.type === "divider") return [{ id, type: "divider" }];
    return [];
  });
}

export function isEmailBlockType(value: unknown): value is EmailBlockType {
  return value === "text" || value === "image" || value === "button" || value === "divider";
}