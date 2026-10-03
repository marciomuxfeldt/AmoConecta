import type { EmailBlock } from "@workspace/email-template";

const amountPattern = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;

function parseAmount(value: string): number | null {
  const normalized = value.includes(",")
    ? value.replaceAll(".", "").replace(",", ".")
    : /^\d{1,3}(?:\.\d{3})+$/u.test(value)
      ? value.replaceAll(".", "")
      : value;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function creditContentWarning(
  blocks: EmailBlock[],
  valorCredito: number | null | undefined,
): string | null {
  const visibleText = blocks
    .map((block) => block.type === "text" ? block.html : block.type === "button" ? block.label : block.type === "image" ? block.alt : "")
    .join(" ")
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ");
  const usesCreditToken = /\{\{\s*valor_credito\s*\}\}/iu.test(visibleText);
  const amountRegex = new RegExp(`R\\$\\s*(${amountPattern})`, "giu");
  const writtenAmounts = Array.from(visibleText.matchAll(amountRegex), (match) => parseAmount(match[1]!));
  const writtenReaisRegex = new RegExp(`\\b(${amountPattern})\\s+reais?\\b`, "giu");
  writtenAmounts.push(...Array.from(visibleText.matchAll(writtenReaisRegex), (match) => parseAmount(match[1]!)));
  const amounts = writtenAmounts.filter((value): value is number => value !== null);
  const expectedAmount = valorCredito == null ? null : Math.round(valorCredito * 100);

  if (valorCredito == null) {
    if (amounts.length > 0) {
      return `O corpo menciona ${formatCurrency(amounts[0]!)} em crédito, mas o campo “Valor do crédito” está vazio. Preencha o campo ou ajuste o texto.`;
    }
    if (usesCreditToken) {
      return "O corpo usa {{valor_credito}}, mas o campo “Valor do crédito” está vazio. Preencha o campo ou remova a variável.";
    }
    return null;
  }

  const mismatchedAmount = amounts.find((amount) => Math.round(amount * 100) !== expectedAmount);
  if (mismatchedAmount !== undefined) {
    return `O campo “Valor do crédito” está em ${formatCurrency(valorCredito)}, mas o corpo menciona ${formatCurrency(mismatchedAmount)}. Confira se os dois valores correspondem.`;
  }
  if (amounts.length === 0 && !usesCreditToken) {
    return `O campo “Valor do crédito” está preenchido (${formatCurrency(valorCredito)}), mas o corpo não informa um valor em reais nem usa {{valor_credito}}. Confira se o campo e a mensagem estão alinhados.`;
  }
  return null;
}