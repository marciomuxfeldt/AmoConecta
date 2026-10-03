import type { SupabaseClient } from "@supabase/supabase-js";

export type ReputationCounts = {
  enviados: number;
  entregues: number;
  bounces_permanentes: number;
  reclamacoes: number;
};

// Fixed policy thresholds. The account warning is earlier than AWS's 5% hard-bounce review line;
// automated campaign pauses use higher thresholds to avoid stopping healthy campaigns.
export const CAMPAIGN_REPUTATION_THRESHOLDS = {
  warning: { minSends: 50, bounce: 0.02, complaint: 0.001 },
  catastrophe: { minSends: 200, bounce: 0.08, complaint: 0.003, minComplaints: 3 },
  normal: { minSends: 1000, bounce: 0.05, complaint: 0.003, minComplaints: 3 },
} as const;

export function reputationPeriod(counts: ReputationCounts) {
  return {
    ...counts,
    taxa_bounce: counts.enviados > 0 ? counts.bounces_permanentes / counts.enviados : 0,
    taxa_reclamacao: counts.entregues > 0 ? counts.reclamacoes / counts.entregues : 0,
  };
}

export function hasCampaignReputationWarning(counts: ReputationCounts): boolean {
  const rates = reputationPeriod(counts);
  return counts.enviados >= CAMPAIGN_REPUTATION_THRESHOLDS.warning.minSends &&
    (rates.taxa_bounce >= CAMPAIGN_REPUTATION_THRESHOLDS.warning.bounce ||
      rates.taxa_reclamacao >= CAMPAIGN_REPUTATION_THRESHOLDS.warning.complaint);
}

export function evaluateReputation(counts: ReputationCounts) {
  const rates = reputationPeriod(counts);
  const thresholds = CAMPAIGN_REPUTATION_THRESHOLDS;
  const complaintTrigger =
    counts.reclamacoes >= thresholds.catastrophe.minComplaints &&
    rates.taxa_reclamacao > thresholds.catastrophe.complaint;
  const catastrophe = counts.enviados >= thresholds.catastrophe.minSends &&
    (rates.taxa_bounce > thresholds.catastrophe.bounce || complaintTrigger);
  const normal = counts.enviados >= thresholds.normal.minSends &&
    (rates.taxa_bounce > thresholds.normal.bounce || complaintTrigger);
  if (!catastrophe && !normal) return null;
  const trigger = catastrophe ? "catastrofe" : "normal";
  const bounceLimit = catastrophe
    ? thresholds.catastrophe.bounce
    : thresholds.normal.bounce;
  const reasons = [];
  if (rates.taxa_bounce > bounceLimit) {
    reasons.push(
      `bounce permanente ${counts.bounces_permanentes}/${counts.enviados} (${(rates.taxa_bounce * 100).toFixed(2)}%, acima do limite de ${bounceLimit * 100}%)`,
    );
  }
  if (complaintTrigger) {
    reasons.push(
      `reclamações ${counts.reclamacoes}/${counts.entregues} entregues (${(rates.taxa_reclamacao * 100).toFixed(2)}%, acima do limite de ${thresholds.catastrophe.complaint * 100}%, mínimo de ${thresholds.catastrophe.minComplaints})`,
    );
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