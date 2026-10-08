import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import {
  inspectCampaignCsvHeader,
  suggestCampaignCsvMapping,
} from "./campaign-csv-header.ts";

for (const { separator, label } of [
  { separator: ",", label: "vírgula" },
  { separator: ";", label: "ponto e vírgula" },
  { separator: "\t", label: "tabulação" },
] as const) {
  test(`inspects a ${label}-separated header`, async () => {
    const file = new File(
      [`user_name${separator}user_email${separator}last_order_date`],
      "contatos.csv",
      { type: "text/csv" },
    );
    const inspection = await inspectCampaignCsvHeader(file);

    assert.equal(inspection.separator, separator);
    assert.equal(inspection.separatorDetected, true);
    assert.deepEqual(inspection.columns, [
      "user_name",
      "user_email",
      "last_order_date",
    ]);
  });
}

test("removes a UTF-8 BOM and samples the first three logical CSV rows", async () => {
  const file = new File(
    [
      "\uFEFFEmail,Nome,Observação\r\n" +
        'ana@example.com,Ana,"texto, com vírgula"\r\n' +
        "bia@example.com,Bia,normal\n" +
        "cris@example.com,Cris,normal\n" +
        "dora@example.com,Dora,fora da amostra",
    ],
    "export.csv",
    { type: "text/csv" },
  );
  const inspection = await inspectCampaignCsvHeader(file);

  assert.equal(inspection.columns[0], "Email");
  assert.deepEqual(inspection.samples, [
    ["ana@example.com", "Ana", "texto, com vírgula"],
    ["bia@example.com", "Bia", "normal"],
    ["cris@example.com", "Cris", "normal"],
  ]);
});

test("normalizes common email header spellings for auto-suggestions", () => {
  for (const header of ["E-mail", "email", "EMAIL", "e_mail"]) {
    assert.equal(suggestCampaignCsvMapping([header])[0], "email", header);
  }
});

test("does not guess an email column and prefers last access over account creation", () => {
  assert.deepEqual(
    suggestCampaignCsvMapping([
      "ID do usuário",
      "Nome",
      "Data de criação da conta",
      "Data do último acesso",
      "Telefone",
      "Cidade do último acesso",
    ]),
    ["user_id", "name", "ignore", "reference_date", "phone", "region"],
  );
  assert.equal(suggestCampaignCsvMapping(["Contato"])[0], "ignore");
});

test("rejects an excessively long header instead of sending truncated headers", async () => {
  const file = new File(
    [`user_name;user_email;${"x".repeat(1024 * 1024)}`],
    "large-header.csv",
    { type: "text/csv" },
  );

  await assert.rejects(
    inspectCampaignCsvHeader(file),
    /ultrapassa 500 caracteres/u,
  );
});
