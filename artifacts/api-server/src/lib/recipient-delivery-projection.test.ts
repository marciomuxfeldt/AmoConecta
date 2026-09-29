import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChronicEmailQueryBatches,
  buildRecipientDeliveryProjection,
} from "./recipient-delivery-projection";

test("bounds encoded chronic-email lookup filters for large recipient lists", () => {
  const emails = Array.from(
    { length: 5_136 },
    (_, index) => `contact-${index}@example.com`,
  );
  const batches = buildChronicEmailQueryBatches(emails);

  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), emails);
  for (const batch of batches) {
    const filter = `in.(${batch.map((email) => `"${email}"`).join(",")})`;
    const queryLength = new URLSearchParams({
      select: "email",
      desengajado_cronico: "eq.true",
      email: filter,
    }).toString().length;
    assert.ok(queryLength <= 6_000);
  }
});

test("projects suppressed recipients before the worker processes them", () => {
  const projection = buildRecipientDeliveryProjection(
    Array.from({ length: 12 }, (_, index) => `person-${index}@example.com`),
    new Set(["person-4@example.com"]),
  );

  assert.deepEqual(projection, {
    total_na_lista: 12,
    suprimidos_no_envio: 1,
    permitidos_modo_teste: 0,
    bloqueados_modo_teste: 11,
    receberao_de_fato: 0,
    desengajados_na_lista: 0,
    bloqueados_desengajados: 0,
  });
});

test("normalizes recipient and suppression e-mails before crossing the lists", () => {
  assert.deepEqual(
    buildRecipientDeliveryProjection(
      [" Pessoa@Example.com "],
      new Set(["pessoa@example.com"]),
    ),
    {
      total_na_lista: 1,
      suprimidos_no_envio: 1,
      permitidos_modo_teste: 0,
      bloqueados_modo_teste: 0,
      receberao_de_fato: 0,
      desengajados_na_lista: 0,
      bloqueados_desengajados: 0,
    },
  );
});