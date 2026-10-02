import assert from "node:assert/strict";
import test from "node:test";
import { emailsFromExclusionCsv } from "./recipient-exclusions";
import { deriveBiExportReason } from "./csv-export";

test("exclusion CSV accepts one email column, quotes, BOM, semicolon and deduplicates", async () => {
  assert.deepEqual(await emailsFromExclusionCsv('\uFEFFemail;origem\n"A@EXAMPLE.TEST";externo\na@example.test;externo\nb@example.test;externo'),
    ["a@example.test", "b@example.test"]);
});
test("invalid exclusion CSV rejects the entire operation", async () => {
  await assert.rejects(emailsFromExclusionCsv("email\nvalid@example.test\ninvalid"), /Nenhuma exclusão/);
  await assert.rejects(emailsFromExclusionCsv("nome\nAna"), /coluna email/);
  await assert.rejects(emailsFromExclusionCsv("email"), /não contém endereços/);
});
test("BI exclusion reason takes priority without changing pending status", () => {
  assert.equal(deriveBiExportReason("pendente", null, "2026-10-02", "validacao: externa"), "excluido: validacao: externa");
  assert.equal(deriveBiExportReason("pendente", null), "ainda não enviado");
});