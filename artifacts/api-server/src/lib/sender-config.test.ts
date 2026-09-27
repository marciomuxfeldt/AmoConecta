import assert from "node:assert/strict";
import test from "node:test";
import {
  applyConfiguredReplyTo,
  configuredReplyToEmail,
  warnIfReplyToDefaultMissing,
} from "./sender-config";

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

test("applies only the configured Reply-To to an empty campaign field", () => {
  process.env.REPLY_TO_EMAIL = " Marketing@amo.delivery ";
  assert.deepEqual(applyConfiguredReplyTo({ reply_to: "" }), {
    reply_to: "marketing@amo.delivery",
  });
});

test("leaves the campaign Reply-To unset when the secret is absent", () => {
  delete process.env.REPLY_TO_EMAIL;
  assert.deepEqual(applyConfiguredReplyTo({}), {});
});

test("preserves a campaign-specific Reply-To", () => {
  process.env.REPLY_TO_EMAIL = "default@amo.delivery";
  assert.deepEqual(
    applyConfiguredReplyTo({ reply_to: "custom@amo.delivery" }),
    { reply_to: "custom@amo.delivery" },
  );
});

for (const creationPath of ["draft", "campaign"] as const) {
  test(`warns on ${creationPath} creation when Reply-To is unavailable`, () => {
    delete process.env.REPLY_TO_EMAIL;
    const warnings: Array<{
      bindings: Record<string, unknown>;
      message: string;
    }> = [];

    warnIfReplyToDefaultMissing(undefined, creationPath, (bindings, message) => {
      warnings.push({ bindings, message });
    });

    assert.deepEqual(warnings, [
      {
        bindings: {
          setting: "REPLY_TO_EMAIL",
          campaignCreationPath: creationPath,
        },
        message:
          "Campaign created without a Reply-To default because REPLY_TO_EMAIL is not configured",
      },
    ]);
  });
}

test("does not warn when a campaign has a Reply-To or the Secret is configured", () => {
  const warnings: Array<Record<string, unknown>> = [];
  const warn = (bindings: Record<string, unknown>) => warnings.push(bindings);

  delete process.env.REPLY_TO_EMAIL;
  warnIfReplyToDefaultMissing("custom@amo.delivery", "campaign", warn);
  process.env.REPLY_TO_EMAIL = "default@amo.delivery";
  warnIfReplyToDefaultMissing(undefined, "campaign", warn);

  assert.deepEqual(warnings, []);
});