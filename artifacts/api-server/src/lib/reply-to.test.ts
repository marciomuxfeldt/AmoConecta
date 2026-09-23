import assert from "node:assert/strict";
import test from "node:test";
import { sendBatch, type WorkerRecipient } from "./worker";

const originalFetch = globalThis.fetch;
const originalEnvironment = new Map(
  ["APP_BASE_URL", "SENDER_EMAIL", "SENDER_NAME", "UNSUBSCRIBE_SECRET", "REPLY_TO_EMAIL"].map(
    (name) => [name, process.env[name]],
  ),
);

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("omits Reply-To when neither the campaign nor the environment configures one", async () => {
  process.env.APP_BASE_URL = "https://amoconecta.example";
  process.env.SENDER_EMAIL = "envios@marketing.amo.delivery";
  process.env.SENDER_NAME = "Amo Ofertas";
  process.env.UNSUBSCRIBE_SECRET = "test-unsubscribe-secret";
  delete process.env.REPLY_TO_EMAIL;

  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "resend-test-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const recipient: WorkerRecipient = {
    id: "recipient-1",
    campanha_id: "campaign-1",
    email: "cliente@example.com",
    nome: "Cliente",
    status: "processando",
    tentativas: 1,
    resend_email_id: null,
  };
  await sendBatch(
    {
      id: "campaign-1",
      nome: "Campanha",
      assunto: "Oferta",
      remetente_nome: "Amo Ofertas",
      remetente_email: "envios@marketing.amo.delivery",
      corpo: [],
      status: "enviando",
      teto_hora: 100,
      teto_dia: 1000,
    },
    [recipient],
  );

  assert.ok(requestBody);
  const payload = requestBody as Record<string, unknown>;
  assert.equal(payload.reply_to, undefined);
  assert.equal(payload.from, "Amo Ofertas <envios@marketing.amo.delivery>");
});