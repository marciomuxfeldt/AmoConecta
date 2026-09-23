import assert from "node:assert/strict";
import test from "node:test";
import {
  batchIdempotencyKey,
  DEFAULT_RESEND_MIN_INTERVAL_MS,
  idempotencyKey,
  RESEND_MIN_INTERVAL_ENV,
  sendResendMessages,
  testIdempotencyKey,
  type PreparedResendMessage,
} from "./resend-sender";

const originalFetch = globalThis.fetch;
const originalInterval = process.env[RESEND_MIN_INTERVAL_ENV];

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalInterval === undefined) delete process.env[RESEND_MIN_INTERVAL_ENV];
  else process.env[RESEND_MIN_INTERVAL_ENV] = originalInterval;
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

test("uses a different idempotency key for every test attempt", () => {
  const firstAttempt = testIdempotencyKey(
    "campaign-1",
    "pessoa@example.com",
    "attempt-1",
  );
  const secondAttempt = testIdempotencyKey(
    "campaign-1",
    "pessoa@example.com",
    "attempt-2",
  );

  assert.notEqual(firstAttempt, secondAttempt);
  assert.notEqual(firstAttempt, idempotencyKey("campaign-1", "pessoa@example.com", false));
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
      text: "Olá",
      headers: { "X-Internal-Test": "preserve", "Idempotency-Key": "must-not-leak" },
      _idempotencyKey: idempotencyKey("campaign-1", "primeira@example.com", false),
    },
    {
      from: "envios@marketing.amo.delivery",
      to: ["segunda@example.com"],
      subject: "Oferta",
      html: "<p>Olá</p>",
      text: "Olá",
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
  const firstPayload = JSON.parse(String(calls[0].init.body)) as {
    headers: Record<string, string>;
  };
  assert.equal(firstPayload.headers["Idempotency-Key"], undefined);
  assert.equal(firstPayload.headers["X-Internal-Test"], "preserve");
  assert.ok(
    calls.every((call) =>
      /primeira|segunda|terceira/u.test(String(call.init.body)),
    ),
  );
});

function testMessage(email: string): PreparedResendMessage {
  return {
    from: "envios@marketing.amo.delivery",
    to: [email],
    subject: "Oferta",
    html: "<p>Olá</p>",
    text: "Olá",
    headers: {},
    _idempotencyKey: idempotencyKey("rate-limit-campaign", email, false),
  };
}

test("spaces request starts using the configured minimum interval", async () => {
  process.env[RESEND_MIN_INTERVAL_ENV] = "20";
  const starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    return new Response(JSON.stringify({ id: `resend-${starts.length}` }), {
      status: 200,
    });
  };

  await sendResendMessages("resend-test-key", [
    testMessage("primeira@example.com"),
    testMessage("segunda@example.com"),
    testMessage("terceira@example.com"),
  ]);

  assert.ok(starts[1] - starts[0] >= 18);
  assert.ok(starts[2] - starts[1] >= 18);
});

test("defaults to 125ms and waits for a low remaining window", async () => {
  delete process.env[RESEND_MIN_INTERVAL_ENV];
  const starts: number[] = [];
  let call = 0;
  globalThis.fetch = async () => {
    const startedAt = Date.now();
    starts.push(startedAt);
    call += 1;
    const headers =
      call === 1
        ? {
            "ratelimit-remaining": "0",
            "ratelimit-reset": String(startedAt + 220),
          }
        : undefined;
    return new Response(JSON.stringify({ id: `resend-${call}` }), {
      status: 200,
      headers,
    });
  };

  await sendResendMessages("resend-test-key", [
    testMessage("quarta@example.com"),
    testMessage("quinta@example.com"),
  ]);

  assert.ok(DEFAULT_RESEND_MIN_INTERVAL_MS === 125);
  assert.ok(starts[1] - starts[0] >= 200);
});