import assert from "node:assert/strict";
import test from "node:test";
import { buildRecipientDeliveryProjection } from "./recipient-delivery-projection";
import {
  campaignTestRequiredScheduleMessage,
  isCampaignTestRequired,
  noEligibleRecipientsScheduleMessage,
} from "./campaign-schedule-policy";

test("requires a campaign test only above 50 imported recipients", () => {
  assert.equal(isCampaignTestRequired(0), false);
  assert.equal(isCampaignTestRequired(50), false);
  assert.equal(isCampaignTestRequired(51), true);
  assert.match(campaignTestRequiredScheduleMessage(51), /51 destinatários importados/);
});

test("distinguishes an empty list with its imported count", () => {
  assert.equal(
    noEligibleRecipientsScheduleMessage({
      total_na_lista: 0,
      suprimidos_no_envio: 0,
      permitidos_modo_teste: 0,
      bloqueados_modo_teste: 0,
      receberao_de_fato: 0,
    }),
    "A lista está vazia: 0 destinatários importados. Importe ao menos um destinatário antes de agendar.",
  );
});

test("reports imported, allowed, blocked, and suppressed counts when nobody can receive", () => {
  assert.equal(
    noEligibleRecipientsScheduleMessage({
      total_na_lista: 8,
      suprimidos_no_envio: 1,
      permitidos_modo_teste: 0,
      bloqueados_modo_teste: 7,
      receberao_de_fato: 0,
    }),
    "Há 8 destinatários importados, mas nenhum está apto a receber: 0 liberados, 7 bloqueados pelo modo de segurança e 1 suprimido.",
  );
});

test("keeps imported count visible when safety mode blocks every recipient", () => {
  const previousAllowlist = process.env.ENVIO_ALLOWLIST;
  const previousEnvioLiberado = process.env.ENVIO_LIBERADO;
  process.env.ENVIO_ALLOWLIST = "";
  process.env.ENVIO_LIBERADO = "false";

  try {
    const delivery = buildRecipientDeliveryProjection(
      Array.from({ length: 8 }, (_, index) => `person-${index}@example.com`),
      new Set(),
    );

    assert.equal(delivery.total_na_lista, 8);
    assert.equal(delivery.receberao_de_fato, 0);
    assert.match(
      noEligibleRecipientsScheduleMessage(delivery),
      /8 destinatários importados.*0 liberados, 8 bloqueados/,
    );
  } finally {
    if (previousAllowlist === undefined) delete process.env.ENVIO_ALLOWLIST;
    else process.env.ENVIO_ALLOWLIST = previousAllowlist;
    if (previousEnvioLiberado === undefined) delete process.env.ENVIO_LIBERADO;
    else process.env.ENVIO_LIBERADO = previousEnvioLiberado;
  }
});