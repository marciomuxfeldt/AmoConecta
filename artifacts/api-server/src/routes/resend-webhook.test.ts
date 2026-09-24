import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  createResendWebhookRouter,
} from "./resend-webhook";

const secret = `whsec_${Buffer.from("route-test-secret").toString("base64")}`;
const oldSecret = process.env.RESEND_WEBHOOK_SECRET;

test.before(() => {
  process.env.RESEND_WEBHOOK_SECRET = secret;
});

test.after(() => {
  if (oldSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = oldSecret;
});

type TestEvent = {
  svix_id: string;
  tipo: string;
  resend_email_id: string | null;
  email: string | null;
  ocorrido_em: string;
  payload: Record<string, unknown>;
  bounce_permanente: boolean | null;
  bounce_tipo_bruto: string | null;
};

async function startWebhookServer(
  insertEvent: (row: TestEvent) => Promise<{ error: { code?: string } | null }>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: "silent" }) }));
  app.use(
    "/api/webhooks/resend",
    express.raw({ type: "application/json", limit: "1mb" }),
    createResendWebhookRouter({
      insertEvent,
      processPending: async () => 0,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/api/webhooks/resend`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function signedHeaders(body: Buffer, svixId: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac(
    "sha256",
    Buffer.from(secret.slice("whsec_".length), "base64"),
  )
    .update(`${svixId}.${timestamp}.`)
    .update(body)
    .digest("base64");
  return {
    "content-type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function eventBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "email.clicked",
      created_at: new Date().toISOString(),
      data: {
        email_id: "em_route_test_1",
        to: ["reader@example.com"],
      },
    }),
  );
}

function bounceBody(data: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "email.bounced",
      created_at: new Date().toISOString(),
      data: {
        email_id: "em_bounce_route_test",
        to: ["bounce@example.com"],
        ...data,
      },
    }),
  );
}

test("invalid signature returns 401 before any event insert", async () => {
  let insertCalls = 0;
  const rows = new Map<string, TestEvent>();
  const server = await startWebhookServer(async (row) => {
    insertCalls += 1;
    rows.set(row.svix_id, row);
    return { error: null };
  });

  try {
    const body = eventBody();
    const headers = signedHeaders(body, "msg_invalid_signature");
    headers["svix-signature"] = "v1,not-a-valid-signature";
    const response = await fetch(server.url, { method: "POST", headers, body });
    const responseBody = await response.json();

    assert.equal(response.status, 401);
    assert.deepEqual(responseBody, { error: "Assinatura do webhook inválida." });
    assert.equal(insertCalls, 0);
    assert.equal(rows.size, 0);
    console.log(
      `INVALID_SIGNATURE evidence: HTTP ${response.status}; DB insert calls=${insertCalls}; evento_email rows=${rows.size}`,
    );
  } finally {
    await server.close();
  }
});

test("only explicit permanent and hard bounce values are classified as permanent", async () => {
  const rows = new Map<string, TestEvent>();
  const server = await startWebhookServer(async (row) => {
    rows.set(row.svix_id, row);
    return { error: null };
  });
  const cases: Array<{
    id: string;
    data: Record<string, unknown>;
    permanent: boolean;
    raw: string;
  }> = [
    {
      id: "msg_bounce_permanent",
      data: { bounce: { type: "PeRmAnEnT" } },
      permanent: true,
      raw: "PeRmAnEnT",
    },
    {
      id: "msg_bounce_hard",
      data: { bounce_type: "hard" },
      permanent: true,
      raw: "hard",
    },
    {
      id: "msg_bounce_transient",
      data: { bounce: { type: "Transient" } },
      permanent: false,
      raw: "Transient",
    },
    {
      id: "msg_bounce_undetermined",
      data: { bounce: { type: "Undetermined" } },
      permanent: false,
      raw: "Undetermined",
    },
    {
      id: "msg_bounce_unknown",
      data: { bounceType: "future-value" },
      permanent: false,
      raw: "future-value",
    },
    {
      id: "msg_bounce_missing",
      data: {},
      permanent: false,
      raw: "<missing>",
    },
  ];

  try {
    for (const sample of cases) {
      const body = bounceBody(sample.data);
      const response = await fetch(server.url, {
        method: "POST",
        headers: signedHeaders(body, sample.id),
        body,
      });
      assert.equal(response.status, 200);
      const row = rows.get(sample.id);
      assert.ok(row);
      assert.equal(row.bounce_permanente, sample.permanent, sample.id);
      assert.equal(row.bounce_tipo_bruto, sample.raw, sample.id);
    }
    console.log(
      "BOUNCE evidence: Permanent=true; hard=true; Transient=false; Undetermined=false; unknown=false and retained; missing=false and marked <missing>",
    );
  } finally {
    await server.close();
  }
});

test("re-delivery of the same Svix event leaves one event row", async () => {
  let insertCalls = 0;
  const rows = new Map<string, TestEvent>();
  const server = await startWebhookServer(async (row) => {
    insertCalls += 1;
    if (rows.has(row.svix_id)) return { error: { code: "23505" } };
    rows.set(row.svix_id, row);
    return { error: null };
  });

  try {
    const body = eventBody();
    const headers = signedHeaders(body, "msg_duplicate_test");
    const first = await fetch(server.url, { method: "POST", headers, body });
    const firstBody = await first.json();
    const second = await fetch(server.url, { method: "POST", headers, body });
    const secondBody = await second.json();

    assert.equal(first.status, 200);
    assert.deepEqual(firstBody, { received: true });
    assert.equal(second.status, 200);
    assert.deepEqual(secondBody, { received: true, duplicate: true });
    assert.equal(insertCalls, 2);
    assert.equal(rows.size, 1);
    console.log(
      `DUPLICATE_EVENT evidence: first HTTP ${first.status}; second HTTP ${second.status}; DB insert calls=${insertCalls}; evento_email rows=${rows.size}`,
    );
  } finally {
    await server.close();
  }
});