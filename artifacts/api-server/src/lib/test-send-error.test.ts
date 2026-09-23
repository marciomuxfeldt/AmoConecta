import assert from "node:assert/strict";
import test from "node:test";
import { getTestSendErrorResponse } from "./test-send-error";

test("returns actionable messages for expected configuration failures", () => {
  const result = getTestSendErrorResponse(
    new Error("RESEND_API_KEY não está configurada."),
  );

  assert.deepEqual(result, {
    status: 422,
    message: "RESEND_API_KEY não está configurada.",
  });
});

test("maps provider rate limits to a retryable response", () => {
  const error = Object.assign(new Error("Resend 429: limite"), { status: 429 });

  assert.equal(getTestSendErrorResponse(error).status, 503);
});

test("masks unknown failures while preserving a non-generic client action", () => {
  const result = getTestSendErrorResponse(new Error("internal detail"));

  assert.equal(result.status, 500);
  assert.match(result.message, /falha foi registrada/u);
  assert.equal(result.message.includes("internal detail"), false);
});