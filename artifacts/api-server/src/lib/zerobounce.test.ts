import test from "node:test";
import assert from "node:assert/strict";
import {
  getZeroBounceCredits,
  parseZeroBounceBatch,
  validateZeroBounceBatch,
  ZeroBounceError,
} from "./zerobounce.js";
import { isSafeEmailForExternalValidation } from "./csv-import.js";

const rawResult = (address: string, status = "valid") => ({
  address,
  status,
  sub_status: "",
  free_email: false,
  did_you_mean: null,
  domain: "example.test",
  smtp_provider: "Example",
  mx_found: "true",
  custom_provider_field: "preserved",
});

test("batch parsing preserves provider JSON and isolates address-level errors", () => {
  const parsed = parseZeroBounceBatch({
    email_batch: [rawResult("good@example.test", "valid")],
    errors: [{ email_address: "bad@example.test", error: "Temporary address error" }],
  }, ["good@example.test", "bad@example.test"]);

  assert.equal(parsed[0]?.kind, "result");
  if (parsed[0]?.kind === "result") {
    assert.equal(parsed[0].value.raw.custom_provider_field, "preserved");
    assert.equal(parsed[0].value.mxFound, true);
  }
  assert.deepEqual(parsed[1], {
    kind: "error",
    email: "bad@example.test",
    message: "Temporary address error",
    raw: { email_address: "bad@example.test", error: "Temporary address error" },
  });
});

test("malformed or incomplete provider batches are rejected as a whole", () => {
  assert.throws(
    () => parseZeroBounceBatch({ email_batch: [rawResult("a@example.test")], errors: [] }, [
      "a@example.test",
      "b@example.test",
    ]),
    ZeroBounceError,
  );
  assert.throws(
    () => parseZeroBounceBatch({ email_batch: [rawResult("a@example.test", "unexpected")], errors: [] }, [
      "a@example.test",
    ]),
    ZeroBounceError,
  );
});

test("global insufficient-credit response preserves completed results and leaves the rest unresolved", () => {
  const parsed = parseZeroBounceBatch({
    email_batch: [rawResult("verified@example.test", "valid")],
    errors: [{
      email_address: "all",
      error: "Your account ran out of credits",
    }],
  }, ["verified@example.test", "not-checked@example.test"]);
  assert.equal(parsed[0]?.kind, "result");
  assert.deepEqual(parsed[1], {
    kind: "global_error",
    message: "Your account ran out of credits",
    raw: {
      email_address: "all",
      error: "Your account ran out of credits",
    },
  });
});

test("ZeroBounce sandbox addresses exercise fixed no-credit statuses without a live API call", () => {
  const parsed = parseZeroBounceBatch({
    email_batch: [
      rawResult("valid@example.com", "valid"),
      rawResult("spamtrap@example.com", "spamtrap"),
    ],
    errors: [],
  }, ["valid@example.com", "spamtrap@example.com"]);
  assert.deepEqual(
    parsed.map((item) => item.kind === "result" ? item.value.status : item.kind),
    ["valid", "spamtrap"],
  );
});

test("validation rejects invisible and non-ASCII addresses before billing", () => {
  assert.equal(isSafeEmailForExternalValidation("valid@example.test"), true);
  assert.equal(isSafeEmailForExternalValidation("\u200bvalid@example.test"), false);
  assert.equal(isSafeEmailForExternalValidation("valid@exämple.test"), false);
});

test("credits use the documented GET endpoint and parse the provider balance", async () => {
  const previous = process.env.ZEROBOUNCE_API_KEY;
  process.env.ZEROBOUNCE_API_KEY = "test-secret";
  let requestedUrl = "";
  let requestedMethod = "";
  let requestedBody: unknown;
  try {
    const credits = await getZeroBounceCredits(async (input, init) => {
      requestedUrl = String(input);
      requestedMethod = init?.method ?? "";
      requestedBody = init?.body;
      return new Response(JSON.stringify({ Credits: "125" }), { status: 200 });
    });
    assert.equal(credits, 125);
    const url = new URL(requestedUrl);
    assert.equal(url.origin + url.pathname, "https://api.zerobounce.net/v2/getcredits");
    assert.equal(url.searchParams.get("api_key"), "test-secret");
    assert.equal(requestedMethod, "GET");
    assert.equal(requestedBody, undefined);
  } finally {
    if (previous === undefined) delete process.env.ZEROBOUNCE_API_KEY;
    else process.env.ZEROBOUNCE_API_KEY = previous;
  }
});

test("malformed input is filtered by the caller; provider requests enforce the batch limit", async () => {
  const previous = process.env.ZEROBOUNCE_API_KEY;
  process.env.ZEROBOUNCE_API_KEY = "test-secret";
  let calls = 0;
  try {
    await assert.rejects(
      validateZeroBounceBatch(Array.from({ length: 101 }, (_, i) => `a${i}@example.test`), async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      }),
      ZeroBounceError,
    );
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.ZEROBOUNCE_API_KEY;
    else process.env.ZEROBOUNCE_API_KEY = previous;
  }
});
