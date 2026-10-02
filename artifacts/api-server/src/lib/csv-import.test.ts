import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { getPublicImportValidationErrorMessage, ImportValidationError, normalizePhone, validateAndImportCsv, suggestEmailDomain } from "./csv-import.ts";

function streamFromText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function emptyImportClient(onUpsert?: (rows: unknown[]) => void) {
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
        upsert: async (rows: unknown[]) => {
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
      "nome,email\nPessoa,ana\u200B\u00A0@ex\u2060ample.com",
    ),
    campaignId: "00000000-0000-0000-0000-000000000001",
    storagePath: "campaign/invisible-email.csv",
    deduplicatePhone: false,
  });

  assert.equal(summary.invalidos, 0);
  assert.equal(summary.validos, 1);
  assert.equal((savedRows[0] as { email: string }).email, "ana@example.com");
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
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof ImportValidationError);
  assert.match(thrown.message, /ponto e vírgula \(;\)/u);
  assert.match(thrown.message, /Colunas encontradas: user_email \| user_phone/u);
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