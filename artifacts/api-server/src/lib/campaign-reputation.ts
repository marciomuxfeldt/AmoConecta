import type { SupabaseClient } from "@supabase/supabase-js";

export type ReputationCounts = {
  enviados: number;
  entregues: number;
  bounces_permanentes: number;
  reclamacoes: number;
};

export function reputationPeriod(counts: ReputationCounts) {
  return {
    ...counts,
    taxa_bounce: counts.enviados > 0 ? counts.bounces_permanentes / counts.enviados : 0,
    taxa_reclamacao: counts.entregues > 0 ? counts.reclamacoes / counts.entregues : 0,
  };
}

export function evaluateReputation(counts: ReputationCounts) {
  const rates = reputationPeriod(counts);
  const catastrophe = counts.enviados >= 200 &&
    (rates.taxa_bounce > 0.04 || rates.taxa_reclamacao > 0.005);
  const normal = counts.enviados >= 1000 &&
    (rates.taxa_bounce > 0.02 || rates.taxa_reclamacao > 0.002);
  if (!catastrophe && !normal) return null;
  const trigger = catastrophe ? "catastrofe" : "normal";
  const bounceLimit = catastrophe ? 0.04 : 0.02;
  const complaintLimit = catastrophe ? 0.005 : 0.002;
  const reasons = [];
  if (rates.taxa_bounce > bounceLimit) {
    reasons.push(`bounce permanente ${(rates.taxa_bounce * 100).toFixed(2)}% (limite ${bounceLimit * 100}%)`);
  }
  if (rates.taxa_reclamacao > complaintLimit) {
    reasons.push(`reclamações ${(rates.taxa_reclamacao * 100).toFixed(2)}% (limite ${complaintLimit * 100}%)`);
  }
  return {
    ...rates,
    gatilho: trigger,
    motivo: `Pausa automática: gatilho ${catastrophe ? "catástrofe" : "normal"} com ${counts.enviados} enviados; ${reasons.join(" e ")}.`,
  };
}

export async function loadReputationCounts(
  client: SupabaseClient,
  campaignId: string,
  since: string | null = null,
): Promise<ReputationCounts> {
  const { data, error } = await client.rpc("campaign_reputation_counts", {
    p_campanha_id: campaignId,
    p_desde: since,
  });
  if (error) throw error;
  if (!data || typeof data.enviados !== "number") {
    throw new Error("A RPC campaign_reputation_counts retornou um resultado inválido.");
  }
  return data as ReputationCounts;
}