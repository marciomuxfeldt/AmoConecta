import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { campaignImportHeaderSignature, getPublicImportValidationErrorMessage, ImportValidationError, normalizeEmail, normalizePhone, parseReferenceDate, suggestEmailDomain, validateAndImportCsv as validateCsvWithMapping, type ImportColumnTarget } from "./csv-import.ts";

const UNLABELED_REFERENCE_DATE = "Data de referência (sem rótulo)";

type TestCsvStream = ReadableStream<Uint8Array> & { testCsvSource: string };

function streamFromText(value: string): TestCsvStream {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
  return Object.assign(stream, { testCsvSource: value });
}

function testTarget(header: string): ImportColumnTarget {
  const normalized = header
    .replace(/^\uFEFF/u, "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (["email", "e mail", "user email"].includes(normalized)) return "email";
  if (["nome", "name", "user name"].includes(normalized)) return "name";
  if (["telefone", "phone", "user phone"].includes(normalized)) return "phone";
  if (["id", "user id"].includes(normalized)) return "user_id";
  if (["region", "regiao", "last order region"].includes(normalized)) return "region";
  if (
    ["last order date", "data ultima compra", "data_ultima_compra", "date"].includes(
      normalized,
    )
  ) return "reference_date";
  return "ignore";
}

type TestImportOptions = Omit<
  Parameters<typeof validateCsvWithMapping>[0],
  "expectedHeaders" | "columnMapping" | "referenceDateLabel"
> & Partial<
  Pick<
    Parameters<typeof validateCsvWithMapping>[0],
    "expectedHeaders" | "columnMapping" | "referenceDateLabel"
  >
>;

async function validateAndImportCsv(options: TestImportOptions) {
  const firstRecord =
    options.stream instanceof ReadableStream
      ? (options.stream as TestCsvStream).testCsvSource
          .replace(/^\uFEFF/u, "")
          .split(/\r\n|\n|\r/u, 1)[0] ?? ""
      : "";
  const separator = firstRecord.includes(";")
    ? ";"
    : firstRecord.includes("\t")
      ? "\t"
      : ",";
  const parsedHeaders = firstRecord.split(separator);
  return validateCsvWithMapping({
    ...options,
    expectedHeaders: options.expectedHeaders ?? parsedHeaders,
    columnMapping:
      options.columnMapping ?? parsedHeaders.map((header) => testTarget(header)),
    referenceDateLabel: options.referenceDateLabel ?? UNLABELED_REFERENCE_DATE,
  });
}

function emptyImportClient(
  onUpsert?: (rows: Array<Record<string, unknown>>) => void,
) {
  return {
    from(table: string) {
      if (table === "supressao") {
        return {
          select: async () => ({ data: [], error: null }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              order: () => ({
                range: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
        upsert: async (rows: Array<Record<string, unknown>>) => {
          onUpsert?.(rows);
          return { error: null };
        },
      };
    },
  };
}

test("counts all missing dates without rejecting rows or silently correcting typo domains", async () => {
  const savedRows: unknown[] = [];
  const summary = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText("nome,email,last_order_date\nAna,a@gnail.com,\nBia,b@outllok.com,\nCris,c@gmail.com.br,2026-09-01"),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/warnings.csv", deduplicatePhone: false,
  });
  assert.equal(summary.datas_ausentes, 2);
  assert.equal(summary.datas_ausentes_percentual, 2 / 3 * 100);
  assert.equal(summary.validos, 3);
  assert.equal(summary.invalidos, 0);
  assert.deepEqual(summary.dominios_suspeitos.map((x) => x.sugestao), ["a@gmail.com", "b@outlook.com", "c@gmail.com"]);
  assert.deepEqual(savedRows.map((x) => (x as { email: string }).email), ["a@gnail.com", "b@outllok.com", "c@gmail.com.br"]);
  assert.equal(suggestEmailDomain("a@yahoo.com.br"), null);
  assert.equal(suggestEmailDomain("a@corporate.example"), null);
  assert.equal(suggestEmailDomain("a@gamil.com"), "a@gmail.com");
});

test("normalizes Brazilian phone variants to one comparison key", () => {
  assert.equal(normalizePhone("049988154909"), "49988154909");
  assert.equal(normalizePhone("55 (49) 98815-4909"), "49988154909");
  assert.equal(normalizePhone("+55.049988154909"), "49988154909");
  assert.equal(normalizePhone("00049 98815 4909"), "49988154909");
});

test("does not treat duplicate rows as invalid or validation errors", async () => {
  const summary = await validateAndImportCsv({
    client: emptyImportClient() as never,
    stream: streamFromText(
      [
        "nome,email,telefone",
        "Ana,ana@example.com,049988154909",
        "Bia,bia@example.com,49988154909",
        "Sem email,,11999999999",
      ].join("\n"),
    ),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/file.csv",
    deduplicatePhone: true,
  });

  assert.equal(summary.duplicados_telefone, 1);
  assert.equal(summary.duplicados_no_arquivo, 1);
  assert.equal(summary.invalidos, 1);
  assert.equal(summary.emails_invalidos, 1);
  assert.equal(summary.amostras_erros.length, 1);
  assert.equal(
    summary.amostras_erros[0]?.motivo,
    "e-mail ausente ou inválido: (vazio após limpeza)",
  );
});

test("removes invisible controls from e-mail before validating and saving", async () => {
  const savedRows: unknown[] = [];
  const summary = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText(
      "nome,email\nPessoa,\u0001\uFEFFANA\u200B@EX\u2060AMPLE.COM\uFEFF",
    ),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/invisible-email.csv",
    deduplicatePhone: false,
  });

  assert.equal(summary.invalidos, 0);
  assert.equal(summary.validos, 1);
  assert.equal((savedRows[0] as { email: string }).email, "ana@example.com");
});

test("trims only edge whitespace and rejects, rather than rewriting, internal whitespace", async () => {
  assert.equal(normalizeEmail("  joao silva@gmail.com\u00A0"), "joao silva@gmail.com");
  const savedRows: unknown[] = [];
  const summary = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText("nome,email\nPessoa,joao silva@gmail.com"),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/internal-space-email.csv",
    deduplicatePhone: false,
  });

  assert.equal(summary.invalidos, 1);
  assert.equal(summary.emails_invalidos, 1);
  assert.equal(summary.validos, 0);
  assert.equal(savedRows.length, 0);
  assert.equal(
    summary.amostras_erros[0]?.motivo,
    "e-mail ausente ou inválido: joao silva@gmail.com",
  );
});

test("rejects remaining non-ASCII e-mails and includes the address in the sample", async () => {
  const savedRows: unknown[] = [];
  const summary = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText("nome,email\nPessoa,jöhn@example.com"),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/non-ascii-email.csv",
    deduplicatePhone: false,
  });

  assert.equal(summary.emails_invalidos, 1);
  assert.equal(summary.invalidos, 1);
  assert.equal(summary.validos, 0);
  assert.equal(savedRows.length, 0);
  assert.equal(
    summary.amostras_erros[0]?.motivo,
    "e-mail ausente ou inválido: jöhn@example.com",
  );
});

test("matches the reference file totals after phone normalization", async () => {
  const uniqueCount = 18_145;
  const duplicateCount = 1_420;
  const rows = ["nome,email,telefone"];

  for (let index = 0; index < uniqueCount; index += 1) {
    const phone = String(49_900_000_000 + index);
    rows.push(`Pessoa ${index},pessoa-${index}@example.com,${phone}`);
  }
  for (let index = 0; index < duplicateCount; index += 1) {
    const phone = String(49_900_000_000 + index);
    rows.push(`Pessoa repetida ${index},repetida-${index}@example.com,0${phone}`);
  }

  const summary = await validateAndImportCsv({
    client: emptyImportClient() as never,
    stream: streamFromText(rows.join("\n")),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/reference.csv",
    deduplicatePhone: true,
  });

  assert.equal(summary.total_linhas, 19_565);
  assert.equal(summary.validos, 18_145);
  assert.equal(summary.duplicados_telefone, 1_420);
  assert.equal(summary.duplicados_no_arquivo, 1_420);
  assert.equal(summary.invalidos, 0);
  assert.equal(summary.amostras_erros.length, 0);
});

test("keeps the newest valid purchase date when phones collide", async () => {
  const savedRows: unknown[] = [];
  const summary = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText(
      [
        "nome,email,telefone,data_ultima_compra",
        "Pessoa antiga,antiga@example.com,49999990010,2025-01-15",
        "Pessoa nova,nova@example.com,(49) 99999-0010,2026-02-20",
      ].join("\n"),
    ),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/newest.csv",
    deduplicatePhone: true,
  });

  assert.equal(summary.validos, 1);
  assert.equal(summary.duplicados_telefone, 1);
  assert.equal(summary.duplicados_no_arquivo, 1);
  assert.equal(savedRows.length, 1);
  assert.equal((savedRows[0] as { email: string }).email, "nova@example.com");
  assert.equal(
    (savedRows[0] as { data_ultima_compra: string }).data_ultima_compra,
    "2026-02-20",
  );
});

for (const { separator, label } of [
  { separator: ",", label: "vírgula" },
  { separator: ";", label: "ponto e vírgula" },
  { separator: "\t", label: "tabulação" },
] as const) {
  test(`detects CSV fields separated by ${label}`, async () => {
    const savedRows: unknown[] = [];
    const summary = await validateAndImportCsv({
      client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
      stream: streamFromText(
        [
          `user_name${separator}user_email${separator}user_phone`,
          `"Ana, Maria"${separator}ana@example.com${separator}49999990010`,
        ].join("\r\n"),
      ),
      campaignId: "00000000-0000-0000-0000-000000000001",
      storagePath: `campaign/${label}.csv`,
      deduplicatePhone: false,
    });

    assert.equal(summary.validos, 1);
    assert.equal(savedRows.length, 1);
    assert.equal((savedRows[0] as { nome: string }).nome, "Ana, Maria");
    assert.equal(
      (savedRows[0] as { email: string }).email,
      "ana@example.com",
    );
  });
}

test("reports the detected separator and found columns for missing headers", async () => {
  let thrown: unknown;
  try {
    await validateAndImportCsv({
      client: emptyImportClient() as never,
      stream: streamFromText(
        "user_email;user_phone\r\nana@example.com;49999990010",
      ),
      campaignId: "00000000-0000-0000-0000-000000000001",
      storagePath: "campaign/missing-name.csv",
      deduplicatePhone: false,
      columnMapping: ["ignore", "phone"],
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ImportValidationError);
  assert.match(thrown.message, /Escolha qual coluna contém o e-mail/u);
});

test("only exposes persisted parser-validation messages at the API boundary", () => {
  const safeMessage =
    "Colunas obrigatórias ausentes. Separador detectado: tabulação (TAB).";
  assert.equal(
    getPublicImportValidationErrorMessage(
      JSON.stringify({ name: "ImportValidationError", message: safeMessage }),
    ),
    safeMessage,
  );
  assert.equal(
    getPublicImportValidationErrorMessage(
      JSON.stringify({ name: "PostgrestError", message: "internal detail" }),
    ),
    null,
  );
  assert.equal(getPublicImportValidationErrorMessage("not-json"), null);
});

test("parses Brazilian written dates and converts ISO offsets to the São Paulo calendar day", () => {
  assert.equal(parseReferenceDate("31 julho, 2026, 13:48").date, "2026-07-31");
  assert.equal(parseReferenceDate("31 de julho de 2026").date, "2026-07-31");
  assert.equal(parseReferenceDate("31 de março de 2026").date, "2026-03-31");
  assert.equal(parseReferenceDate("31 de marco de 2026").date, "2026-03-31");
  assert.equal(parseReferenceDate("2026-08-01T01:00:00Z").date, "2026-07-31");
  assert.equal(parseReferenceDate("2026-08-01T01:00:00-03:00").date, "2026-08-01");
  assert.equal(parseReferenceDate("31 de fevereiro de 2026").date, null);
});

test("preflight reports invalid and missing reference dates without writing rows", async () => {
  const savedRows: Array<Record<string, unknown>> = [];
  const result = await validateAndImportCsv({
    client: emptyImportClient((rows) => savedRows.push(...rows)) as never,
    stream: streamFromText(
      "email,nome,date\n" +
        "bad-date@example.com,Data inválida,31 de fevereiro de 2026\n" +
        "missing-date@example.com,Data ausente,",
    ),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/date-preflight.csv",
    deduplicatePhone: false,
    expectedHeaders: ["email", "nome", "date"],
    columnMapping: ["email", "name", "reference_date"],
    referenceDateLabel: "Último acesso",
    previewOnly: true,
  });

  assert.equal(savedRows.length, 0);
  assert.equal(result.datas_invalidas, 1);
  assert.equal(result.datas_ausentes, 1);
  assert.deepEqual(result.amostras_datas_invalidas, [
    { linha: 2, valor: "31 de fevereiro de 2026", email: "bad-date@example.com" },
  ]);
  assert.deepEqual(result.amostras_datas_ausentes, [
    { linha: 3, valor: "", email: "missing-date@example.com" },
  ]);
});

test("imports a BOM-prefixed 484-row Portuguese export with Apple relays and a selected access date", async () => {
  const savedRows: Array<Record<string, unknown>> = [];
  const rows = Array.from({ length: 484 }, (_, index) => {
    const email =
      index < 23
        ? `relay${index}@privaterelay.appleid.com`
        : `contact${index}@example.com`;
    const phone = String(54991434483 + index);
    return `user-${index},Pessoa ${index},${email},${phone},sarandi,"31 julho, 2026, 13:48","31 julho, 2026, 12:19"`;
  });
  const csv = [
    "\uFEFFID do usuário,Nome,E-mail,Telefone,Cidade do último acesso,Data do último acesso,Data de criação da conta",
    ...rows,
  ].join("\n");
  const result = await validateAndImportCsv({
    client: emptyImportClient((batch) => savedRows.push(...batch)) as never,
    stream: streamFromText(csv),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/mapped-484.csv",
    deduplicatePhone: true,
    expectedHeaders: [
      "ID do usuário",
      "Nome",
      "E-mail",
      "Telefone",
      "Cidade do último acesso",
      "Data do último acesso",
      "Data de criação da conta",
    ],
    columnMapping: [
      "user_id",
      "name",
      "email",
      "phone",
      "region",
      "reference_date",
      "ignore",
    ],
    referenceDateLabel: "Último acesso",
  });

  assert.equal(result.validos, 484);
  assert.equal(result.novos, 484);
  assert.equal(result.linhas_importadas, 484);
  assert.equal(result.datas_invalidas, 0);
  assert.equal(savedRows.length, 484);
  assert.equal(
    savedRows.filter((row) =>
      String(row.email).endsWith("@privaterelay.appleid.com"),
    ).length,
    23,
  );
  assert.equal(savedRows[0].email, "relay0@privaterelay.appleid.com");
  assert.equal(savedRows[0].id_usuario, "user-0");
  assert.equal(savedRows[0].regiao, "sarandi");
  assert.equal(savedRows[0].nome, "Pessoa 0");
  assert.equal(savedRows[0].telefone, "54991434483");
  assert.equal(savedRows[0].data_ultima_compra, "2026-07-31");
});

test("header signatures are stable across case, accents, and surrounding whitespace", () => {
  assert.equal(
    campaignImportHeaderSignature(["E-mail", "Data do último acesso"]),
    campaignImportHeaderSignature(["E-MAIL", " Data do ultimo acesso "]),
  );
});