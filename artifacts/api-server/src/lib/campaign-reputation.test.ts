import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateReputation,
  hasCampaignReputationWarning,
  reputationPeriod,
} from "./campaign-reputation";

test("catastrophe requires 200 sends and strictly exceeds 8% bounce", () => {
  assert.equal(evaluateReputation({ enviados: 199, entregues: 189, bounces_permanentes: 17, reclamacoes: 0 }), null);
  assert.equal(evaluateReputation({ enviados: 200, entregues: 190, bounces_permanentes: 17, reclamacoes: 0 })?.gatilho, "catastrofe");
  assert.equal(evaluateReputation({ enviados: 200, entregues: 190, bounces_permanentes: 16, reclamacoes: 0 }), null);
});
test("normal trigger requires 1000 sends and strictly exceeds 5% bounce", () => {
  assert.equal(evaluateReputation({ enviados: 999, entregues: 950, bounces_permanentes: 51, reclamacoes: 0 }), null);
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 970, bounces_permanentes: 51, reclamacoes: 0 })?.gatilho, "normal");
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 1000, bounces_permanentes: 50, reclamacoes: 0 }), null);
});
test("complaints use delivered denominator and require at least three", () => {
  assert.equal(evaluateReputation({ enviados: 200, entregues: 200, bounces_permanentes: 0, reclamacoes: 1 }), null);
  assert.equal(evaluateReputation({ enviados: 200, entregues: 1000, bounces_permanentes: 0, reclamacoes: 3 }), null);
  assert.equal(evaluateReputation({ enviados: 200, entregues: 999, bounces_permanentes: 0, reclamacoes: 3 })?.gatilho, "catastrofe");
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 1000, bounces_permanentes: 0, reclamacoes: 3 }), null);
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 999, bounces_permanentes: 0, reclamacoes: 3 })?.gatilho, "catastrofe");
  assert.match(
    evaluateReputation({ enviados: 200, entregues: 999, bounces_permanentes: 0, reclamacoes: 3 })?.motivo ?? "",
    /3\/999 entregues.*mínimo de 3/,
  );
});
test("visual warning starts at 50 sends and is inclusive at either warning threshold", () => {
  assert.equal(hasCampaignReputationWarning({ enviados: 49, entregues: 49, bounces_permanentes: 1, reclamacoes: 0 }), false);
  assert.equal(hasCampaignReputationWarning({ enviados: 50, entregues: 50, bounces_permanentes: 1, reclamacoes: 0 }), true);
  assert.equal(hasCampaignReputationWarning({ enviados: 1000, entregues: 1000, bounces_permanentes: 0, reclamacoes: 1 }), true);
  assert.equal(hasCampaignReputationWarning({ enviados: 1000, entregues: 1000, bounces_permanentes: 0, reclamacoes: 0 }), false);
});
test("zero cohort is safe", () => {
  assert.equal(reputationPeriod({ enviados: 0, entregues: 0, bounces_permanentes: 0, reclamacoes: 0 }).taxa_bounce, 0);
  assert.equal(evaluateReputation({ enviados: 0, entregues: 0, bounces_permanentes: 0, reclamacoes: 0 }), null);
});