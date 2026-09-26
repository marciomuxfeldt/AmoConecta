import assert from "node:assert/strict";
import test from "node:test";
import {
  API_REQUIRED_SECRET_NAMES,
  getRequiredSecretStatus,
  WORKER_REQUIRED_SECRET_NAMES,
} from "./config-diagnostics";

const originalValues = new Map(
  [...new Set([...API_REQUIRED_SECRET_NAMES, ...WORKER_REQUIRED_SECRET_NAMES])].map(
    (name) => [name, process.env[name]],
  ),
);

test.afterEach(() => {
  for (const name of originalValues.keys()) {
    const original = originalValues.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

test("reports only names and separates configured secrets from missing ones", () => {
  for (const name of originalValues.keys()) delete process.env[name];
  process.env.RESEND_API_KEY = "test-value";
  process.env.SESSION_SECRET = "test-value";
  process.env.SENDER_NAME = "   ";

  const result = getRequiredSecretStatus(API_REQUIRED_SECRET_NAMES);

  assert.deepEqual(result.present, ["RESEND_API_KEY", "SESSION_SECRET"]);
  assert.ok(result.missing.includes("SENDER_NAME"));
  assert.ok(result.missing.includes("APP_BASE_URL"));
  assert.equal(JSON.stringify(result).includes("test-value"), false);
});

test("keeps worker diagnostics independent from API-only variables", () => {
  const workerNames: readonly string[] = WORKER_REQUIRED_SECRET_NAMES;
  const apiNames: readonly string[] = API_REQUIRED_SECRET_NAMES;
  assert.equal(apiNames.includes("REPLY_TO_EMAIL"), false);
  assert.equal(workerNames.includes("REPLY_TO_EMAIL"), false);
  assert.equal(workerNames.includes("SUPABASE_ANON_KEY"), false);
  assert.equal(workerNames.includes("SESSION_SECRET"), false);
  assert.equal(workerNames.includes("DATABASE_URL"), false);
  assert.equal(workerNames.includes("PORT"), false);
  assert.equal(workerNames.includes("DEFAULT_OBJECT_STORAGE_BUCKET_ID"), false);
  assert.equal(workerNames.includes("PRIVATE_OBJECT_DIR"), false);
  assert.equal(apiNames.includes("PORT"), true);
});