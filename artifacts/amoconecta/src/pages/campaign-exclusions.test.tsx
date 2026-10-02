// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampaignExclusionOverview } from "@workspace/api-client-react";
import {
  CampaignExclusionPanel,
  ImportDataQualityNotices,
  ResumeDiagnostics,
  auditExtraDescription,
  missingDateShare,
  rateToPercent,
} from "../components/CampaignExclusionPanel";

const period = { enviados: 300, entregues: 290, bounces_permanentes: 6, reclamacoes: 1, taxa_bounce: 0.02, taxa_reclamacao: 0.0034 };
const overview: CampaignExclusionOverview = {
  provedores: ["gmail", "microsoft", "yahoo", "outros"].map((p) => ({
    provedor: p as "gmail", total: 100, pendentes: 50, excluidos: 5, enviados: 40, entregues: 38,
    bounces: 2, bounces_permanentes: 1, taxa_bounce: 0.05, taxa_bounce_permanente: 0.025,
  })),
  excluidos: [{ id: "r1", email: "a@x.com", nome: null, status: "excluido", excluido_em: "2024-01-01T10:00:00Z", exclusao_motivo: "teste", excluido_por_nome: "Ana", excluido_por_email: null }],
  total_excluidos: 1, pendentes_na_fila: 77, exclusoes_desde_pausa: 0,
  retomada_em: null, retomada_enviados_base: null,
  acumulada: period, periodo_atual: { ...period, taxa_bounce: 0.01 },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderPanel(status: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ alterados: 3, lembretes_alterados: 0, em_processamento: 1, ja_processados: 0, nao_encontrados: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={qc}>
      <CampaignExclusionPanel campaignId="c1" campaignStatus={status} offset={0} onOffsetChange={() => undefined}
        query={{ data: overview, isLoading: false, isError: false, error: null, refetch: () => undefined }} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("exclusion panel", () => {
  it("shows provider totals, side-by-side reputation as percentages and the sample caveat", () => {
    renderPanel("pausada");
    expect(screen.getByTestId("row-provider-yahoo")).toBeTruthy();
    expect(screen.getByTestId("reputation-cumulative-bounce").textContent).toBe("2%");
    expect(screen.getByTestId("reputation-current-bounce").textContent).toBe("1%");
    expect(screen.getByTestId("text-provider-sample-gmail").textContent).toContain("amostra pequena");
    expect(screen.getByTestId("text-reputation-triggers").textContent).toContain("nenhuma avaliação");
  });

  it("requires confirmation, warns about in-flight sends, then posts the exclusion", async () => {
    const fetchMock = renderPanel("pausada");
    fireEvent.click(screen.getByTestId("checkbox-exclude-provider-gmail"));
    fireEvent.change(screen.getByTestId("input-exclude-motivo"), { target: { value: "Decisão do operador" } });
    fireEvent.click(screen.getByTestId("button-exclude-review"));
    expect(screen.getByTestId("text-exclude-processing-warning")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-exclude-confirm"));
    await waitFor(() => expect(screen.getByTestId("status-exclude-result")).toBeTruthy());
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ motivo: "Decisão do operador", provedores: ["gmail"] });
  });

  it("disables exclusion restore after completion and confirms before restoring", () => {
    cleanup();
    renderPanel("concluida");
    expect((screen.getByTestId("button-restore-r1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("button-restore-all") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderPanel("pausada");
    fireEvent.click(screen.getByTestId("button-restore-r1"));
    expect(screen.getByTestId("dialog-restore-confirmation")).toBeTruthy();
  });
});

describe("resume diagnostics and notices", () => {
  it("warns when nothing was excluded since the pause and shows retry on error", () => {
    const onRetry = vi.fn();
    render(<ResumeDiagnostics rates={{ bounce: 0.05, complaint: 0 }} overview={overview} loading={false} error={false} onRetry={onRetry} />);
    expect(screen.getByTestId("status-resume-no-exclusions-warning")).toBeTruthy();
    expect(screen.getByTestId("text-resume-remaining-queue").textContent).toContain("77");
    cleanup();
    render(<ResumeDiagnostics rates={{}} loading={false} error onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId("button-resume-diagnostics-retry"));
    expect(onRetry).toHaveBeenCalled();
  });

  it("computes the missing-date share and renders typo suggestions without altering emails", () => {
    const share = missingDateShare({ total: 100, total_na_lista: 100, recencia: [{ faixa: "Sem data", quantidade: 25 }] } as never);
    expect(share?.percent).toBe(25);
    render(<ImportDataQualityNotices summary={{ datas_ausentes: 25, datas_ausentes_percentual: 25, dominios_suspeitos_total: 1, dominios_suspeitos: [{ linha: 4, email: "a@gmial.com", sugestao: "a@gmail.com" }] } as never} />);
    expect(screen.getByTestId("status-import-missing-dates-warning").textContent).toContain("telefone");
    expect(screen.getByTestId("row-suspicious-domain-4").textContent).toContain("a@gmail.com");
  });

  it("formats rates and audit metadata", () => {
    expect(rateToPercent(0.0425)).toBe("4,25%");
    expect(auditExtraDescription("campaign_resumed", { complaint_rate: 0.005, base_enviados: 1200 })).toContain("base de 1.200");
    expect(auditExtraDescription("campaign_recipients_excluded", { alterados: 4 })).toContain("4 destinatários");
  });
});
