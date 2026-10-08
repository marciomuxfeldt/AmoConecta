import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { normalizeEmail } from "./email-normalization";

export { normalizeEmail } from "./email-normalization";

const BLOCK_SIZE = 5_000;
const EXISTING_EMAIL_PAGE_SIZE = 1_000;
const MAX_ERROR_SAMPLES = 20;

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const RECENCY_BUCKETS = [
  "até 30 dias",
  "31 a 90 dias",
  "91 a 180 dias",
  "181 a 365 dias",
  "mais de 365 dias",
  "sem data",
] as const;

type ImportRow = {
  campanha_id: string;
  id_usuario: string | null;
  nome: string | null;
  email: string;
  telefone: string | null;
  regiao: string | null;
  data_ultima_compra: string | null;
};

type ImportCandidate = {
  row: ImportRow;
  line: number;
  purchaseDate: string | null;
  rawReferenceDate: string;
  referenceDateInvalid: boolean;
};

export const IMPORT_COLUMN_TARGETS = [
  "email",
  "name",
  "phone",
  "user_id",
  "region",
  "reference_date",
  "ignore",
] as const;
export type ImportColumnTarget = (typeof IMPORT_COLUMN_TARGETS)[number];

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

type ImportError = {
  linha: number;
  motivo: string;
};

type ImportSample = {
  linha: number;
  valor: string;
  email?: string;
};

export type ImportSummary = {
  storage_path: string;
  total_linhas: number;
  linhas_importadas: number;
  linhas_descartadas: number;
  colunas_ignoradas: number;
  data_referencia_rotulo: string;
  validos: number;
  invalidos: number;
  novos: number;
  atualizados: number;
  duplicados_no_arquivo: number;
  duplicados_email: number;
  duplicados_telefone: number;
  suprimidos: number;
  total_na_lista?: number;
  suprimidos_no_envio?: number;
  receberao_de_fato?: number;
  emails_invalidos: number;
  datas_invalidas: number;
  datas_ausentes: number;
  datas_ausentes_percentual: number;
  dominios_suspeitos_total: number;
  dominios_suspeitos: Array<{ linha: number; email: string; sugestao: string }>;
  nomes_ausentes: number;
  telefones_invalidos: number;
  destinatarios_salvos: number;
  recencia: Array<{ faixa: string; quantidade: number }>;
  amostras_erros: ImportError[];
  amostras_emails_invalidos: ImportSample[];
  amostras_datas_invalidas: ImportSample[];
  amostras_datas_ausentes: ImportSample[];
};

type CsvRecord = {
  values: string[];
  line: number;
  separator: CsvSeparator;
  separatorDetected: boolean;
};

type CsvSeparator = "," | ";" | "\t";

type CsvSeparatorDetection = {
  separator: CsvSeparator;
  detected: boolean;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeName(value: string): string {
  const particles = new Set(["a", "as", "da", "das", "de", "do", "dos", "e"]);
  return value
    .trim()
    .toLocaleLowerCase("pt-BR")
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      if (index > 0 && particles.has(word)) return word;
      return word
        .split(/([-'])/)
        .map((part) =>
          part === "-" || part === "'"
            ? part
            : part.charAt(0).toLocaleUpperCase("pt-BR") + part.slice(1),
        )
        .join("");
    })
    .join(" ");
}

export function hasEmailFormattingCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}\u00A0]/u.test(value) || /\s/u.test(value.trim());
}

export function isSafeEmailForExternalValidation(value: string): boolean {
  const normalized = normalizeEmail(value);
  return (
    !hasEmailFormattingCharacters(value) &&
    /^[\x00-\x7F]*$/u.test(normalized) &&
    isValidEmail(normalized)
  );
}

function fallbackName(email: string): string | null {
  const localPart = email.split("@", 1)[0] ?? "";
  const parts = localPart.split(/[._-]/u);
  if (
    parts.length < 2 ||
    parts.some((part) => !/^\p{L}{2,}$/u.test(part))
  ) {
    return null;
  }
  return normalizeName(parts.join(" ")) || null;
}

export function normalizePhone(value: string): string | null {
  let digits = value.replace(/\D/g, "");
  if (digits.length > 11 && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  digits = digits.replace(/^0+/u, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function isValidEmail(value: string): boolean {
  return (
    /^[\x00-\x7F]+$/u.test(value) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(value)
  );
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (!month || year < 1900 || year > 2200) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function formatSaoPauloDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseReferenceDate(
  value: string,
): { date: string | null; invalid: boolean } {
  const input = value.trim();
  if (!input) return { date: null, invalid: false };

  let day: number;
  let month: number;
  let year: number;
  const zonedIso = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/u,
  );
  if (zonedIso) {
    const isoYear = Number(zonedIso[1]);
    const isoMonth = Number(zonedIso[2]);
    const isoDay = Number(zonedIso[3]);
    const hour = Number(zonedIso[4]);
    const minute = Number(zonedIso[5]);
    const second = Number(zonedIso[6] ?? 0);
    const instant = new Date(input);
    if (
      !validCalendarDate(isoYear, isoMonth, isoDay) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      !Number.isFinite(instant.getTime())
    ) {
      return { date: null, invalid: true };
    }
    return { date: formatSaoPauloDate(instant), invalid: false };
  }

  const naiveIso = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u,
  );
  if (naiveIso) {
    const isoYear = Number(naiveIso[1]);
    const isoMonth = Number(naiveIso[2]);
    const isoDay = Number(naiveIso[3]);
    if (
      !validCalendarDate(isoYear, isoMonth, isoDay) ||
      Number(naiveIso[4]) > 23 ||
      Number(naiveIso[5]) > 59 ||
      Number(naiveIso[6] ?? 0) > 59
    ) {
      return { date: null, invalid: true };
    }
    return {
      date: `${naiveIso[1]}-${naiveIso[2]}-${naiveIso[3]}`,
      invalid: false,
    };
  }

  const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
  const numeric = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/u);
  const writtenInput = input
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const written = writtenInput.match(
    /^(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+de)?(?:,\s*|\s+)(\d{4})(?:,\s*\d{1,2}:\d{2})?$/u,
  );

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else if (written) {
    day = Number(written[1]);
    month = MONTHS[written[2]];
    year = Number(written[3]);
  } else {
    return { date: null, invalid: true };
  }

  if (!validCalendarDate(year, month, day)) return { date: null, invalid: true };
  return {
    date: `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    invalid: false,
  };
}

function recencyBucket(date: string | null): string {
  if (!date) return "sem data";
  const todayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) =>
    todayParts.find((item) => item.type === type)?.value ?? "0";
  const current = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
  );
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  const days = Math.max(0, Math.floor((current - parsed) / 86_400_000));
  if (days <= 30) return "até 30 dias";
  if (days <= 90) return "31 a 90 dias";
  if (days <= 180) return "91 a 180 dias";
  if (days <= 365) return "181 a 365 dias";
  return "mais de 365 dias";
}

function headerKey(value: string): string {
  return normalizeText(value.replace(/^\uFEFF/u, ""));
}

export function campaignImportHeaderSignature(headers: readonly string[]): string {
  const normalized = headers.map(headerKey);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function addError(summary: ImportSummary, line: number, reason: string): void {
  if (summary.amostras_erros.length < MAX_ERROR_SAMPLES) {
    summary.amostras_erros.push({ linha: line, motivo: reason });
  }
}

function detectCsvSeparator(record: string): CsvSeparatorDetection {
  const counts: Record<CsvSeparator, number> = {
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

  let separator: CsvSeparator = ",";
  for (const candidate of [",", ";", "\t"] as const) {
    if (counts[candidate] > counts[separator]) separator = candidate;
  }
  return { separator, detected: counts[separator] > 0 };
}

function describeCsvSeparator({
  separator,
  separatorDetected,
}: Pick<CsvRecord, "separator" | "separatorDetected">): string {
  if (!separatorDetected) return "não identificado (padrão: vírgula)";
  if (separator === ",") return "vírgula (,)";
  if (separator === ";") return "ponto e vírgula (;)";
  return "tabulação (TAB)";
}

function formatFoundHeaders(headers: string[]): string {
  if (headers.length === 0) return "(nenhuma)";
  const visible = headers.slice(0, 40).map((header) =>
    header.replace(/\s+/gu, " ").slice(0, 120),
  );
  const remaining = headers.length - visible.length;
  return `${visible.join(" | ")}${remaining > 0 ? ` | … (+${remaining})` : ""}`;
}

function parseCsvRecord(record: string, separator: CsvSeparator): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < record.length; index += 1) {
    const character = record[index];
    if (character === '"') {
      if (quoted && record[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === separator && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values.map((item) => item.trim());
}

export async function* recordsFromStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CsvRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let separator: CsvSeparator | null = null;
  let separatorDetected = false;
  let firstRecord = true;
  const parseRecord = (raw: string, recordNumber: number): CsvRecord => {
    if (separator === null) {
      const detection = detectCsvSeparator(raw);
      separator = detection.separator;
      separatorDetected = detection.detected;
    }
    const resolvedSeparator = separator ?? ",";
    const values = parseCsvRecord(raw, resolvedSeparator);
    if (firstRecord) {
      values[0] = (values[0] ?? "").replace(/^\uFEFF/u, "");
      firstRecord = false;
    }
    return {
      values,
      line: recordNumber,
      separator: resolvedSeparator,
      separatorDetected,
    };
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let recordStart = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const character = pending[index];
        if (character === '"' && pending[index - 1] !== "\\") {
          if (inQuotes && pending[index + 1] === '"') {
            index += 1;
            continue;
          }
          inQuotes = !inQuotes;
        }
        if (character === "\n" && !inQuotes) {
          const raw = pending.slice(recordStart, index).replace(/\r$/u, "");
          if (raw.trim()) yield parseRecord(raw, recordLine);
          line += 1;
          recordLine = line;
          recordStart = index + 1;
        }
      }
      pending = pending.slice(recordStart);
    }
    pending += decoder.decode();
    if (pending.trim()) yield parseRecord(pending, recordLine);
  } finally {
    reader.releaseLock();
  }
}

async function loadSuppression(
  client: SupabaseClient,
): Promise<{ emails: Set<string>; phones: Set<string> }> {
  const { data, error } = await client
    .from("supressao")
    .select("email,telefone");
  if (error) throw error;
  return {
    emails: new Set(
      (data ?? [])
        .map((row) => (typeof row.email === "string" ? normalizeEmail(row.email) : null))
        .filter((value): value is string => Boolean(value)),
    ),
    phones: new Set(
      (data ?? [])
        .map((row) => (typeof row.telefone === "string" ? normalizePhone(row.telefone) : null))
        .filter((value): value is string => Boolean(value)),
    ),
  };
}

async function loadExistingCampaignEmails(
  client: SupabaseClient,
  campaignId: string,
): Promise<Set<string>> {
  const emails = new Set<string>();
  for (let offset = 0; ; offset += EXISTING_EMAIL_PAGE_SIZE) {
    const { data, error } = await client
      .from("destinatario")
      .select("email")
      .eq("campanha_id", campaignId)
      .eq("is_lembrete", false)
      .order("id", { ascending: true })
      .range(offset, offset + EXISTING_EMAIL_PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (typeof row.email === "string") {
        emails.add(normalizeEmail(row.email));
      }
    }
    if (!data || data.length < EXISTING_EMAIL_PAGE_SIZE) break;
  }
  return emails;
}

function buildSummary(
  storagePath: string,
  referenceDateLabel: string,
  ignoredColumns: number,
): ImportSummary {
  return {
    storage_path: storagePath,
    total_linhas: 0,
    linhas_importadas: 0,
    linhas_descartadas: 0,
    colunas_ignoradas: ignoredColumns,
    data_referencia_rotulo: referenceDateLabel,
    validos: 0,
    invalidos: 0,
    novos: 0,
    atualizados: 0,
    duplicados_no_arquivo: 0,
    duplicados_email: 0,
    duplicados_telefone: 0,
    suprimidos: 0,
    emails_invalidos: 0,
    datas_invalidas: 0,
    datas_ausentes: 0,
    datas_ausentes_percentual: 0,
    dominios_suspeitos_total: 0,
    dominios_suspeitos: [],
    nomes_ausentes: 0,
    telefones_invalidos: 0,
    destinatarios_salvos: 0,
    recencia: RECENCY_BUCKETS.map((faixa) => ({ faixa, quantidade: 0 })),
    amostras_erros: [],
    amostras_emails_invalidos: [],
    amostras_datas_invalidas: [],
    amostras_datas_ausentes: [],
  };
}

export async function validateAndImportCsv({
  client,
  stream,
  campaignId,
  storagePath,
  deduplicatePhone,
  expectedHeaders,
  columnMapping,
  referenceDateLabel,
  previewOnly = false,
  beforeCommit,
  onProgress,
}: {
  client: SupabaseClient;
  stream: ReadableStream<Uint8Array>;
  campaignId: string;
  storagePath: string;
  deduplicatePhone: boolean;
  expectedHeaders: string[];
  columnMapping: ImportColumnTarget[];
  referenceDateLabel: string;
  previewOnly?: boolean;
  beforeCommit?: () => Promise<void>;
  onProgress?: (linesProcessed: number) => Promise<void>;
}): Promise<ImportSummary> {
  const summary = buildSummary(
    storagePath,
    referenceDateLabel,
    columnMapping.filter((target) => target === "ignore").length,
  );
  const suppression = await loadSuppression(client);
  const candidates: ImportCandidate[] = [];
  const iterator = recordsFromStream(stream);
  let lastReportedLines = 0;
  const reportProgress = async () => {
    if (
      onProgress &&
      summary.total_linhas - lastReportedLines >= BLOCK_SIZE
    ) {
      lastReportedLines = summary.total_linhas;
      await onProgress(lastReportedLines);
    }
  };
  const first = await iterator.next();
  if (first.done || first.value.values.length === 0) {
    throw new ImportValidationError(
      "O CSV está vazio ou sem cabeçalho. " +
        "Separador detectado: não identificado (arquivo sem cabeçalho). " +
        "Colunas encontradas: (nenhuma).",
    );
  }

  const cleanHeaders = first.value.values.map((value, index) =>
    index === 0 ? value.replace(/^\uFEFF/u, "") : value,
  );
  const headers = cleanHeaders.map(headerKey);
  const displayHeaders = first.value.values
    .map((value) => value.replace(/^\uFEFF/u, "").trim())
    ;

  if (
    expectedHeaders.length !== cleanHeaders.length ||
    campaignImportHeaderSignature(expectedHeaders) !==
      campaignImportHeaderSignature(cleanHeaders)
  ) {
    throw new ImportValidationError(
      "O cabeçalho do arquivo mudou depois da leitura. Selecione o CSV novamente. " +
        `Separador detectado: ${describeCsvSeparator(first.value)}. ` +
        `Colunas encontradas: ${formatFoundHeaders(displayHeaders)}.`,
    );
  }
  if (columnMapping.length !== cleanHeaders.length) {
    throw new ImportValidationError(
      "O mapeamento não corresponde às colunas do arquivo. Selecione o CSV novamente.",
    );
  }
  const targetIndexes = new Map<ImportColumnTarget, number>();
  for (const [index, target] of columnMapping.entries()) {
    if (!IMPORT_COLUMN_TARGETS.includes(target)) {
      throw new ImportValidationError("O mapeamento contém um campo desconhecido.");
    }
    if (target !== "ignore" && targetIndexes.has(target)) {
      throw new ImportValidationError(
        "Cada campo pode ser associado a apenas uma coluna do CSV.",
      );
    }
    if (target !== "ignore") targetIndexes.set(target, index);
  }
  const emailIndex = targetIndexes.get("email") ?? -1;
  if (emailIndex < 0) {
    throw new ImportValidationError(
      "Escolha qual coluna contém o e-mail antes de importar.",
    );
  }
  const userIdIndex = targetIndexes.get("user_id") ?? -1;
  const nameIndex = targetIndexes.get("name") ?? -1;
  const phoneIndex = targetIndexes.get("phone") ?? -1;
  const regionIndex = targetIndexes.get("region") ?? -1;
  const referenceDateIndex = targetIndexes.get("reference_date") ?? -1;

  const existingEmails = await loadExistingCampaignEmails(client, campaignId);
  let block: ImportRow[] = [];
  let blockNewCount = 0;
  let blockUpdatedCount = 0;
  const flush = async () => {
    if (block.length === 0) return;
    if (!previewOnly) {
      const { error } = await client.from("destinatario").upsert(block, {
        onConflict: "campanha_id,email,is_lembrete",
      });
      if (error) throw error;
    }
    summary.novos += blockNewCount;
    summary.atualizados += blockUpdatedCount;
    summary.destinatarios_salvos = summary.novos;
    block = [];
    blockNewCount = 0;
    blockUpdatedCount = 0;
  };

  for await (const record of iterator) {
    summary.total_linhas += 1;
    const rawUserId = userIdIndex >= 0 ? record.values[userIdIndex] ?? "" : "";
    const rawName = nameIndex >= 0 ? record.values[nameIndex] ?? "" : "";
    const rawEmail = record.values[emailIndex] ?? "";
    const rawPhone = phoneIndex >= 0 ? record.values[phoneIndex] ?? "" : "";
    const rawRegion = regionIndex >= 0 ? record.values[regionIndex] ?? "" : "";
    const rawDate =
      referenceDateIndex >= 0 ? record.values[referenceDateIndex] ?? "" : "";
    const idUsuario = rawUserId.trim() || null;
    const email = normalizeEmail(rawEmail);
    const normalizedName = normalizeName(rawName);
    const nome = normalizedName || fallbackName(email);
    const telefone = rawPhone.trim() ? normalizePhone(rawPhone) : null;
    const regiao = rawRegion.trim() || null;
    const parsedDate = parseReferenceDate(rawDate);
    if (!normalizedName) {
      summary.nomes_ausentes += 1;
    }
    if (!isValidEmail(email)) {
      summary.emails_invalidos += 1;
      summary.invalidos += 1;
      if (summary.amostras_emails_invalidos.length < 3) {
        summary.amostras_emails_invalidos.push({
          linha: record.line,
          valor: rawEmail.trim() || "(vazio)",
        });
      }
      addError(
        summary,
        record.line,
        `e-mail ausente ou inválido: ${email || "(vazio após limpeza)"}`,
      );
      await reportProgress();
      continue;
    }
    if (rawPhone.trim() && !telefone) {
      summary.telefones_invalidos += 1;
    }
    const suggestion = suggestEmailDomain(email);
    if (suggestion) {
      summary.dominios_suspeitos_total += 1;
      if (summary.dominios_suspeitos.length < 200) {
        summary.dominios_suspeitos.push({ linha: record.line, email, sugestao: suggestion });
      }
    }
    if (suppression.emails.has(email) || (telefone && suppression.phones.has(telefone))) {
      summary.suprimidos += 1;
      addError(summary, record.line, "destinatário presente na supressão");
      await reportProgress();
      continue;
    }
    candidates.push({
      line: record.line,
      purchaseDate: parsedDate.date,
      rawReferenceDate: rawDate.trim(),
      referenceDateInvalid: parsedDate.invalid,
      row: {
        campanha_id: campaignId,
        id_usuario: idUsuario,
        nome,
        email,
        telefone,
        regiao,
        data_ultima_compra: parsedDate.date,
      },
    });
    await reportProgress();
  }

  const isMoreRecent = (
    candidate: ImportCandidate,
    current: ImportCandidate,
  ): boolean => {
    if (candidate.purchaseDate && current.purchaseDate) {
      return candidate.purchaseDate > current.purchaseDate;
    }
    return Boolean(candidate.purchaseDate && !current.purchaseDate);
  };

  const phoneWinners = new Map<string, ImportCandidate>();
  const candidatesWithoutPhone: ImportCandidate[] = [];
  for (const candidate of candidates) {
    const phone = candidate.row.telefone;
    if (!deduplicatePhone || !phone) {
      candidatesWithoutPhone.push(candidate);
      continue;
    }
    const current = phoneWinners.get(phone);
    if (!current) {
      phoneWinners.set(phone, candidate);
      continue;
    }
    summary.duplicados_no_arquivo += 1;
    summary.duplicados_telefone += 1;
    if (isMoreRecent(candidate, current)) {
      phoneWinners.set(phone, candidate);
    }
  }

  const phoneSelected = deduplicatePhone
    ? [...phoneWinners.values(), ...candidatesWithoutPhone]
    : candidates;
  const selected: ImportCandidate[] = [];
  const selectedEmails = new Set<string>();
  for (const candidate of phoneSelected) {
    if (selectedEmails.has(candidate.row.email)) {
      summary.duplicados_no_arquivo += 1;
      summary.duplicados_email += 1;
      continue;
    }
    selectedEmails.add(candidate.row.email);
    selected.push(candidate);
  }

  if (!previewOnly && beforeCommit && selected.length > 0) await beforeCommit();

  for (const candidate of selected) {
    summary.validos += 1;
    if (!candidate.rawReferenceDate) {
      summary.datas_ausentes += 1;
      if (summary.amostras_datas_ausentes.length < 3) {
        summary.amostras_datas_ausentes.push({
          linha: candidate.line,
          valor: "",
          email: candidate.row.email,
        });
      }
    } else if (candidate.referenceDateInvalid) {
      summary.datas_invalidas += 1;
      if (summary.amostras_datas_invalidas.length < 3) {
        summary.amostras_datas_invalidas.push({
          linha: candidate.line,
          valor: candidate.rawReferenceDate,
          email: candidate.row.email,
        });
      }
    }
    const faixa = recencyBucket(candidate.purchaseDate);
    const bucket = summary.recencia.find((item) => item.faixa === faixa);
    if (bucket) bucket.quantidade += 1;
    block.push(candidate.row);
    if (existingEmails.has(candidate.row.email)) {
      blockUpdatedCount += 1;
    } else {
      blockNewCount += 1;
    }
    if (block.length >= BLOCK_SIZE) {
      await flush();
    }
  }
  await flush();
  summary.linhas_importadas = summary.novos + summary.atualizados;
  summary.linhas_descartadas = Math.max(
    0,
    summary.total_linhas - summary.linhas_importadas,
  );
  summary.datas_ausentes_percentual = summary.total_linhas > 0
    ? summary.datas_ausentes / summary.total_linhas * 100
    : 0;
  if (onProgress && summary.total_linhas > lastReportedLines) {
    await onProgress(summary.total_linhas);
  }
  return summary;
}

const KNOWN_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.br",
  "outlook.com", "outlook.com.br", "live.com", "live.com.br", "msn.com",
  "yahoo.com", "yahoo.com.br", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "bol.com.br", "uol.com.br",
];

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const different = [...a].map((char, index) => char === b[index] ? -1 : index).filter((i) => i >= 0);
    return different.length === 1 || (different.length === 2 &&
      different[1] === different[0]! + 1 &&
      a[different[0]!] === b[different[1]!] && a[different[1]!] === b[different[0]!]);
  }
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i += 1;
  return shorter.slice(i) === longer.slice(i + 1);
}

export function suggestEmailDomain(email: string): string | null {
  const normalized = normalizeEmail(email);
  const index = normalized.lastIndexOf("@");
  if (index < 0) return null;
  const domain = normalized.slice(index + 1);
  if (KNOWN_EMAIL_DOMAINS.includes(domain)) return null;
  const suggestion = domain === "gmail.com.br" ? "gmail.com"
    : KNOWN_EMAIL_DOMAINS.find((candidate) => oneEditApart(domain, candidate));
  return suggestion ? `${normalized.slice(0, index)}@${suggestion}` : null;
}

export function getPublicImportValidationErrorMessage(
  persistedError: unknown,
): string | null {
  if (typeof persistedError !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(persistedError);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      record.name !== "ImportValidationError" ||
      typeof record.message !== "string"
    ) {
      return null;
    }
    return record.message;
  } catch {
    return null;
  }
}