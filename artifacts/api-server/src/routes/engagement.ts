import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateBiExportBody,
  CreateBiExportResponse,
  DownloadBiExportParams,
  GetBiExportParams,
  GetBiExportResponse,
  GetEmailBrandingResponse,
  GetEngagementSummaryResponse,
  ListBiExportsResponse,
  UpdateEmailBrandingBody,
  UpdateEmailBrandingResponse,
} from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";
import {
  countChronicDisengagedContacts,
  getEmailBrandingSettings,
  updateEmailBrandingSettings,
} from "../lib/email-branding";
import { openBiExportCsv } from "../lib/worker-export";
import { getTechnicalError } from "../lib/technical-error";

const router: IRouter = Router();
const BI_EXPORT_COLUMNS =
  "id,campanha_id,status,filtro,periodo_inicio,periodo_fim,linhas_processadas,total_linhas,caminho_objeto,erro,criado_em,concluido_em,expira_em";
const BI_EXPORT_FILTERS = new Set([
  "todos",
  "clicaram",
  "abriram_sem_clicar",
  "nao_abriram",
  "bounce_ou_reclamacao",
]);

function reportError(req: Request, operation: string, error: unknown): void {
  req.log.error(
    { requestId: req.id, technicalError: getTechnicalError(error) },
    operation,
  );
}

function toBiExportResponse(row: Record<string, unknown>) {
  const expiresAt =
    typeof row.expira_em === "string" ? Date.parse(row.expira_em) : NaN;
  const available =
    row.status === "concluida" &&
    typeof row.caminho_objeto === "string" &&
    row.caminho_objeto.length > 0 &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now();
  const safeError =
    row.status === "erro"
      ? "Não foi possível gerar esta exportação. Tente novamente."
      : null;
  return GetBiExportResponse.parse({
    id: row.id,
    campanha_id: row.campanha_id ?? null,
    filtro: BI_EXPORT_FILTERS.has(String(row.filtro)) ? row.filtro : "todos",
    periodo_inicio: row.periodo_inicio ?? null,
    periodo_fim: row.periodo_fim ?? null,
    status: row.status,
    total_linhas: row.total_linhas ?? null,
    linhas_processadas: row.linhas_processadas ?? 0,
    criado_em: row.criado_em,
    concluido_em: row.concluido_em ?? null,
    expira_em: row.expira_em ?? null,
    erro: safeError,
    disponivel_para_download: available,
  });
}

async function requireSession(req: Request, res: Response): Promise<boolean> {
  return Boolean(await getSupabaseUser(req, res));
}

router.get("/email-branding", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  try {
    const settings = await getEmailBrandingSettings();
    res.json(GetEmailBrandingResponse.parse(settings));
  } catch (error) {
    reportError(req, "Email branding settings could not be loaded", error);
    res.status(503).json({
      error: "Aplique a migração final do AmoConecta para carregar as configurações de e-mail.",
    });
  }
});

router.patch("/email-branding", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  const parsed = UpdateEmailBrandingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Informe uma cor hexadecimal válida." });
    return;
  }
  try {
    const settings = await updateEmailBrandingSettings(
      parsed.data.cor_botao_email,
    );
    res.json(UpdateEmailBrandingResponse.parse(settings));
  } catch (error) {
    reportError(req, "Email branding settings could not be updated", error);
    res.status(503).json({
      error: "Não foi possível salvar a cor global dos botões.",
    });
  }
});

router.get("/engagement/summary", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  try {
    const [count, stateResult] = await Promise.all([
      countChronicDisengagedContacts(),
      supabaseAdminClient()
        .from("estado_desengajamento")
        .select("calculado_em")
        .eq("id", 1)
        .maybeSingle(),
    ]);
    if (stateResult.error) throw stateResult.error;
    res.json(
      GetEngagementSummaryResponse.parse({
        desengajados_total: count,
        calculado_em: stateResult.data?.calculado_em ?? null,
      }),
    );
  } catch (error) {
    reportError(req, "Engagement summary could not be loaded", error);
    res.status(503).json({
      error: "Aplique a migração final do AmoConecta para carregar o resumo de engajamento.",
    });
  }
});

router.get("/bi-exports", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  try {
    const { data, error } = await supabaseAdminClient()
      .from("exportacao_csv")
      .select(BI_EXPORT_COLUMNS)
      .order("criado_em", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(
      ListBiExportsResponse.parse({
        jobs: (data ?? []).map((row) =>
          toBiExportResponse(row as Record<string, unknown>),
        ),
      }),
    );
  } catch (error) {
    reportError(req, "BI export jobs could not be listed", error);
    res.status(503).json({
      error: "Não foi possível carregar as exportações BI.",
    });
  }
});

router.post("/bi-exports", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  const parsed = CreateBiExportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Os filtros da exportação são inválidos." });
    return;
  }
  const { campanha_id, periodo_inicio, periodo_fim, filtro } = parsed.data;
  if (
    periodo_inicio &&
    periodo_fim &&
    Date.parse(`${periodo_fim}T00:00:00Z`) <
      Date.parse(`${periodo_inicio}T00:00:00Z`)
  ) {
    res.status(400).json({
      error: "A data final precisa ser igual ou posterior à data inicial.",
    });
    return;
  }
  if (campanha_id) {
    const { data: campaign, error } = await supabaseAdminClient()
      .from("campanha")
      .select("id")
      .eq("id", campanha_id)
      .maybeSingle();
    if (error) {
      reportError(req, "BI export campaign filter validation failed", error);
      res.status(503).json({ error: "Não foi possível validar a campanha." });
      return;
    }
    if (!campaign) {
      res.status(400).json({ error: "A campanha selecionada não existe." });
      return;
    }
  }
  try {
    const { data, error } = await supabaseAdminClient()
      .from("exportacao_csv")
      .insert({
        campanha_id,
        filtro,
        periodo_inicio,
        periodo_fim,
        status: "pendente",
      })
      .select(BI_EXPORT_COLUMNS)
      .single();
    if (error) throw error;
    res
      .status(202)
      .json(toBiExportResponse(data as Record<string, unknown>));
  } catch (error) {
    reportError(req, "BI export job could not be created", error);
    res.status(503).json({
      error: "Não foi possível solicitar a exportação BI.",
    });
  }
});

router.get("/bi-exports/:exportId", async (req, res): Promise<void> => {
  if (!(await requireSession(req, res))) return;
  const params = GetBiExportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Identificador de exportação inválido." });
    return;
  }
  try {
    const { data, error } = await supabaseAdminClient()
      .from("exportacao_csv")
      .select(BI_EXPORT_COLUMNS)
      .eq("id", params.data.exportId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "Exportação não encontrada." });
      return;
    }
    res.json(toBiExportResponse(data as Record<string, unknown>));
  } catch (error) {
    reportError(req, "BI export job could not be loaded", error);
    res.status(503).json({ error: "Não foi possível carregar a exportação." });
  }
});

router.get(
  "/bi-exports/:exportId/download",
  async (req, res): Promise<void> => {
    if (!(await requireSession(req, res))) return;
    const params = DownloadBiExportParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Identificador de exportação inválido." });
      return;
    }
    try {
      const { data, error } = await supabaseAdminClient()
        .from("exportacao_csv")
        .select("status,caminho_objeto,expira_em")
        .eq("id", params.data.exportId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        res.status(404).json({ error: "Exportação não encontrada." });
        return;
      }
      if (data.status !== "concluida" || !data.caminho_objeto) {
        res.status(404).json({ error: "O arquivo ainda não está disponível." });
        return;
      }
      if (
        typeof data.expira_em !== "string" ||
        Date.parse(data.expira_em) <= Date.now()
      ) {
        await supabaseAdminClient()
          .from("exportacao_csv")
          .update({ status: "expirada", caminho_objeto: null })
          .eq("id", params.data.exportId)
          .eq("status", "concluida");
        res.status(404).json({ error: "O arquivo expirou." });
        return;
      }

      const file = await openBiExportCsv(data.caminho_objeto);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="amoconecta-${params.data.exportId}.csv"`,
      );
      res.setHeader("Cache-Control", "private, no-store");
      file.once("error", (error: unknown) => {
        reportError(req, "BI export file stream failed", error);
        if (!res.headersSent) {
          res.status(502).json({ error: "Não foi possível ler o arquivo CSV." });
        } else {
          res.destroy(error instanceof Error ? error : undefined);
        }
      });
      file.pipe(res);
    } catch (error) {
      reportError(req, "BI export file could not be opened", error);
      if (!res.headersSent) {
        res.status(404).json({ error: "O arquivo CSV não está disponível." });
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    }
  },
);

export default router;