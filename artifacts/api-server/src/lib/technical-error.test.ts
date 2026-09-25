import assert from "node:assert/strict";
import test from "node:test";
import { getPublicTechnicalError, getTechnicalError } from "./technical-error";

test("preserves nested causes without exposing values outside the error object", () => {
  const cause = new Error("provider detail");
  const error = new Error("send failed", { cause });

  const result = getTechnicalError(error);

  assert.equal(result.message, "send failed");
  assert.equal(typeof result.stack, "string");
  assert.equal(typeof result.cause, "object");
  assert.equal((result.cause as { message: string }).message, "provider detail");
});

test("returns actionable technical details without exposing stack traces", () => {
  const cause = Object.assign(new Error("storage request failed"), {
    code: "storage_unavailable",
    details: "connection timeout",
  });
  const error = new Error("signed upload URL failed", { cause });

  const result = getPublicTechnicalError(error);

  assert.equal(result.message, "signed upload URL failed");
  assert.equal(result.cause?.includes("storage request failed"), true);
  assert.equal(result.cause?.includes("storage_unavailable"), true);
  assert.equal("stack" in result, false);
  assert.equal(result.cause?.includes("\"stack\""), false);
});