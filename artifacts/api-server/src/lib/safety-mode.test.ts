import assert from "node:assert/strict";
import test from "node:test";
import { buildRecipientDeliveryProjection } from "./recipient-delivery-projection";
import { getSafetyMode, isRecipientAllowed } from "./safety-mode";

function withSafetyConfiguration(
  allowlist: string,
  envioLiberado: string,
  callback: () => void,
) {
  const previousAllowlist = process.env.ENVIO_ALLOWLIST;
  const previousEnvioLiberado = process.env.ENVIO_LIBERADO;
  process.env.ENVIO_ALLOWLIST = allowlist;
  process.env.ENVIO_LIBERADO = envioLiberado;

  try {
    callback();
  } finally {
    if (previousAllowlist === undefined) delete process.env.ENVIO_ALLOWLIST;
    else process.env.ENVIO_ALLOWLIST = previousAllowlist;
    if (previousEnvioLiberado === undefined) delete process.env.ENVIO_LIBERADO;
    else process.env.ENVIO_LIBERADO = previousEnvioLiberado;
  }
}

test("allows Gmail plus-addresses through their base allowlist address only", () => {
  withSafetyConfiguration("marcio.raffinato@gmail.com", "false", () => {
    assert.equal(isRecipientAllowed("marcio.raffinato+t1@gmail.com"), true);
    assert.equal(isRecipientAllowed("marcio.raffinato+t2@gmail.com"), true);
    assert.equal(isRecipientAllowed("marcio.raffinato+qualquercoisa@gmail.com"), true);
    assert.equal(isRecipientAllowed("marcio.raffinato+t1@outlook.com"), false);
  });
});

test("allows all addresses on an explicitly listed domain", () => {
  withSafetyConfiguration(" @amo.delivery ", "false", () => {
    assert.equal(isRecipientAllowed("pessoa@amo.delivery"), true);
    assert.equal(isRecipientAllowed("time+campanha@AMO.DELIVERY"), true);
    assert.equal(isRecipientAllowed("pessoa@outro.delivery"), false);
    assert.equal(getSafetyMode().allowlist_count, 1);

    const projection = buildRecipientDeliveryProjection(
      Array.from({ length: 8 }, (_, index) => `equipe-${index}@amo.delivery`),
      new Set(),
    );
    assert.equal(projection.total_na_lista, 8);
    assert.equal(projection.permitidos_modo_teste, 8);
    assert.equal(projection.bloqueados_modo_teste, 0);
  });
});

test("keeps Gmail aliases distinct for recipient and suppression counts", () => {
  withSafetyConfiguration("marcio.raffinato@gmail.com", "false", () => {
    const projection = buildRecipientDeliveryProjection(
      ["marcio.raffinato@gmail.com", "marcio.raffinato+t1@gmail.com"],
      new Set(["marcio.raffinato+t1@gmail.com"]),
    );

    assert.deepEqual(projection, {
      total_na_lista: 2,
      suprimidos_no_envio: 1,
      permitidos_modo_teste: 1,
      bloqueados_modo_teste: 0,
      receberao_de_fato: 1,
    });
  });
});

test("leaves the ENVIO_LIBERADO bypass unchanged", () => {
  withSafetyConfiguration("", "true", () => {
    assert.equal(isRecipientAllowed("anyone@example.com"), true);
    assert.equal(getSafetyMode().envio_liberado, true);
    assert.equal(getSafetyMode().message, null);
  });
});