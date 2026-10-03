import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkerCampaign, maybePauseWorkerCampaign } from "./worker-campaign";
import type { ReputationCounts } from "./campaign-reputation";

const zero: ReputationCounts = { enviados: 0, entregues: 0, bounces_permanentes: 0, reclamacoes: 0 };
const historical: ReputationCounts = { enviados: 1000, entregues: 909, bounces_permanentes: 40, reclamacoes: 0 };
const marker = "2026-10-03T12:26:14.040061Z";

function fixture(options: {
  marker?: string | null;
  omitMarker?: boolean;
  counts?: ReputationCounts;
  transitionError?: Error;
  transitionChanged?: boolean;
} = {}) {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const logs: Array<Record<string, unknown>> = [];
  let projection = "";
  const campaign: Record<string, unknown> = { id: "campaign", status: "enviando", retomada_enviados_base: 1000 };
  if (!options.omitMarker) campaign.retomada_em = options.marker === undefined ? marker : options.marker;
  const client = {
    from(table: string) {
      assert.equal(table, "campanha");
      return { select(columns: string) {
        projection = columns;
        return { eq() { return { async maybeSingle() {
          // Respect the projection, so this regression reproduces the real bug.
          const data = Object.fromEntries(Object.entries(campaign).filter(([key]) => columns.split(",").includes(key)));
          return { data, error: null };
        } }; } };
      } };
    },
    async rpc(name: string, params: Record<string, unknown>) {
      calls.push({ name, params });
      if (name === "campaign_reputation_counts") {
        return { data: params.p_desde === null ? historical : (options.counts ?? zero), error: null };
      }
      assert.equal(name, "transition_campaign_with_audit");
      return { data: options.transitionChanged ? null : { ...campaign, status: "pausada" }, error: options.transitionError ?? null };
    },
  } as unknown as SupabaseClient;
  const log = { info(fields: Record<string, unknown>) { logs.push(fields); } };
  return { client, log, calls, logs, projection: () => projection };
}

test("worker projection reads the persisted resume marker and baseline", async () => {
  const f = fixture();
  const campaign = await loadWorkerCampaign(f.client, "campaign");
  assert.equal(campaign?.retomada_em, marker);
  assert.equal(campaign?.retomada_enviados_base, 1000);
  assert.ok(f.projection().split(",").includes("retomada_em"));
});

test("zero post-resume sends do not pause or consult historical counts", async () => {
  const f = fixture();
  assert.equal(await maybePauseWorkerCampaign(f.client, "campaign", f.log), false);
  assert.deepEqual(f.calls, [{ name: "campaign_reputation_counts", params: { p_campanha_id: "campaign", p_desde: marker } }]);
  assert.equal(f.logs.length, 0);
});

test("an omitted/invalid resume field fails closed, never falls back to cumulative", async () => {
  for (const f of [fixture({ omitMarker: true }), fixture({ marker: "invalid" })]) {
    await assert.rejects(maybePauseWorkerCampaign(f.client, "campaign", f.log), /marco de retomada válido/);
    assert.equal(f.calls.length, 0);
  }
});

test("a new catastrophe logs denominators, limits and the applied marker after the audit commits", async () => {
  const f = fixture({ counts: { enviados: 200, entregues: 190, bounces_permanentes: 10, reclamacoes: 0 } });
  assert.equal(await maybePauseWorkerCampaign(f.client, "campaign", f.log), true);
  const transition = f.calls.find((call) => call.name === "transition_campaign_with_audit")!;
  assert.equal((transition.params.p_metadata as Record<string, unknown>).marco_retomada, marker);
  assert.equal(f.logs[0].pauseApplied, true);
  assert.equal(f.logs[0].trigger, "catastrofe");
  assert.equal(f.logs[0].resumeMarkerApplied, true);
  assert.equal(f.logs[0].minimumSends, 200);
  assert.deepEqual(f.logs[0].bounce, { numerator: 10, denominator: 200, rate: 0.05, limit: 0.04 });
  assert.deepEqual(f.logs[0].complaint, { numerator: 0, denominator: 190, rate: 0, limit: 0.005 });
});

test("never-resumed campaigns still use cumulative counts and the normal trigger", async () => {
  const f = fixture({ marker: null });
  assert.equal(await maybePauseWorkerCampaign(f.client, "campaign", f.log), true);
  assert.equal(f.logs[0].trigger, "normal");
  assert.equal(f.logs[0].resumeMarkerApplied, false);
  assert.equal(f.logs[0].minimumSends, 1000);
});

test("failed/raced transitions never log a successful pause", async () => {
  const failed = fixture({ marker: null, transitionError: new Error("RPC failed") });
  await assert.rejects(maybePauseWorkerCampaign(failed.client, "campaign", failed.log), /RPC failed/);
  assert.equal(failed.logs.length, 0);
  const raced = fixture({ marker: null, transitionChanged: true });
  assert.equal(await maybePauseWorkerCampaign(raced.client, "campaign", raced.log), true);
  assert.equal(raced.logs[0].pauseApplied, false);
});