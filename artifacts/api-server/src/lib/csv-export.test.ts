import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { BI_EXPORT_COLUMNS, CSV_UTF8_BOM, csvHeaderLine, csvPreamble, csvRowLine, deriveBiExportReason } from "./csv-export.ts";

test("derives the BI export reason from recipient status and error text", () => {
  const cases: Array<[string, string | null, string | null]> = [
    ["suprimido", null, "suprimido"],
    ["bounce", null, "bounce permanente"],
    ["erro", "falha do provedor", "falha do provedor"],
    ["bloqueado_modo_teste", null, "bloqueado pelo modo de teste"],
    ["bloqueado_desengajado", null, "bloqueado por desengajamento"],
    ["pendente", null, "ainda não enviado"],
    ["processando", null, "ainda não enviado"],
    ["enviado", null, ""],
    ["entregue", null, ""],
    ["aberto", null, ""],
    ["clicado", null, ""],
  ];

  for (const [status, error, expected] of cases) {
    assert.equal(deriveBiExportReason(status, error), expected, status);
  }
  assert.equal(deriveBiExportReason("erro", null), null);
  assert.equal(deriveBiExportReason("estado_desconhecido", null), null);
});

test("emits a UTF-8 BOM and the exact BI header order", () => {
  assert.equal(csvPreamble(), CSV_UTF8_BOM);
  assert.equal(
    csvHeaderLine(),
    `"${BI_EXPORT_COLUMNS.join('","')}"\r\n`,
  );
  assert.deepEqual(BI_EXPORT_COLUMNS, [
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
  ]);
});

test("quotes every field and escapes quotes, commas, newlines, and accents", () => {
  const line = csvRowLine({
    email: "  MARINA@EXAMPLE.COM ",
    nome: 'João, "Júnior"\nSul',
    id_usuario: "u-1",
    regiao: "São Paulo",
    data_ultima_compra: "2026-01-02",
    campanha_id: "campaign-1",
    campanha_nome: "Oferta, verão",
    is_lembrete: false,
    status: "entregue",
    enviado_em: "2026-01-02T12:30:00-03:00",
    entregue_em: null,
    aberto_em: null,
    clicado_em: null,
    motivo_nao_envio: 'erro: "timeout"',
  });

  assert.equal(
    line,
    `"marina@example.com","João, ""Júnior""\nSul","u-1","São Paulo","2026-01-02","campaign-1","Oferta, verão","false","entregue","2026-01-02T15:30:00.000Z","","","","erro: ""timeout"""\r\n`,
  );
});

test("renders nulls as empty quoted fields and preserves date-only values", () => {
  const line = csvRowLine({
    email: null,
    nome: null,
    id_usuario: null,
    regiao: null,
    data_ultima_compra: null,
    campanha_id: null,
    campanha_nome: null,
    is_lembrete: null,
    status: null,
    enviado_em: null,
    entregue_em: null,
    aberto_em: null,
    clicado_em: null,
    motivo_nao_envio: null,
  });

  assert.equal(line, `${Array.from({ length: 14 }, () => '""').join(",")}\r\n`);
  assert.match(csvRowLine({
    email: "a@b.test",
    nome: null,
    id_usuario: null,
    regiao: null,
    data_ultima_compra: "2025-12-31",
    campanha_id: "c",
    campanha_nome: null,
    is_lembrete: false,
    status: "entregue",
    enviado_em: null,
    entregue_em: null,
    aberto_em: null,
    clicado_em: null,
    motivo_nao_envio: null,
  }), /"2025-12-31"/u);
});