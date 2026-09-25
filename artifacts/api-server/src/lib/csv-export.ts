/**
 * Small, streaming-friendly primitives for the BI CSV export.
 *
 * The worker can write `csvPreamble()`, `csvHeaderLine()`, and one
 * `csvRowLine()` at a time to a file or response; this module deliberately
 * does not accumulate an entire export in memory.
 */

export const BI_EXPORT_COLUMNS = [
  "email",
  "nome",
  "id_usuario",
  "regiao",
  "data_ultima_compra",
  "campanha_id",
  "campanha_nome",
  "is_lembrete",
  "status",
  "enviado_em",
  "entregue_em",
  "aberto_em",
  "clicado_em",
  "motivo_nao_envio",
] as const;

export type BiExportColumn = (typeof BI_EXPORT_COLUMNS)[number];

export type BiExportRow = {
  email: string | null;
  nome: string | null;
  id_usuario: string | number | null;
  regiao: string | null;
  data_ultima_compra: string | null;
  campanha_id: string | number | null;
  campanha_nome: string | null;
  is_lembrete: boolean | null;
  status: string | null;
  enviado_em: string | Date | null;
  entregue_em: string | Date | null;
  aberto_em: string | Date | null;
  clicado_em: string | Date | null;
  motivo_nao_envio: string | null;
};

/** UTF-8 BOM, required for Excel to detect accents reliably. */
export const CSV_UTF8_BOM = "\uFEFF";

const LINE_ENDING = "\r\n";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function nullableValue(value: unknown): string {
  return value == null ? "" : String(value);
}

/**
 * Normalize an instant to an explicit UTC ISO-8601 timestamp.
 * Date-only values are intentionally not passed through this function.
 */
export function normalizeExportTimestamp(value: string | Date | null): string {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Data inválida para exportação: ${String(value)}`);
  }
  return date.toISOString();
}

/** Keep calendar dates unchanged; they do not represent an instant in time. */
export function normalizeExportDate(value: string | null): string {
  if (value == null || value === "") return "";
  if (!DATE_ONLY.test(value)) {
    throw new RangeError(`Data de calendário inválida para exportação: ${value}`);
  }
  return value;
}

export function csvPreamble(): string {
  return CSV_UTF8_BOM;
}

export function csvHeaderLine(): string {
  return BI_EXPORT_COLUMNS.map(csvField).join(",") + LINE_ENDING;
}

export function csvRowLine(row: BiExportRow): string {
  const values = [
    row.email?.trim().toLowerCase() ?? "",
    nullableValue(row.nome),
    nullableValue(row.id_usuario),
    nullableValue(row.regiao),
    normalizeExportDate(row.data_ultima_compra),
    nullableValue(row.campanha_id),
    nullableValue(row.campanha_nome),
    row.is_lembrete == null ? "" : String(row.is_lembrete),
    nullableValue(row.status),
    normalizeExportTimestamp(row.enviado_em),
    normalizeExportTimestamp(row.entregue_em),
    normalizeExportTimestamp(row.aberto_em),
    normalizeExportTimestamp(row.clicado_em),
    nullableValue(row.motivo_nao_envio),
  ];

  return values.map(csvField).join(",") + LINE_ENDING;
}