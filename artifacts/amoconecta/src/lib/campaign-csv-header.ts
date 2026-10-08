export type CampaignCsvSeparator = "," | ";" | "\t";

export type CampaignCsvHeaderInspection = {
  separator: CampaignCsvSeparator;
  separatorDetected: boolean;
  separatorLabel: string;
  headerComplete: boolean;
  columns: string[];
  samples: string[][];
};

export type CampaignCsvImportTarget =
  | "email"
  | "name"
  | "phone"
  | "user_id"
  | "region"
  | "reference_date"
  | "ignore";

const MAX_HEADER_BYTES = 1024 * 1024;
const MAX_HEADER_LENGTH = 500;

function findFirstCsvRecords(
  text: string,
  maxRecords: number,
): { records: string[]; headerComplete: boolean } {
  let quoted = false;
  let recordStart = 0;
  const records: string[] = [];
  let headerComplete = false;
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
      if (record.trim()) {
        records.push(record);
        if (records.length === 1) headerComplete = true;
        if (records.length >= maxRecords) return { records, headerComplete };
      }
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      recordStart = index + 1;
    }
  }
  const lastRecord = text.slice(recordStart);
  if (lastRecord.trim() && records.length < maxRecords) records.push(lastRecord);
  return { records, headerComplete };
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

function parseCsvRecord(record: string, separator: CampaignCsvSeparator): string[] {
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
  return columns;
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

function matchesAny(header: string, aliases: string[]): boolean {
  return aliases.includes(header);
}

export function suggestCampaignCsvMapping(
  headers: string[],
): CampaignCsvImportTarget[] {
  const normalized = headers.map(normalizeHeader);
  const mapping: CampaignCsvImportTarget[] = headers.map(() => "ignore");
  const assigned = new Set<CampaignCsvImportTarget>();
  const fields: Array<{
    target: Exclude<CampaignCsvImportTarget, "ignore" | "reference_date">;
    aliases: string[];
  }> = [
    {
      target: "email",
      aliases: [
        "email", "e mail", "email address", "endereco de email",
        "endereco email", "user email",
      ],
    },
    {
      target: "name",
      aliases: ["nome", "nome completo", "name", "full name", "user name", "cliente"],
    },
    {
      target: "phone",
      aliases: ["telefone", "celular", "phone", "phone number", "mobile", "whatsapp", "user phone"],
    },
    {
      target: "user_id",
      aliases: ["id", "id usuario", "id do usuario", "user id", "user identifier", "identificador do usuario"],
    },
    {
      target: "region",
      aliases: ["regiao", "region", "cidade", "city", "location", "last order region", "cidade do ultimo acesso"],
    },
  ];
  for (const field of fields) {
    const index = normalized.findIndex((header, candidateIndex) =>
      mapping[candidateIndex] === "ignore" &&
      matchesAny(header, field.aliases),
    );
    if (index >= 0 && !assigned.has(field.target)) {
      mapping[index] = field.target;
      assigned.add(field.target);
    }
  }

  const dateCandidates = normalized
    .map((header, index) => {
      if (
        matchesAny(header, [
          "last access", "last accessed", "last access date", "last login",
          "last login date", "data do ultimo acesso", "data ultimo acesso",
          "ultimo acesso", "data do ultimo login", "ultimo login",
        ])
      ) return { index, rank: 0 };
      if (
        matchesAny(header, [
          "last order date", "data ultima compra", "ultima compra",
          "data compra", "purchase date", "last purchase", "data da compra",
        ])
      ) return { index, rank: 1 };
      if (
        matchesAny(header, [
          "data de criacao da conta", "data criacao conta", "account creation date",
          "account created", "created at", "creation date", "data de cadastro",
        ])
      ) return { index, rank: 2 };
      if (matchesAny(header, ["data", "date", "reference date", "data de referencia"])) {
        return { index, rank: 3 };
      }
      return null;
    })
    .filter((candidate): candidate is { index: number; rank: number } => candidate !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const dateCandidate = dateCandidates[0];
  if (dateCandidate && !assigned.has("reference_date")) {
    mapping[dateCandidate.index] = "reference_date";
  }
  return mapping;
}

export async function inspectCampaignCsvHeader(
  file: File,
): Promise<CampaignCsvHeaderInspection> {
  const bytesToRead = Math.min(file.size, MAX_HEADER_BYTES);
  const text = (await file.slice(0, bytesToRead).text()).replace(/^\uFEFF/u, "");
  const parsedRecords = findFirstCsvRecords(text, 4);
  const rawHeader = parsedRecords.records[0] ?? "";
  const detection = detectSeparator(rawHeader);
  const parsedColumns = rawHeader.trim()
    ? parseCsvRecord(rawHeader, detection.separator)
    : [];
  if (parsedColumns.some((column) => column.length > MAX_HEADER_LENGTH)) {
    throw new Error("Um dos cabeçalhos do CSV ultrapassa 500 caracteres.");
  }
  const columns = parsedColumns.map((column) => column.replace(/\s+/gu, " "));
  const samples = parsedRecords.records
    .slice(1, 4)
    .map((record) =>
      parseCsvRecord(record, detection.separator)
        .map((value) => value.slice(0, 200)),
    );
  return {
    separator: detection.separator,
    separatorDetected: detection.detected,
    separatorLabel: separatorLabel(
      detection.separator,
      detection.detected,
    ),
    headerComplete:
      file.size <= bytesToRead || parsedRecords.headerComplete,
    columns,
    samples,
  };
}