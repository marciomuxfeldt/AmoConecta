import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CAMPAIGN_REPUTATION_THRESHOLDS,
  evaluateReputation,
  loadReputationCounts,
  reputationPeriod,
} from "./campaign-reputation";

export type WorkerCampaign = {
  id: string;
  nome: string;
  assunto: string;
  remetente_nome: string;
  remetente_email: string;
  preheader?: string | null;
  valor_credito?: number | null;
  validade_credito?: string | null;
  reply_to?: string | null;
  corpo: unknown;
  cor_botao_snapshot?: string | null;
  assunto_lembrete?: string | null;
  corpo_lembrete?: unknown;
  incluir_desengajados?: boolean | null;
  status: string;
  agendada_para?: string | null;
  janela_envio_inicio: string;
  janela_envio_fim: string;
  teto_hora?: number | null;
  teto_dia?: number | null;
  pausa_motivo?: string | null;
  pausa_taxa_bounce?: number | null;
  pausa_taxa_reclamacao?: number | null;
  retomada_em: string | null;
  retomada_enviados_base: number | null;
};

type PauseLogger = {
  info(fields: Record<string, unknown>, message: string): void;
};

export async function loadWorkerCampaign(
  client: SupabaseClient,
  campaignId: string,
): Promise<WorkerCampaign | null> {
  const { data, error } = await client.from("campanha").select(
    "id,nome,assunto,assunto_lembrete,corpo_lembrete,cor_botao_snapshot,incluir_desengajados,remetente_nome,remetente_email,preheader,valor_credito,validade_credito,reply_to,corpo,status,agendada_para,janela_envio_inicio,janela_envio_fim,teto_hora,teto_dia,retomada_em,retomada_enviados_base",
  ).eq("id", campaignId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // An omitted projection field is not an unresumed campaign. Fail closed.
  if (!Object.hasOwn(data, "retomada_em") ||
    (data.retomada_em !== null &&
      (typeof data.retomada_em !== "string" || !Number.isFinite(Date.parse(data.retomada_em))))) {
    throw new Error("A consulta do worker não retornou um marco de retomada válido.");
  }
  return data as WorkerCampaign;
}

export async function maybePauseWorkerCampaign(
  client: SupabaseClient,
  campaignId: string,
  log: PauseLogger,
): Promise<boolean> {
  const campaign = await loadWorkerCampaign(client, campaignId);
  if (!campaign || campaign.status !== "enviando") return true;
  const counts = await loadReputationCounts(client, campaignId, campaign.retomada_em);
  const decision = evaluateReputation(counts);
  if (!decision) return false;
  const cumulative = reputationPeriod(await loadReputationCounts(client, campaignId));
  const { data, error } = await client.rpc("transition_campaign_with_audit", {
    p_campanha_id: campaignId, p_expected: "enviando", p_target: "pausada",
    p_actor_id: null, p_actor_nome: "Sistema", p_actor_email: null,
    p_motivo: decision.motivo, p_bounce: decision.taxa_bounce, p_reclamacao: decision.taxa_reclamacao,
    p_metadata: { gatilho: decision.gatilho, periodo_atual: decision,
      acumulada: cumulative, marco_retomada: campaign.retomada_em },
  });
  if (error) throw error; // Never send after a failed/unaudited transition.
  if (data !== null && (!data || typeof data !== "object" || data.status !== "pausada")) {
    throw new Error("A RPC de pausa retornou um resultado inválido.");
  }
  const catastrophe = decision.gatilho === "catastrofe";
  const triggerPolicy = catastrophe
    ? CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe
    : CAMPAIGN_REPUTATION_THRESHOLDS.normal;
  log.info({
    campaignId,
    trigger: decision.gatilho,
    reason: decision.motivo,
    resumeMarker: campaign.retomada_em,
    resumeMarkerApplied: campaign.retomada_em !== null,
    resumeSendBaseline: campaign.retomada_enviados_base,
    minimumSends: triggerPolicy.minSends,
    cohortSends: counts.enviados,
    bounce: {
      numerator: counts.bounces_permanentes, denominator: counts.enviados,
      rate: decision.taxa_bounce, limit: triggerPolicy.bounce,
    },
    complaint: {
      numerator: counts.reclamacoes, denominator: counts.entregues,
      rate: decision.taxa_reclamacao, limit: triggerPolicy.complaint,
    },
    cumulative,
    pauseApplied: data !== null,
  }, data !== null
    ? "AmoConecta campaign automatically paused"
    : "AmoConecta automatic pause skipped because campaign status changed");
  return true;
}