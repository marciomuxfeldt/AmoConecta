import assert from "node:assert/strict";
import test from "node:test";
import { getTechnicalError } from "./technical-error";

test("preserves nested causes without exposing values outside the error object", () => {
  const cause = new Error("provider detail");
  const error = new Error("send failed", { cause });

  const result = getTechnicalError(error);

  assert.equal(result.message, "send failed");
  assert.equal(typeof result.stack, "string");
  assert.equal(typeof result.cause, "object");
  assert.equal((result.cause as { message: string }).message, "provider detail");
});