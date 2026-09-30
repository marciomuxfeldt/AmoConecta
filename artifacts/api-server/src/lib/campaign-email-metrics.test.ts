import assert from "node:assert/strict";
import test from "node:test";
import { buildCampaignEmailMetrics } from "./campaign-email-metrics";

const counts = {
  destinatarios: 43,
  enviados: 39,
  entregues: 32,
  aberturas: 20,
  cliques: 8,
  bounces: 6,
  bouncesPermanentes: 4,
  bouncesTemporarios: 1,
  bouncesIndeterminados: 1,
  reclamacoes: 2,
  descadastros: 3,
};

function assertPercentage(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} != ${expected}`);
}

test("campaign e-mail metrics use the intended denominator for each rate", () => {
  const metrics = buildCampaignEmailMetrics(counts);

  assertPercentage(metrics.enviados.percentual, (39 / 43) * 100);
  assertPercentage(metrics.entregues.percentual, (32 / 39) * 100);
  assertPercentage(metrics.aberturas.percentual, (20 / 32) * 100);
  assertPercentage(metrics.cliques.percentual, (8 / 32) * 100);
  assertPercentage(metrics.bounces.percentual, (6 / 39) * 100);
  assertPercentage(metrics.bounces_permanentes.percentual, (4 / 39) * 100);
  assertPercentage(metrics.bounces_temporarios.percentual, (1 / 39) * 100);
  assertPercentage(metrics.bounces_indeterminados.percentual, (1 / 39) * 100);
  assertPercentage(metrics.reclamacoes.percentual, (2 / 32) * 100);
  assertPercentage(metrics.descadastros.percentual, (3 / 32) * 100);
});

test("campaign e-mail metrics return zero when a denominator is empty", () => {
  const metrics = buildCampaignEmailMetrics({
    ...counts,
    destinatarios: 0,
    enviados: 0,
    entregues: 0,
  });

  assert.equal(metrics.enviados.percentual, 0);
  assert.equal(metrics.entregues.percentual, 0);
  assert.equal(metrics.aberturas.percentual, 0);
  assert.equal(metrics.cliques.percentual, 0);
  assert.equal(metrics.bounces.percentual, 0);
  assert.equal(metrics.reclamacoes.percentual, 0);
});