import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReputation, reputationPeriod } from "./campaign-reputation";

test("catastrophe pauses 5% at 200 sends, never before the sample or at exact threshold", () => {
  assert.equal(evaluateReputation({ enviados: 199, entregues: 189, bounces_permanentes: 10, reclamacoes: 0 }), null);
  assert.equal(evaluateReputation({ enviados: 200, entregues: 190, bounces_permanentes: 10, reclamacoes: 0 })?.gatilho, "catastrofe");
  assert.equal(evaluateReputation({ enviados: 200, entregues: 190, bounces_permanentes: 8, reclamacoes: 0 }), null);
});
test("normal trigger uses 1000 sends and strict rates", () => {
  assert.equal(evaluateReputation({ enviados: 999, entregues: 950, bounces_permanentes: 30, reclamacoes: 0 }), null);
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 970, bounces_permanentes: 30, reclamacoes: 0 })?.gatilho, "normal");
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 1000, bounces_permanentes: 20, reclamacoes: 2 }), null);
});
test("complaints use delivered denominator; zero cohort is safe", () => {
  assert.equal(evaluateReputation({ enviados: 200, entregues: 100, bounces_permanentes: 0, reclamacoes: 1 })?.gatilho, "catastrofe");
  assert.equal(evaluateReputation({ enviados: 1000, entregues: 900, bounces_permanentes: 0, reclamacoes: 2 })?.gatilho, "normal");
  assert.equal(reputationPeriod({ enviados: 0, entregues: 0, bounces_permanentes: 0, reclamacoes: 0 }).taxa_bounce, 0);
  assert.equal(evaluateReputation({ enviados: 0, entregues: 0, bounces_permanentes: 0, reclamacoes: 0 }), null);
});