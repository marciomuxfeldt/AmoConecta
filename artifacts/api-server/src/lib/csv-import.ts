import type { SupabaseClient } from "@supabase/supabase-js";

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

export type ImportSummary = {
  storage_path: string;
  total_linhas: number;
  validos: number;
  invalidos: number;
  novos: number;
  atualizados: number;
  duplicados_no_arquivo: number;
  duplicados_email: number;
  duplicados_telefone: number;
  suprimidos: number;
  emails_invalidos: number;
  datas_invalidas: number;
  nomes_ausentes: number;
  telefones_invalidos: number;
  destinatarios_salvos: number;
  recencia: Array<{ faixa: string; quantidade: number }>;
  amostras_erros: ImportError[];
};

type CsvRecord = {
  values: string[];
  line: number;
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

function normalizeEmail(value: string): string {
  return value.trim().replace(/\s+/g, "").toLocaleLowerCase("pt-BR");
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

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(value);
}

function parseDate(value: string): { date: string | null; invalid: boolean } {
  const input = value.trim();
  if (!input) return { date: null, invalid: false };

  let day: number;
  let month: number;
  let year: number;
  const iso = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u);
  const numeric = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/u);
  const writtenInput = input
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
  const writtenWithTime = writtenInput.match(
    /^(\d{1,2})\s+([a-z]+),\s*(\d{4}),\s*\d{1,2}:\d{2}$/u,
  );
  const written = writtenInput.match(
    /^(\d{1,2})\s+(?:de\s+)?([a-z]+)(?:\s+de)?\s+(\d{4})$/u,
  );

  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (numeric) {
    day = Number(numeric[1]);
    month = Number(numeric[2]);
    year = Number(numeric[3]);
  } else if (writtenWithTime || written) {
    const match = writtenWithTime ?? written;
    if (!match) return { date: null, invalid: true };
    day = Number(match[1]);
    month = MONTHS[match[2]];
    year = Number(match[3]);
  } else {
    return { date: null, invalid: true };
  }

  if (!month || year < 1900 || year > 2200) {
    return { date: null, invalid: true };
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return { date: null, invalid: true };
  }
  return {
    date: `${year.toString().padStart(4, "0")}-${month
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
    invalid: false,
  };
}

function recencyBucket(date: string | null): string {
  if (!date) return "sem data";
  const today = new Date();
  const current = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
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

function resolveHeader(headers: string[], aliases: string[]): number {
  const normalizedAliases = aliases.map(headerKey);
  return headers.findIndex((header) => normalizedAliases.includes(header));
}

function addError(summary: ImportSummary, line: number, reason: string): void {
  if (summary.amostras_erros.length < MAX_ERROR_SAMPLES) {
    summary.amostras_erros.push({ linha: line, motivo: reason });
  }
}

function parseCsvRecord(record: string): string[] {
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
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  return values.map((item) => item.trim());
}

async function* recordsFromStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<CsvRecord> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

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
          if (raw.trim()) yield { values: parseCsvRecord(raw), line: recordLine };
          line += 1;
          recordLine = line;
          recordStart = index + 1;
        }
      }
      pending = pending.slice(recordStart);
    }
    pending += decoder.decode();
    if (pending.trim()) yield { values: parseCsvRecord(pending), line: recordLine };
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

function buildSummary(storagePath: string): ImportSummary {
  return {
    storage_path: storagePath,
    total_linhas: 0,
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
    nomes_ausentes: 0,
    telefones_invalidos: 0,
    destinatarios_salvos: 0,
    recencia: RECENCY_BUCKETS.map((faixa) => ({ faixa, quantidade: 0 })),
    amostras_erros: [],
  };
}

export async function validateAndImportCsv({
  client,
  stream,
  campaignId,
  storagePath,
  deduplicatePhone,
  onProgress,
}: {
  client: SupabaseClient;
  stream: ReadableStream<Uint8Array>;
  campaignId: string;
  storagePath: string;
  deduplicatePhone: boolean;
  onProgress?: (linesProcessed: number) => Promise<void>;
}): Promise<ImportSummary> {
  const summary = buildSummary(storagePath);
  const suppression = await loadSuppression(client);
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
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
    throw new ImportValidationError("O CSV está vazio.");
  }

  const headers = first.value.values.map(headerKey);
  const displayHeaders = first.value.values
    .map((value) => value.replace(/^\uFEFF/u, "").trim())
    .filter(Boolean);
  const userIdIndex = resolveHeader(headers, ["user_id", "id"]);
  const nameIndex = resolveHeader(headers, [
    "user_name",
    "nome",
    "nome completo",
    "name",
    "cliente",
  ]);
  const emailIndex = resolveHeader(headers, ["user_email", "email", "e mail", "e-mail"]);
  const phoneIndex = resolveHeader(headers, [
    "user_phone",
    "telefone",
    "celular",
    "phone",
    "whatsapp",
  ]);
  const regionIndex = resolveHeader(headers, ["last_order_region", "regiao", "região"]);
  const purchaseDateIndex = resolveHeader(headers, [
    "last_order_date",
    "data ultima compra",
    "ultima compra",
    "data compra",
    "data",
  ]);

  if (nameIndex < 0 || emailIndex < 0) {
    const missing = [
      nameIndex < 0 ? "nome (user_name)" : null,
      emailIndex < 0 ? "e-mail (user_email)" : null,
    ].filter((value): value is string => Boolean(value));
    throw new ImportValidationError(
      `Colunas obrigatórias ausentes: ${missing.join(", ")}. ` +
        `Colunas encontradas: ${displayHeaders.length > 0 ? displayHeaders.join(", ") : "(nenhuma)"}.`,
    );
  }

  const existingEmails = await loadExistingCampaignEmails(client, campaignId);
  let block: ImportRow[] = [];
  let blockNewCount = 0;
  let blockUpdatedCount = 0;
  const flush = async () => {
    if (block.length === 0) return;
    const { error } = await client.from("destinatario").upsert(block, {
      onConflict: "campanha_id,email,is_lembrete",
    });
    if (error) throw error;
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
    const rawName = record.values[nameIndex] ?? "";
    const rawEmail = record.values[emailIndex] ?? "";
    const rawPhone = phoneIndex >= 0 ? record.values[phoneIndex] ?? "" : "";
    const rawRegion = regionIndex >= 0 ? record.values[regionIndex] ?? "" : "";
    const rawDate =
      purchaseDateIndex >= 0 ? record.values[purchaseDateIndex] ?? "" : "";
    const idUsuario = rawUserId.trim() || null;
    const email = normalizeEmail(rawEmail);
    const normalizedName = normalizeName(rawName);
    const nome = normalizedName || fallbackName(email);
    const telefone = rawPhone.trim() ? normalizePhone(rawPhone) : null;
    const regiao = rawRegion.trim() || null;
    const parsedDate = parseDate(rawDate);

    if (!normalizedName) {
      summary.nomes_ausentes += 1;
    }
    if (!isValidEmail(email)) {
      summary.emails_invalidos += 1;
      summary.invalidos += 1;
      addError(summary, record.line, "e-mail ausente ou inválido");
      await reportProgress();
      continue;
    }
    if (rawPhone.trim() && !telefone) {
      summary.telefones_invalidos += 1;
    }
    if (parsedDate.invalid) {
      summary.datas_invalidas += 1;
    }
    if (suppression.emails.has(email) || (telefone && suppression.phones.has(telefone))) {
      summary.suprimidos += 1;
      addError(summary, record.line, "destinatário presente na supressão");
      await reportProgress();
      continue;
    }
    if (seenEmails.has(email)) {
      summary.duplicados_no_arquivo += 1;
      summary.duplicados_email += 1;
      await reportProgress();
      continue;
    }
    if (deduplicatePhone && telefone && seenPhones.has(telefone)) {
      summary.duplicados_no_arquivo += 1;
      summary.duplicados_telefone += 1;
      await reportProgress();
      continue;
    }

    seenEmails.add(email);
    if (telefone) seenPhones.add(telefone);
    summary.validos += 1;
    const faixa = recencyBucket(parsedDate.date);
    const bucket = summary.recencia.find((item) => item.faixa === faixa);
    if (bucket) bucket.quantidade += 1;
    block.push({
      campanha_id: campaignId,
      id_usuario: idUsuario,
      nome,
      email,
      telefone,
      regiao,
      data_ultima_compra: parsedDate.date,
    });
    if (existingEmails.has(email)) {
      blockUpdatedCount += 1;
    } else {
      blockNewCount += 1;
    }
    if (block.length >= BLOCK_SIZE) {
      await flush();
    }
    await reportProgress();
  }
  await flush();
  if (onProgress && summary.total_linhas > lastReportedLines) {
    await onProgress(summary.total_linhas);
  }
  return summary;
}