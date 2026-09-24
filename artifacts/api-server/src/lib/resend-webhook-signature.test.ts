import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  RESEND_WEBHOOK_MAX_AGE_SECONDS,
  verifyResendWebhookSignature,
} from "./resend-webhook-signature";

const nowSeconds = 1_800_000_000;
const rawPayload = Buffer.from('{"type":"email.opened","data":{"email_id":"em_1"}}');
const webhookSecret = `whsec_${Buffer.from("test-signing-secret").toString("base64")}`;

function signatureFor(payload: Buffer, timestamp: number, id = "msg_test_1"): string {
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(payload)
    .digest("base64");
  return `v1,${signature}`;
}

test("accepts a valid signature over the exact raw payload", () => {
  const timestamp = nowSeconds;
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      {
        id: "msg_test_1",
        timestamp: String(timestamp),
        signature: signatureFor(rawPayload, timestamp),
      },
      webhookSecret,
      nowSeconds,
    ),
    true,
  );
});

test("rejects a changed body, malformed timestamp, and stale timestamp", () => {
  const timestamp = nowSeconds;
  const signature = signatureFor(rawPayload, timestamp);
  assert.equal(
    verifyResendWebhookSignature(
      Buffer.from(`${rawPayload.toString("utf8")} `),
      { id: "msg_test_1", timestamp: String(timestamp), signature },
      webhookSecret,
      nowSeconds,
    ),
    false,
  );
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      { id: "msg_test_1", timestamp: "1e3", signature },
      webhookSecret,
      nowSeconds,
    ),
    false,
  );
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      {
        id: "msg_test_1",
        timestamp: String(nowSeconds - RESEND_WEBHOOK_MAX_AGE_SECONDS - 1),
        signature,
      },
      webhookSecret,
      nowSeconds,
    ),
    false,
  );
  const boundaryTimestamp = nowSeconds - RESEND_WEBHOOK_MAX_AGE_SECONDS;
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      {
        id: "msg_test_1",
        timestamp: String(boundaryTimestamp),
        signature: signatureFor(rawPayload, boundaryTimestamp),
      },
      webhookSecret,
      nowSeconds,
    ),
    true,
  );
  const futureTimestamp = nowSeconds + RESEND_WEBHOOK_MAX_AGE_SECONDS + 1;
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      {
        id: "msg_test_1",
        timestamp: String(futureTimestamp),
        signature: signatureFor(rawPayload, futureTimestamp),
      },
      webhookSecret,
      nowSeconds,
    ),
    false,
  );
});

test("accepts a valid v1 value among multiple Svix signatures", () => {
  const timestamp = nowSeconds;
  const signature = signatureFor(rawPayload, timestamp);
  assert.equal(
    verifyResendWebhookSignature(
      rawPayload,
      {
        id: "msg_test_1",
        timestamp: String(timestamp),
        signature: `v0,not-valid ${signature}`,
      },
      webhookSecret,
      nowSeconds,
    ),
    true,
  );
});