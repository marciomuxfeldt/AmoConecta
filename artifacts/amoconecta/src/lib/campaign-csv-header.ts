export type CampaignCsvSeparator = "," | ";" | "\t";

export type CampaignCsvHeaderInspection = {
  separator: CampaignCsvSeparator;
  separatorDetected: boolean;
  separatorLabel: string;
  headerComplete: boolean;
  columns: string[];
  hasLastOrderDate: boolean;
};

const MAX_HEADER_BYTES = 1024 * 1024;
const LAST_ORDER_DATE_HEADERS = new Set([
  "last order date",
  "data ultima compra",
  "ultima compra",
  "data compra",
  "data",
]);

function findFirstCsvRecord(text: string): string | null {
  let quoted = false;
  let recordStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === "\n" || character === "\r")) {
      const record = text.slice(recordStart, index);
      if (record.trim()) return record;
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      recordStart = index + 1;
    }
  }
  const lastRecord = text.slice(recordStart);
  return lastRecord.trim() ? lastRecord : null;
}

function detectSeparator(record: string): {
  separator: CampaignCsvSeparator;
  detected: boolean;
} {
  const counts: Record<CampaignCsvSeparator, number> = {
    ",": 0,
    ";": 0,
    "\t": 0,
  };
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && (character === "," || character === ";" || character === "\t")) {
      counts[character] += 1;
    }
  }

  let separator: CampaignCsvSeparator = ",";
  for (const candidate of [",", ";", "\t"] as const) {
    if (counts[candidate] > counts[separator]) separator = candidate;
  }
  return { separator, detected: counts[separator] > 0 };
}

function parseCsvHeader(record: string, separator: CampaignCsvSeparator): string[] {
  const columns: string[] = [];
  let column = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        column += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === separator) {
      columns.push(column.trim());
      column = "";
    } else {
      column += character;
    }
  }
  columns.push(column.trim());
  return columns.map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/u, "") : value,
  );
}

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[_-]+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function separatorLabel(
  separator: CampaignCsvSeparator,
  detected: boolean,
): string {
  if (!detected) return "não identificado (padrão: vírgula)";
  if (separator === ",") return "vírgula (,)";
  if (separator === ";") return "ponto e vírgula (;)";
  return "tabulação (TAB)";
}

export async function inspectCampaignCsvHeader(
  file: File,
): Promise<CampaignCsvHeaderInspection> {
  const bytesToRead = Math.min(file.size, MAX_HEADER_BYTES);
  const text = await file.slice(0, bytesToRead).text();
  const record = findFirstCsvRecord(text);
  const headerComplete =
    file.size <= bytesToRead || (record !== null && record !== text);
  const rawHeader = record ?? (headerComplete ? "" : text);
  const detection = detectSeparator(rawHeader);
  const parsedColumns = rawHeader.trim()
    ? parseCsvHeader(rawHeader, detection.separator).filter(Boolean)
    : [];
  const normalizedHeaders = new Set(parsedColumns.map(normalizeHeader));
  const columns = parsedColumns.map((column) =>
    column.replace(/\s+/gu, " ").slice(0, 120),
  );
  return {
    separator: detection.separator,
    separatorDetected: detection.detected,
    separatorLabel: separatorLabel(
      detection.separator,
      detection.detected,
    ),
    headerComplete,
    columns,
    hasLastOrderDate: [...LAST_ORDER_DATE_HEADERS].some((header) =>
      normalizedHeaders.has(header),
    ),
  };
}