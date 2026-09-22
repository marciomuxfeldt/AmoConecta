import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLoginAttempt,
  clearLoginAttemptStates,
  LOGIN_RATE_WINDOW_MS,
  resetLoginAttempts,
} from "./login-rate-limit.ts";

test.afterEach(() => {
  clearLoginAttemptStates();
});

test("allows five attempts and blocks the next one for the remaining window", () => {
  const ip = "203.0.113.10";
  const startedAt = 1_000_000;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(checkLoginAttempt(ip, startedAt + attempt), { allowed: true });
  }

  const blocked = checkLoginAttempt(ip, startedAt + 5);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.equal(
      blocked.retryAfterSeconds,
      Math.ceil(LOGIN_RATE_WINDOW_MS / 1000),
    );
  }
});

test("opens a new window after fifteen minutes", () => {
  const ip = "203.0.113.11";
  const startedAt = 2_000_000;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    checkLoginAttempt(ip, startedAt);
  }

  assert.deepEqual(
    checkLoginAttempt(ip, startedAt + LOGIN_RATE_WINDOW_MS + 1),
    { allowed: true },
  );
});

test("a successful login resets the IP counter", () => {
  const ip = "203.0.113.12";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    checkLoginAttempt(ip, 3_000_000 + attempt);
  }

  resetLoginAttempts(ip);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(checkLoginAttempt(ip, 4_000_000 + attempt), { allowed: true });
  }
  assert.equal(checkLoginAttempt(ip, 4_000_010).allowed, false);
});