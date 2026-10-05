import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCampaignExclusionsParams, GetCampaignExclusionsQueryParams, GetCampaignExclusionsResponse,
  ExcludeCampaignRecipientsBody, ExcludeCampaignRecipientsResponse,
  RestoreCampaignRecipientsBody,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import {
  CAMPAIGN_REPUTATION_THRESHOLDS,
  loadReputationCounts,
  reputationPeriod,
} from "../lib/campaign-reputation";
import { emailsFromExclusionCsv } from "../lib/recipient-exclusions";
import { ImportValidationError } from "../lib/csv-import";
import { normalizeEmail } from "../lib/email-normalization";
import { getTechnicalError } from "../lib/technical-error";

const MAX_EXCLUSION_CSV_BYTES = 50 * 1024 * 1024;
const router: IRouter = Router();
const FIELDS = "id,email,nome,status,excluido_em,exclusao_motivo,excluido_por_nome,excluido_por_email";

router.get("/campaigns/:campaignId/exclusions", async (req, res) => {
  const params = GetCampaignExclusionsParams.safeParse(req.params);
  const query = GetCampaignExclusionsQueryParams.safeParse(req.query);
  if (!params.success || !query.success) {
    res.status(422).json({ error: "Identificador ou paginação inválida." }); return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) { res.status(401).json({ error: "Sessão expirada." }); return; }
    const client = supabaseAdminClient();
    const id = params.data.campaignId;
    const { data: campaign, error: campaignError } = await client.from("campanha")
      .select("id,pausada_em,retomada_em,retomada_enviados_base").eq("id", id).maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) { res.status(404).json({ error: "Campanha não encontrada." }); return; }
    const main = () => client.from("destinatario").select("id", { count: "exact", head: true })
      .eq("campanha_id", id).eq("is_lembrete", false);
    const [providers, excluded, queue, changed, cumulative, current] = await Promise.all([
      client.rpc("campaign_provider_diagnostics", { p_campanha_id: id }),
      client.from("destinatario").select(FIELDS, { count: "exact" }).eq("campanha_id", id)
        .eq("is_lembrete", false).not("excluido_em", "is", null)
        .order("excluido_em", { ascending: false }).order("id")
        .range(query.data.offset, query.data.offset + query.data.limit - 1),
      main().eq("status", "pendente").is("excluido_em", null),
      campaign.pausada_em
        ? main().gte("excluido_em", campaign.pausada_em)
        : Promise.resolve({ count: 0, error: null }),
      loadReputationCounts(client, id),
      loadReputationCounts(client, id, campaign.retomada_em),
    ]);
    for (const result of [providers, excluded, queue, changed]) if (result.error) throw result.error;
    res.json(GetCampaignExclusionsResponse.parse({
      provedores: providers.data, excluidos: excluded.data ?? [], total_excluidos: excluded.count ?? 0,
      pendentes_na_fila: queue.count ?? 0, exclusoes_desde_pausa: changed.count ?? 0,
      retomada_em: campaign.retomada_em, retomada_enviados_base: campaign.retomada_enviados_base,
      acumulada: reputationPeriod(cumulative), periodo_atual: reputationPeriod(current),
      limites_pausa: {
        catastrofe: {
          envios_minimos: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.minSends,
          bounce_percentual: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.bounce * 100,
          reclamacao_percentual: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.complaint * 100,
          reclamacoes_minimas: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.minComplaints,
        },
        normal: {
          envios_minimos: CAMPAIGN_REPUTATION_THRESHOLDS.normal.minSends,
          bounce_percentual: CAMPAIGN_REPUTATION_THRESHOLDS.normal.bounce * 100,
          reclamacao_percentual: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.complaint * 100,
          reclamacoes_minimas: CAMPAIGN_REPUTATION_THRESHOLDS.catastrophe.minComplaints,
        },
      },
    }));
  } catch (error) {
    req.log.error({ technicalError: getTechnicalError(error) }, "Campaign exclusion diagnostics failed");
    res.status(503).json({ error: "Diagnóstico indisponível. Confira a aplicação da migração 016 ou tente novamente." });
  }
});

async function mutateExclusions(req: Request, res: Response, restore: boolean) {
  const params = GetCampaignExclusionsParams.safeParse(req.params);
  const excludeBody = ExcludeCampaignRecipientsBody.safeParse(req.body);
  const restoreBody = RestoreCampaignRecipientsBody.safeParse(req.body);
  if (!params.success || (restore ? !restoreBody.success : !excludeBody.success)) {
    res.status(422).json({ error: "Seleção, identificador ou motivo inválido." }); return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) { res.status(401).json({ error: "Sessão expirada." }); return; }
    const input = excludeBody.success ? excludeBody.data : undefined;
    const undo = restoreBody.success ? restoreBody.data : undefined;
    const selectionCount = input
      ? Number(Boolean(input.provedores?.length)) + Number(Boolean(input.emails?.length)) + Number(Boolean(input.csv))
      : 0;
    if (!restore && (selectionCount !== 1 || !input?.motivo.trim())) {
      res.status(422).json({ error: "Informe o motivo e escolha somente provedores ou uma lista/CSV." }); return;
    }
    if (restore && (Number(Boolean(undo?.ids?.length)) + Number(undo?.todos === true) !== 1)) {
      res.status(422).json({ error: "Selecione os destinatários ou confirme a restauração de todos." }); return;
    }
    if (
      !restore &&
      input?.csv &&
      Buffer.byteLength(input.csv, "utf8") > MAX_EXCLUSION_CSV_BYTES
    ) {
      res.status(422).json({ error: "O CSV excede o limite de 50 MB." });
      return;
    }
    const emails = !restore && input?.csv
      ? await emailsFromExclusionCsv(input.csv)
      : [...new Set((input?.emails ?? []).map(normalizeEmail))];
    const { data, error } = await supabaseAdminClient().rpc("change_campaign_exclusions", {
      p_campanha_id: params.data.campaignId, p_restore: restore,
      p_motivo: restore ? null : input!.motivo.trim(),
      p_actor_id: session.user.id, p_actor_nome: session.user.name, p_actor_email: session.user.email,
      p_provedores: restore ? [] : input?.provedores ?? [], p_emails: restore ? [] : emails,
      p_ids: restore ? undo?.ids ?? [] : [], p_todos: restore && undo?.todos === true,
    });
    if (error) {
      if (error.message === "campaign_finished") {
        res.status(409).json({ error: "A campanha terminou. Não é possível excluir ou restaurar." }); return;
      }
      if (error.message === "campaign_not_found") {
        res.status(404).json({ error: "Campanha não encontrada." }); return;
      }
      throw error;
    }
    res.json(ExcludeCampaignRecipientsResponse.parse(data));
  } catch (error) {
    if (error instanceof ImportValidationError) { res.status(422).json({ error: error.message }); return; }
    req.log.error({ technicalError: getTechnicalError(error) }, "Campaign exclusion mutation failed");
    res.status(503).json({ error: "Não foi possível alterar as exclusões. Confira a migração 016 ou tente novamente." });
  }
}
router.post("/campaigns/:campaignId/exclusions", (req, res) => mutateExclusions(req, res, false));
router.post("/campaigns/:campaignId/exclusions/restore", (req, res) => mutateExclusions(req, res, true));
export default router;