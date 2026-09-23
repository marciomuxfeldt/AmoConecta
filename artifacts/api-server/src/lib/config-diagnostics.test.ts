import assert from "node:assert/strict";
import test from "node:test";
import {
  getRequiredSecretStatus,
  REQUIRED_SECRET_NAMES,
} from "./config-diagnostics";

const originalValues = new Map(
  REQUIRED_SECRET_NAMES.map((name) => [name, process.env[name]]),
);

test.afterEach(() => {
  for (const name of REQUIRED_SECRET_NAMES) {
    const original = originalValues.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("reports only names and separates configured secrets from missing ones", () => {
  for (const name of REQUIRED_SECRET_NAMES) delete process.env[name];
  process.env.RESEND_API_KEY = "test-value";
  process.env.SESSION_SECRET = "test-value";
  process.env.SENDER_NAME = "   ";

  const result = getRequiredSecretStatus();

  assert.deepEqual(result.present, ["RESEND_API_KEY", "SESSION_SECRET"]);
  assert.ok(result.missing.includes("SENDER_NAME"));
  assert.ok(result.missing.includes("APP_BASE_URL"));
  assert.equal(JSON.stringify(result).includes("test-value"), false);
});