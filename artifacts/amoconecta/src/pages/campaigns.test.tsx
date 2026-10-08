// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRecipientSummary } from "@workspace/api-client-react";
import type { EmailBlock } from "@workspace/email-template";
import {
  campaignCancelSuccessMessage,
  ImportPanel,
  RecipientSummaryPanel,
} from "./campaigns";
import { creditContentWarning } from "../lib/credit-content-warning";

const campaignId = "campaign-under-test";
const recipientSummaryUrl = `/api/campaigns/${campaignId}/recipients/summary`;
const uploadUrlEndpoint = `/api/campaigns/${campaignId}/imports/upload-url`;
const mappingLookupEndpoint = `/api/campaigns/${campaignId}/imports/mapping-lookup`;
const validateEndpoint = `/api/campaigns/${campaignId}/imports/validate`;
const importJobEndpoint = `/api/campaigns/${campaignId}/imports/import-job-under-test`;
const confirmEndpoint = `${importJobEndpoint}/confirm`;
const cancelEndpoint = `${importJobEndpoint}/cancel`;
const signedUploadUrl = "https://storage.example.test/signed-upload";

let fetchMock: ReturnType<typeof vi.fn>;
let existingRecipientCount = 0;
let savedMapping: string[] | null = null;
let validateJobResponse: Record<string, unknown>;
let importJobResponse: Record<string, unknown>;

function responseJson(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function getRequestUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function makeCsvFile(header: string) {
  return new File(
    [`${header}\nJoana;joana@example.com;11999999999`],
    "destinatarios.csv",
    { type: "text/csv" },
  );
}

function makeImportSummary(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    storage_path: `${campaignId}/destinatarios.csv`,
    total_linhas: 1,
    linhas_importadas: 1,
    linhas_descartadas: 0,
    colunas_ignoradas: 0,
    data_referencia_rotulo: "Último acesso",
    amostras_emails_invalidos: [],
    amostras_datas_invalidas: [],
    amostras_datas_ausentes: [],
    validos: 1,
    invalidos: 0,
    novos: 1,
    atualizados: 0,
    duplicados_no_arquivo: 0,
    duplicados_email: 0,
    duplicados_telefone: 0,
    suprimidos: 0,
    emails_invalidos: 0,
    datas_invalidas: 1,
    datas_ausentes: 0,
    datas_ausentes_percentual: 0,
    nomes_ausentes: 0,
    telefones_invalidos: 0,
    destinatarios_salvos: 1,
    recencia: [],
    amostras_erros: [],
    ...overrides,
  };
}

function makeImportJob(
  status: string,
  resultado: Record<string, unknown> | null = null,
): Record<string, unknown> {
  return {
    id: "import-job-under-test",
    campanha_id: campaignId,
    caminho_arquivo: `${campaignId}/destinatarios.csv`,
    status,
    linhas_processadas: 0,
    total_linhas: status === "aguardando_confirmacao" ? 1 : null,
    resultado,
    erro: null,
    criado_em: "2026-10-08T12:00:00.000Z",
    concluido_em: null,
  };
}

function renderImportPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportPanel campaignId={campaignId} />
    </QueryClientProvider>,
  );
}

async function selectCsv(header: string) {
  fireEvent.change(screen.getByTestId("input-import-csv"), {
    target: { files: [makeCsvFile(header)] },
  });
}

function mutationRequests(endpoint: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      getRequestUrl(input as RequestInfo | URL) === endpoint &&
      (init as RequestInit | undefined)?.method === "POST",
  );
}

beforeEach(() => {
  existingRecipientCount = 0;
  savedMapping = null;
  validateJobResponse = makeImportJob("pendente");
  importJobResponse = makeImportJob("pendente");
  fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = getRequestUrl(input);
      const method = init?.method ?? "GET";

      if (url === recipientSummaryUrl && method === "GET") {
        return responseJson({
          total_na_lista: existingRecipientCount,
          total: existingRecipientCount,
          data_referencia_tipo: null,
          data_referencia_rotulo: "Data de referência (sem rótulo)",
        });
      }
      if (url === mappingLookupEndpoint && method === "POST") {
        return responseJson({ mapeamento: savedMapping });
      }
      if (url === uploadUrlEndpoint && method === "POST") {
        return responseJson({
          signed_url: signedUploadUrl,
          path: "imports/campaign-under-test/destinatarios.csv",
        });
      }
      if (url === signedUploadUrl && method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (url === validateEndpoint && method === "POST") {
        return responseJson(validateJobResponse);
      }
      if (
        url === importJobEndpoint &&
        method === "GET"
      ) {
        return responseJson(importJobResponse);
      }
      if (url === confirmEndpoint && method === "POST") {
        importJobResponse = makeImportJob("pendente");
        return responseJson(importJobResponse);
      }
      if (url === cancelEndpoint && method === "POST") {
        importJobResponse = makeImportJob("cancelada");
        return responseJson(importJobResponse);
      }

      throw new Error(`Unexpected fetch in import panel test: ${method} ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("campaign CSV import confirmation", () => {
  it("requires only an email mapping and keeps the existing-list decision separate", async () => {
    existingRecipientCount = 4;
    renderImportPanel();
    await selectCsv("user_name;user_email;user_phone");

    await screen.findByTestId("panel-csv-mapping");
    await waitFor(() => {
      expect(
        (screen.getByTestId("select-import-target-1") as HTMLSelectElement).value,
      ).toBe("email");
    });
    expect(screen.queryByTestId("status-missing-order-date-warning")).toBeNull();
    expect(screen.getByTestId("status-existing-recipients-warning")).toBeTruthy();
    expect(
      screen.getByTestId("status-import-email-mapping").textContent,
    ).toContain("único campo obrigatório");

    const validateButton = screen.getByTestId("button-validate-import");
    expect((validateButton as HTMLButtonElement).disabled).toBe(true);
    expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(0);
    expect(mutationRequests(validateEndpoint)).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-confirm-import-sum"));
    await waitFor(() => {
      expect((validateButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(validateButton);

    await waitFor(() => {
      expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(1);
      expect(mutationRequests(validateEndpoint)).toHaveLength(1);
    });
    const validationBody = JSON.parse(
      (mutationRequests(validateEndpoint)[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(validationBody.cabecalhos).toEqual([
      "user_name",
      "user_email",
      "user_phone",
    ]);
    expect(validationBody.mapeamento).toEqual(["name", "email", "phone"]);
    expect(validationBody.data_referencia_tipo).toBeNull();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          getRequestUrl(input as RequestInfo | URL) === signedUploadUrl &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(true);
  });

  it("reuses a saved mapping for matching normalized headers", async () => {
    savedMapping = ["email", "ignore", "ignore"];
    renderImportPanel();
    await selectCsv("Mystery;Contact;Extra");

    await waitFor(() => {
      expect(
        (screen.getByTestId("select-import-target-0") as HTMLSelectElement).value,
      ).toBe("email");
    });
    expect(mutationRequests(mappingLookupEndpoint)).toHaveLength(1);
  });

  it("requires a date meaning and an explicit decision before importing unparseable dates", async () => {
    validateJobResponse = makeImportJob("pendente");
    importJobResponse = makeImportJob(
      "aguardando_confirmacao",
      makeImportSummary({
        amostras_datas_invalidas: [
          {
            linha: 2,
            valor: "31 de fevereiro de 2026",
            email: "joana@example.com",
          },
        ],
      }),
    );
    renderImportPanel();
    await selectCsv("Email;Nome;Data do último acesso");

    await screen.findByTestId("panel-csv-mapping");
    const validateButton = screen.getByTestId("button-validate-import");
    expect((validateButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("select-import-reference-date-type"), {
      target: { value: "acesso" },
    });
    await waitFor(() => {
      expect((validateButton as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(validateButton);

    const decision = await screen.findByTestId("panel-invalid-date-confirmation");
    expect(decision.textContent).toContain("1 data(s) não reconhecida(s)");
    expect(decision.textContent).toContain("31 de fevereiro de 2026");
    expect(decision.textContent).toContain("Nenhum destinatário foi salvo");

    fireEvent.click(screen.getByTestId("button-confirm-invalid-dates"));
    await waitFor(() => {
      expect(mutationRequests(confirmEndpoint)).toHaveLength(1);
    });
    expect(
      JSON.parse(
        (mutationRequests(confirmEndpoint)[0][1] as RequestInit).body as string,
      ),
    ).toEqual({ continuar_com_datas_invalidas: true });
  });

  it("cancels an invalid-date preflight without importing recipients", async () => {
    importJobResponse = makeImportJob(
      "aguardando_confirmacao",
      makeImportSummary({
        amostras_datas_invalidas: [
          { linha: 2, valor: "not a date", email: "joana@example.com" },
        ],
      }),
    );
    renderImportPanel();
    await selectCsv("Email;Nome;Data do último acesso");
    await screen.findByTestId("panel-csv-mapping");
    fireEvent.change(screen.getByTestId("select-import-reference-date-type"), {
      target: { value: "acesso" },
    });
    fireEvent.click(screen.getByTestId("button-validate-import"));

    await screen.findByTestId("panel-invalid-date-confirmation");
    fireEvent.click(screen.getByTestId("button-cancel-invalid-dates"));
    await screen.findByTestId("status-import-cancelled");

    expect(mutationRequests(cancelEndpoint)).toHaveLength(1);
    expect(mutationRequests(confirmEndpoint)).toHaveLength(0);
  });
});

describe("campaign cancellation feedback", () => {
  it("distinguishes an unsent draft reset from a terminal cancellation", () => {
    expect(campaignCancelSuccessMessage("rascunho")).toContain(
      "Nenhum e-mail havia sido enviado",
    );
    expect(campaignCancelSuccessMessage("cancelada")).toContain(
      "estado terminal",
    );
  });
});

describe("campaign recipient summary", () => {
  it("shows bounce as a status and renders corrected rate bases", () => {
    const summary = {
        total: 43,
        total_na_lista: 43,
      status: {
        pendente: 0,
        enviado: 1,
        entregue: 32,
        bounce: 6,
        bloqueado: 2,
        suprimido: 0,
        erro: 2,
      },
      reputacao: {
        total_enviado: 39,
        total_entregue: 32,
        bounce: {
          quantidade: 6,
          percentual: 15.38,
          limite_percentual: 2,
        },
        reclamacao: {
          quantidade: 0,
          percentual: 0,
          limite_percentual: 0.2,
        },
      },
      metricas_email: {
        enviados: { quantidade: 39, percentual: (39 / 43) * 100 },
        entregues: { quantidade: 32, percentual: (32 / 39) * 100 },
        aberturas: { quantidade: 20, percentual: (20 / 32) * 100 },
        cliques: { quantidade: 8, percentual: (8 / 32) * 100 },
        bounces: { quantidade: 6, percentual: (6 / 39) * 100 },
        bounces_permanentes: { quantidade: 6, percentual: (6 / 39) * 100 },
        bounces_temporarios: { quantidade: 0, percentual: 0 },
        bounces_indeterminados: { quantidade: 0, percentual: 0 },
        reclamacoes: { quantidade: 0, percentual: 0 },
        descadastros: { quantidade: 0, percentual: 0 },
      },
      recencia: [],
    } as unknown as CampaignRecipientSummary;

    render(
      <RecipientSummaryPanel
        summary={summary}
        loading={false}
        onClear={() => undefined}
        confirmClear={false}
        onCancelClear={() => undefined}
        canClear
        clearPending={false}
      />,
    );

    const displayedStatusTotal = [
      "pendente",
      "enviado",
      "entregue",
      "bounce",
      "bloqueado",
      "suprimido",
      "erro",
    ].reduce((total, status) => {
      const card = screen.getByTestId(`recipient-status-${status}`);
      return total + Number(card.querySelector("strong")?.textContent);
    }, 0);

    expect(displayedStatusTotal).toBe(43);
    expect(screen.getByTestId("recipient-status-bloqueado").textContent).toContain("2");
    expect(screen.getByTestId("recipient-status-bounce").textContent).toContain("6");
    expect(screen.getByTestId("recipient-status-entregue").textContent).toContain("Status atual: entregue");
    expect(screen.getByTestId("recipient-email-metric-enviados").textContent).toContain(
      "90,7% sobre lista",
    );
    expect(screen.getByTestId("recipient-email-metric-entregues").textContent).toContain(
      "82,05% sobre enviados",
    );
    expect(screen.getByTestId("recipient-email-metric-entregues").textContent).toContain(
      "Entrega confirmada em algum momento",
    );
    expect(screen.getByTestId("panel-email-engagement").textContent).toContain(
      "antes de mudar para bounce",
    );
    expect(screen.getByTestId("recipient-reputation-bounce").textContent).toContain(
      "Acima do limite",
    );
  });
});

describe("credit content warnings", () => {
  const textBlock = (html: string): EmailBlock => ({ id: "text-1", type: "text", html });

  it("warns when the body promises a credit value but the field is empty", () => {
    expect(creditContentWarning([textBlock("<p>Você tem <strong>R$5</strong> de crédito!</p>")], null))
      .toContain("campo “Valor do crédito” está vazio");
  });

  it("accepts a template variable or a matching amount in Brazilian format", () => {
    expect(creditContentWarning([textBlock("<p>Você tem {{valor_credito}} de crédito!</p>")], 5))
      .toBeNull();
    expect(creditContentWarning([textBlock("<p>Você recebeu R$ 1.234,50.</p>")], 1234.5))
      .toBeNull();
    expect(creditContentWarning([textBlock("<p>Você recebeu 5 reais.</p>")], 5))
      .toBeNull();
  });

  it("warns when a filled field is missing from the body or differs from its amount", () => {
    expect(creditContentWarning([textBlock("<p>Confira sua conta.</p>")], 5))
      .toContain("não informa um valor em reais");
    expect(creditContentWarning([textBlock("<p>Você tem R$ 7,00 de crédito!</p>")], 5))
      .toContain("corpo menciona");
  });
});