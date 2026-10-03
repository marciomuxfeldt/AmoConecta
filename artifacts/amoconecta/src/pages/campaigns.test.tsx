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
const validateEndpoint = `/api/campaigns/${campaignId}/imports/validate`;
const signedUploadUrl = "https://storage.example.test/signed-upload";

let fetchMock: ReturnType<typeof vi.fn>;
let existingRecipientCount = 0;

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
  fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = getRequestUrl(input);
      const method = init?.method ?? "GET";

      if (url === recipientSummaryUrl && method === "GET") {
        return responseJson({
          total_na_lista: existingRecipientCount,
          total: existingRecipientCount,
        });
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
        return responseJson({
          id: "import-job-under-test",
          status: "pendente",
          linhas_processadas: 0,
          total_linhas: null,
        });
      }
      if (
        url === `/api/campaigns/${campaignId}/imports/import-job-under-test` &&
        method === "GET"
      ) {
        return responseJson({
          id: "import-job-under-test",
          status: "pendente",
          linhas_processadas: 0,
          total_linhas: null,
        });
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
  it("waits for the missing-date decision before upload and keeps recipient confirmation separate", async () => {
    existingRecipientCount = 4;
    renderImportPanel();
    await selectCsv("user_name;user_email;user_phone");

    const dateWarning = await screen.findByTestId(
      "status-missing-order-date-warning",
    );
    expect(dateWarning.textContent).toContain("ponto e vírgula (;)");
    expect(screen.getByTestId("status-existing-recipients-warning")).toBeTruthy();

    const validateButton = screen.getByTestId("button-validate-import");
    expect((validateButton as HTMLButtonElement).disabled).toBe(true);
    expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(0);
    expect(mutationRequests(validateEndpoint)).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-confirm-missing-order-date"));
    expect((validateButton as HTMLButtonElement).disabled).toBe(true);
    expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(0);
    expect(mutationRequests(validateEndpoint)).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-confirm-import-sum"));
    expect((validateButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(validateButton);

    await waitFor(() => {
      expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(1);
      expect(mutationRequests(validateEndpoint)).toHaveLength(1);
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          getRequestUrl(input as RequestInfo | URL) === signedUploadUrl &&
          (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toBe(true);
  });

  it("clears the selected CSV when the operator cancels the missing-date warning", async () => {
    renderImportPanel();
    await selectCsv("user_name;user_email;user_phone");

    await screen.findByTestId("status-missing-order-date-warning");
    fireEvent.click(screen.getByTestId("button-cancel-missing-order-date"));

    await waitFor(() => {
      expect(screen.queryByTestId("status-missing-order-date-warning")).toBeNull();
      expect(screen.getByText("Solte o CSV aqui ou escolha um arquivo")).toBeTruthy();
    });
    expect((screen.getByTestId("input-import-csv") as HTMLInputElement).value).toBe(
      "",
    );
    expect((screen.getByTestId("button-validate-import") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(0);
    expect(mutationRequests(validateEndpoint)).toHaveLength(0);
  });

  it("does not show the date warning for a dated CSV and still requires the existing-recipient decision", async () => {
    existingRecipientCount = 3;
    renderImportPanel();
    await selectCsv("user_name;user_email;last_order_date");

    await waitFor(() => {
      expect(screen.queryByTestId("status-missing-order-date-warning")).toBeNull();
      expect(screen.getByTestId("status-existing-recipients-warning")).toBeTruthy();
    });
    const validateButton = screen.getByTestId("button-validate-import");
    expect((validateButton as HTMLButtonElement).disabled).toBe(true);
    expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(0);
    expect(mutationRequests(validateEndpoint)).toHaveLength(0);

    fireEvent.click(screen.getByTestId("button-confirm-import-sum"));
    expect((validateButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(validateButton);

    await waitFor(() => {
      expect(mutationRequests(uploadUrlEndpoint)).toHaveLength(1);
      expect(mutationRequests(validateEndpoint)).toHaveLength(1);
    });
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
        bloqueado: 0,
        suprimido: 0,
        erro: 4,
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