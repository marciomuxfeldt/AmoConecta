import assert from "node:assert/strict";
import test from "node:test";
import { configuredReplyToEmail } from "./sender-config";

const originalReplyTo = process.env.REPLY_TO_EMAIL;

test.afterEach(() => {
  if (originalReplyTo === undefined) delete process.env.REPLY_TO_EMAIL;
  else process.env.REPLY_TO_EMAIL = originalReplyTo;
});

test("does not invent a Reply-To when the secret is absent", () => {
  delete process.env.REPLY_TO_EMAIL;
  assert.equal(configuredReplyToEmail(), null);
});

test("normalizes a configured Reply-To", () => {
  process.env.REPLY_TO_EMAIL = "  Respostas@Example.com ";
  assert.equal(configuredReplyToEmail(), "respostas@example.com");
});