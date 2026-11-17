import { supabaseAdminClient } from "./supabase";
import type { RecipientDeliveryProjection } from "./recipient-delivery-projection";

export type CampaignEmailRollup = {
  destinatarios: number;
  enviados: number;
  entregues: number;
  aberturas: number;
  cliques: number;
  bounces: number;
  bouncesPermanentes: number;
  bouncesTemporarios: number;
  bouncesIndeterminados: number;
  reclamacoes: number;
  descadastros: number;
};

export function emptyEmailRollup(): CampaignEmailRollup {
  return {
    destinatarios: 0, enviados: 0, entregues: 0, aberturas: 0, cliques: 0,
    bounces: 0, bouncesPermanentes: 0, bouncesTemporarios: 0,
    bouncesIndeterminados: 0, reclamacoes: 0, descadastros: 0,
  };
}

export async function loadCampaignReadRollups(campaignIds: string[], isReminder = false) {
  const output = new Map<string, CampaignEmailRollup>();
  if (!campaignIds.length) return output;
  const { data, error } = await supabaseAdminClient().rpc("campaign_email_rollups", {
    p_campaign_ids: campaignIds, p_is_reminder: isReminder,
  });
  if (error) throw error;
  for (const row of data ?? []) {
    output.set(row.campanha_id, row as CampaignEmailRollup);
  }
  return output;
}

export async function loadCampaignReadProjection(campaignId: string): Promise<RecipientDeliveryProjection> {
  const allowlist = [...new Set((process.env.ENVIO_ALLOWLIST ?? "")
    .split(",").map((value) => {
      const normalized = value.trim().toLowerCase();
      return normalized.replace(/^([^+@]+)\+[^@]*@gmail\.com$/u, "$1@gmail.com");
    }).filter(Boolean))];
  const { data, error } = await supabaseAdminClient().rpc("campaign_read_projection", {
    p_campaign_id: campaignId,
    p_send_enabled: process.env.ENVIO_LIBERADO?.trim().toLowerCase() === "true",
    p_allowlist: allowlist,
  });
  if (error) throw error;
  if (!data) throw new Error("Campaign read projection returned no result.");
  return data as RecipientDeliveryProjection;
}

export async function loadCampaignReadCounts(campaignId: string, today: string) {
  const { data, error } = await supabaseAdminClient().rpc("campaign_read_counts", {
    p_campaign_id: campaignId, p_today: today,
  });
  if (error) throw error;
  if (!data) throw new Error("Campaign read counts returned no result.");
  return data as {
    statusCounts: number[];
    reminderStatusCounts: number[];
    recencyCounts: number[];
    excludedCount: number;
  };
}
