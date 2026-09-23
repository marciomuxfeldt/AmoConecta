import assert from "node:assert/strict";
import test from "node:test";
import { buildRecipientDeliveryProjection } from "./recipient-delivery-projection";

test("projects suppressed recipients before the worker processes them", () => {
  const projection = buildRecipientDeliveryProjection(
    Array.from({ length: 12 }, (_, index) => `person-${index}@example.com`),
    new Set(["person-4@example.com"]),
  );

  assert.deepEqual(projection, {
    total_na_lista: 12,
    suprimidos_no_envio: 1,
    receberao_de_fato: 11,
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
      receberao_de_fato: 0,
    },
  );
});