import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetCampaignEmailValidationJobParams,
  GetCampaignEmailValidationJobResponse,
  GetCampaignEmailValidationQuoteParams,
  GetCampaignEmailValidationQuoteResponse,
  ResumeCampaignEmailValidationJobParams,
  ResumeCampaignEmailValidationJobResponse,
  StartCampaignEmailValidationBody,
  StartCampaignEmailValidationParams,
  StartCampaignEmailValidationResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { findCampaign } from "./campaigns";
import { supabaseAdminClient } from "../lib/supabase";
import {
  isSafeEmailForExternalValidation,
  normalizeEmail,
} from "../lib/csv-import";
import { getZeroBounceCredits, ZeroBounceError } from "../lib/zerobounce";
import { recordAuditEvent, teamAuditActor } from "../lib/audit-events";
import { getTechnicalError } from "../lib/technical-error";

const router: IRouter = Router();
const PAGE_SIZE = 1_000;
const IN_QUERY_URL_BUDGET = 5_500;
const ACTIVE_JOB_STATUSES = ["pendente", "processando", "sem_creditos", "erro"];

type PendingRecipient = { id: string; email: string };

function inFilter(values: readonly string[]): string {
  return `in.(${values.map((value) => `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`).join(",")})`;
}

function inQueryLength(values: readonly string[]): number {
  return new URLSearchParams({
    select: "email,status,verificado_em",
    email: inFilter(values),
  }).toString().length;
}

function makeBatches(values: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  for (const value of [...new Set(values)]) {
    const candidate = [...batch, value];
    if (batch.length > 0 && inQueryLength(candidate) > IN_QUERY_URL_BUDGET) {
      batches.push(batch);
      batch = [value];
    } else {
      batch = candidate;
    }
    if (inQueryLength(batch) > IN_QUERY_URL_BUDGET) {
      throw new Error("A normalized e-mail exceeds the cache query URL budget.");
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function loadPendingRecipients(
  campaignId: string,
): Promise<PendingRecipient[]> {
  const client = supabaseAdminClient();
  const recipients: PendingRecipient[] = [];
  for (let offset = 0; offset < 5_000_000; offset += PAGE_SIZE) {
    const { data, error } = await client
      .from("destinatario")
      .select("id,email")
      .eq("campanha_id", campaignId)
      .eq("is_lembrete", false)
      .eq("status", "pendente")
      .is("excluido_em", null)
      .order("id")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as PendingRecipient[];
    recipients.push(...rows);
    if (rows.length < PAGE_SIZE) return recipients;
  }
  throw new Error("Pending campaign queue exceeded the supported validation snapshot size.");
}

async function loadCachedResults(emails: readonly string[]) {
  const client = supabaseAdminClient();
  const results: { email: string; status: string; verificado_em: string }[] = [];
  for (const batch of makeBatches(emails)) {
    const { data, error } = await client
      .from("verificacao_email")
      .select("email,status,verificado_em")
      .in("email", batch);
    if (error) throw error;
    results.push(...(data ?? []));
  }
  return results;
}

function formatInvalidAddress(email: string): boolean {
  return !isSafeEmailForExternalValidation(email);
}

function quoteFromCounts(
  pendingRows: number,
  cacheRows: readonly { email: string; verificado_em: string }[],
  eligibleEmails: readonly string[],
  invalidEmails: number,
  credits: number,
  activeJob: unknown,
) {
  const cacheByEmail = new Map(cacheRows.map((row) => [row.email, row.verificado_em]));
  const cachedEligible = eligibleEmails.filter((email) => cacheByEmail.has(email));
  const oldest = cachedEligible
    .map((email) => cacheByEmail.get(email)!)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return GetCampaignEmailValidationQuoteResponse.parse({
    pendentes: pendingRows,
    cacheados: cachedEligible.length,
    a_verificar: eligibleEmails.length - cachedEligible.length,
    formato_invalido: invalidEmails,
    creditos: credits,
    creditos_faltantes: Math.max(0, eligibleEmails.length - cachedEligible.length - credits),
    cache_mais_antigo_em: oldest,
    job_ativo: activeJob,
  });
}

async function getJobOverview(
  jobId: string,
  responseSchema:
    | typeof GetCampaignEmailValidationJobResponse
    | typeof StartCampaignEmailValidationResponse
    | typeof ResumeCampaignEmailValidationJobResponse,
) {
  const { data, error } = await supabaseAdminClient().rpc(
    "resumo_job_validacao_email",
    { p_job_id: jobId },
  );
  if (error) throw error;
  if (!data) return null;
  return responseSchema.parse(data);
}

async function loadQuote(campaignId: string) {
  const client = supabaseAdminClient();
  const [recipients, activeResult, credits] = await Promise.all([
    loadPendingRecipients(campaignId),
    client
      .from("validacao_email_job")
      .select("id")
      .eq("campanha_id", campaignId)
      .in("status", ACTIVE_JOB_STATUSES)
      .maybeSingle(),
    getZeroBounceCredits(),
  ]);
  if (activeResult.error) throw activeResult.error;

  const eligible = new Set<string>();
  const invalid = new Set<string>();
  for (const recipient of recipients) {
    if (formatInvalidAddress(recipient.email)) {
      invalid.add(normalizeEmail(recipient.email) || recipient.email);
    } else {
      eligible.add(normalizeEmail(recipient.email));
    }
  }
  const cache = await loadCachedResults([...eligible]);
  const activeJob = activeResult.data?.id
    ? await getJobOverview(activeResult.data.id, GetCampaignEmailValidationJobResponse)
    : null;
  return quoteFromCounts(
    recipients.length,
    cache,
    [...eligible],
    invalid.size,
    credits,
    activeJob,
  );
}

function conflict(res: Response, message: string, quote: unknown) {
  res.status(409).json({ error: message, cotacao: quote });
}

function publicError(error: unknown): string {
  if (error instanceof ZeroBounceError && /ZEROBOUNCE_API_KEY/u.test(error.message)) {
    return "Configure ZEROBOUNCE_API_KEY no Repl do servidor da API.";
  }
  return "Não foi possível consultar a validação de e-mail agora. Tente novamente.";
}

router.get("/campaigns/:campaignId/email-validation/quote", async (req, res) => {
  const params = GetCampaignEmailValidationQuoteParams.safeParse(req.params);
  if (!params.success) {
    res.status(422).json({ error: "Identificador da campanha inválido." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada." });
      return;
    }
    if (!(await findCampaign(params.data.campaignId))) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    res.json(await loadQuote(params.data.campaignId));
  } catch (error) {
    req.log.error({ technicalError: getTechnicalError(error) }, "Campaign email validation quote failed");
    res.status(503).json({ error: publicError(error) });
  }
});

router.post("/campaigns/:campaignId/email-validation/jobs", async (req, res) => {
  const params = StartCampaignEmailValidationParams.safeParse(req.params);
  const body = StartCampaignEmailValidationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(422).json({ error: "Confirmação da cotação inválida." });
    return;
  }
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada." });
      return;
    }
    if (!(await findCampaign(params.data.campaignId))) {
      res.status(404).json({ error: "Campanha não encontrada." });
      return;
    }
    const quote = await loadQuote(params.data.campaignId);
    if (
      quote.pendentes !== body.data.pendentes_confirmados ||
      quote.a_verificar !== body.data.custo_confirmado
    ) {
      conflict(res, "A fila ou o custo mudou. Revise a nova cotação antes de continuar.", quote);
      return;
    }
    if (quote.job_ativo) {
      conflict(res, "Já existe uma validação ativa para esta campanha.", quote);
      return;
    }
    if (quote.creditos_faltantes > 0) {
      conflict(res, "O saldo ZeroBounce não cobre o custo estimado.", quote);
      return;
    }
    const { data: jobId, error } = await supabaseAdminClient().rpc(
      "criar_job_validacao_email",
      {
        p_campanha_id: params.data.campaignId,
        p_total_pendentes_esperado: quote.pendentes,
        p_custo_estimado: quote.a_verificar,
        p_creditos_no_inicio: quote.creditos,
        p_actor_id: session.user.id,
        p_actor_nome: session.user.name,
        p_actor_email: session.user.email,
      },
    );
    if (error) {
      if (
        /queue_changed|validation_job_active|recipients_processing|campaign_finished|empty_queue/u.test(
          error.message,
        )
      ) {
        const refreshed = await loadQuote(params.data.campaignId);
        conflict(res, "A fila mudou ou não pode ser validada neste momento. Revise a cotação.", refreshed);
        return;
      }
      throw error;
    }
    try {
      await recordAuditEvent({
        actor: teamAuditActor(session.user),
        action: "campaign_email_validation_started",
        entityType: "campaign",
        entityId: params.data.campaignId,
        metadata: {
          job_id: jobId,
          total_pendentes: quote.pendentes,
          custo_estimado: quote.a_verificar,
        },
      });
    } catch (auditError) {
      req.log.error(
        { technicalError: getTechnicalError(auditError), jobId },
        "Campaign email validation was created but its audit event failed",
      );
    }
    const response = await getJobOverview(String(jobId), StartCampaignEmailValidationResponse);
    if (!response) throw new Error("Created email validation job could not be loaded.");
    res.status(202).json(response);
  } catch (error) {
    req.log.error({ technicalError: getTechnicalError(error) }, "Campaign email validation start failed");
    res.status(503).json({ error: publicError(error) });
  }
});

router.get(
  "/campaigns/:campaignId/email-validation/jobs/:jobId",
  async (req, res) => {
    const params = GetCampaignEmailValidationJobParams.safeParse(req.params);
    if (!params.success) {
      res.status(422).json({ error: "Identificadores inválidos." });
      return;
    }
    try {
      const session = await getSupabaseUser(req, res);
      if (!session) {
        res.status(401).json({ error: "Sessão expirada." });
        return;
      }
      const { data, error } = await supabaseAdminClient()
        .from("validacao_email_job")
        .select("id")
        .eq("id", params.data.jobId)
        .eq("campanha_id", params.data.campaignId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "Validação não encontrada." });
        return;
      }
      const job = await getJobOverview(
        params.data.jobId,
        GetCampaignEmailValidationJobResponse,
      );
      if (!job) {
        res.status(404).json({ error: "Validação não encontrada." });
        return;
      }
      res.json(job);
    } catch (error) {
      req.log.error({ technicalError: getTechnicalError(error) }, "Campaign email validation progress failed");
      res.status(503).json({ error: "Não foi possível consultar o progresso da validação." });
    }
  },
);

router.post(
  "/campaigns/:campaignId/email-validation/jobs/:jobId/resume",
  async (req, res) => {
    const params = ResumeCampaignEmailValidationJobParams.safeParse(req.params);
    if (!params.success) {
      res.status(422).json({ error: "Identificadores inválidos." });
      return;
    }
    try {
      const session = await getSupabaseUser(req, res);
      if (!session) {
        res.status(401).json({ error: "Sessão expirada." });
        return;
      }
      const client = supabaseAdminClient();
      const { data: job, error: jobError } = await client
        .from("validacao_email_job")
        .select("id,campanha_id,status")
        .eq("id", params.data.jobId)
        .eq("campanha_id", params.data.campaignId)
        .maybeSingle();
      if (jobError) throw jobError;
      if (!job) {
        res.status(404).json({ error: "Validação não encontrada." });
        return;
      }
      const { data: remainingItems, error: itemsError } = await client
        .from("validacao_email_job_item")
        .select("email,email_normalizado,status")
        .eq("job_id", job.id)
        .in("status", ["pendente", "erro"]);
      if (itemsError) throw itemsError;
      const validEmails = new Set<string>();
      for (const item of remainingItems ?? []) {
        const email = item.email_normalizado ?? normalizeEmail(item.email ?? "");
        if (email && !formatInvalidAddress(item.email ?? "")) validEmails.add(email);
      }
      const cached = await loadCachedResults([...validEmails]);
      const cachedSet = new Set(cached.map((item) => item.email));
      const cost = [...validEmails].filter((email) => !cachedSet.has(email)).length;
      const credits = await getZeroBounceCredits();
      const quote = quoteFromCounts(
        validEmails.size,
        cached,
        [...validEmails],
        0,
        credits,
        await getJobOverview(job.id, GetCampaignEmailValidationJobResponse),
      );
      if (quote.creditos_faltantes > 0) {
        conflict(res, "O saldo ZeroBounce não cobre as verificações restantes.", quote);
        return;
      }
      const { data: resumed, error: resumeError } = await client.rpc(
        "retomar_job_validacao_email",
        { p_job_id: job.id },
      );
      if (resumeError) throw resumeError;
      if (!resumed) {
        conflict(res, "Esta validação não está pausada e não pode ser retomada.", quote);
        return;
      }
      try {
        await recordAuditEvent({
          actor: teamAuditActor(session.user),
          action: "campaign_email_validation_resumed",
          entityType: "campaign",
          entityId: params.data.campaignId,
          metadata: { job_id: job.id, remaining_cost_estimate: cost },
        });
      } catch (auditError) {
        req.log.error(
          { technicalError: getTechnicalError(auditError), jobId: job.id },
          "Campaign email validation was resumed but its audit event failed",
        );
      }
      const response = await getJobOverview(job.id, ResumeCampaignEmailValidationJobResponse);
      if (!response) throw new Error("Resumed email validation job could not be loaded.");
      res.status(202).json(response);
    } catch (error) {
      req.log.error({ technicalError: getTechnicalError(error) }, "Campaign email validation resume failed");
      res.status(503).json({ error: publicError(error) });
    }
  },
);

export default router;
