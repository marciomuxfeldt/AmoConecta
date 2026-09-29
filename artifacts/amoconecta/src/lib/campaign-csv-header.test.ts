import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the explicit TypeScript extension.
import { inspectCampaignCsvHeader } from "./campaign-csv-header.ts";

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
    assert.equal(inspection.hasLastOrderDate, true);
  });
}

test("warns for a semicolon dashboard export without a purchase-date column", async () => {
  const file = new File(
    ["user_id;user_name;user_email;user_phone"],
    "export.csv",
    { type: "text/csv" },
  );
  const inspection = await inspectCampaignCsvHeader(file);

  assert.equal(inspection.separatorLabel, "ponto e vírgula (;)");
  assert.deepEqual(inspection.columns, [
    "user_id",
    "user_name",
    "user_email",
    "user_phone",
  ]);
  assert.equal(inspection.hasLastOrderDate, false);
});

test("recognizes the existing localized date-column alias", async () => {
  const file = new File(
    ["user_name;user_email;Data última compra"],
    "export.csv",
    { type: "text/csv" },
  );
  const inspection = await inspectCampaignCsvHeader(file);

  assert.equal(inspection.hasLastOrderDate, true);
});

test("skips a leading blank line and inspects the first actual header record", async () => {
  const file = new File(
    ["\uFEFF\r\nuser_name;user_email;last_order_date"],
    "export.csv",
    { type: "text/csv" },
  );
  const inspection = await inspectCampaignCsvHeader(file);

  assert.equal(inspection.separator, ";");
  assert.equal(inspection.hasLastOrderDate, true);
});

test("lets the operator decide when the header is too long to fully inspect", async () => {
  const file = new File(
    [`user_name;user_email;${"x".repeat(1024 * 1024)}`],
    "large-header.csv",
    { type: "text/csv" },
  );
  const inspection = await inspectCampaignCsvHeader(file);

  assert.equal(inspection.headerComplete, false);
  assert.equal(inspection.hasLastOrderDate, false);
});