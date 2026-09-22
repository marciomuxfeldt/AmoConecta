import assert from "node:assert/strict";
import test from "node:test";
import {
  batchIdempotencyKey,
  idempotencyKey,
  sendResendMessages,
  type PreparedResendMessage,
} from "./resend-sender";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("keeps recipient keys stable when a recovered batch is recomposed", () => {
  const first = idempotencyKey("campaign-1", " Pessoa@Example.com ", false);
  const sameRecipient = idempotencyKey("campaign-1", "pessoa@example.com", false);
  const second = idempotencyKey("campaign-1", "outra@example.com", false);
  const third = idempotencyKey("campaign-1", "terceira@example.com", false);
  const originalBatchKey = batchIdempotencyKey([first, second]);

  assert.equal(first, sameRecipient);
  assert.equal(originalBatchKey, batchIdempotencyKey([first, second]));
  assert.notEqual(originalBatchKey, batchIdempotencyKey([first, third]));
  assert.notEqual(first, second);
});

test("sends one deterministic idempotency key per Resend request", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];

  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ id: `resend-${calls.length}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const messages: PreparedResendMessage[] = [
    {
      from: "envios@marketing.amo.delivery",
      to: ["primeira@example.com"],
      subject: "Oferta",
      html: "<p>Olá</p>",
      headers: {},
      _idempotencyKey: idempotencyKey("campaign-1", "primeira@example.com", false),
    },
    {
      from: "envios@marketing.amo.delivery",
      to: ["segunda@example.com"],
      subject: "Oferta",
      html: "<p>Olá</p>",
      headers: {},
      _idempotencyKey: idempotencyKey("campaign-1", "segunda@example.com", false),
    },
  ];
  const result = await sendResendMessages("resend-test-key", messages);
  await sendResendMessages("resend-test-key", messages);
  await sendResendMessages("resend-test-key", [
    messages[0],
    {
      ...messages[1],
      to: ["terceira@example.com"],
      _idempotencyKey: idempotencyKey("campaign-1", "terceira@example.com", false),
    },
  ]);

  assert.equal(result.length, messages.length);
  assert.equal(calls.length, messages.length * 3);
  assert.ok(calls.every((call) => call.url === "https://api.resend.com/emails"));
  const keys = calls.map((call) =>
    new Headers(call.init.headers).get("Idempotency-Key"),
  );
  assert.deepEqual(keys.slice(0, 2), keys.slice(2, 4));
  assert.equal(keys[0], keys[4]);
  assert.equal(keys[0], messages[0]._idempotencyKey);
  assert.equal(keys[1], messages[1]._idempotencyKey);
  assert.equal(keys[5], idempotencyKey("campaign-1", "terceira@example.com", false));
  assert.ok(
    calls.every((call) =>
      /primeira|segunda|terceira/u.test(String(call.init.body)),
    ),
  );
});