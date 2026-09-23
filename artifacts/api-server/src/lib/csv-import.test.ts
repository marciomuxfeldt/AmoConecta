import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { normalizePhone, validateAndImportCsv } from "./csv-import.ts";

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
  assert.equal(summary.amostras_erros[0]?.motivo, "e-mail ausente ou inválido");
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