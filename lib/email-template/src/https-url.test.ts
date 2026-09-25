// The package's production tsconfig intentionally has no Node type dependency;
// node:test executes this file in the test runner and this directive keeps the
// focused test source out of production type analysis.
// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { getHttpsUrlSuggestion, isStrictHttpsUrl } from "./https-url";

test("accepts complete HTTPS URLs", () => {
  assert.equal(isStrictHttpsUrl("https://somosamo.com.br/oferta?utm_source=email"), true);
  assert.equal(isStrictHttpsUrl("https://例え.テスト/caminho"), true);
});

test("rejects insecure, malformed, hostless, and whitespace-containing URLs", () => {
  const invalid = [
    "https:example.com",
    "http://example.com",
    "HTTPS://example.com",
    "javascript:alert(1)",
    "//example.com/oferta",
    "https:///oferta",
    "https://",
    "https://user:secret@example.com/oferta",
    "https://example .com",
    "https://example.com/oferta com",
    "",
    null,
    undefined,
    42,
  ];

  for (const value of invalid) {
    assert.equal(isStrictHttpsUrl(value), false, `expected rejection: ${String(value)}`);
  }
});

test("suggests HTTPS completion for a plausible bare hostname/path", () => {
  assert.equal(
    getHttpsUrlSuggestion("somosamo.com.br/oferta"),
    "https://somosamo.com.br/oferta",
  );
  assert.equal(getHttpsUrlSuggestion("www.example.com"), "https://www.example.com");
  assert.equal(getHttpsUrlSuggestion("localhost:3000/oferta"), null);
  assert.equal(getHttpsUrlSuggestion("localhost/oferta"), null);
});

test("does not suggest completion for values that already have a scheme or are unsafe", () => {
  const values = [
    "https://example.com",
    "http://example.com",
    "https:example.com",
    "javascript:alert(1)",
    "//example.com",
    "localhost/oferta",
    "example .com",
    "example",
    "",
    null,
  ];

  for (const value of values) {
    assert.equal(getHttpsUrlSuggestion(value), null, `expected no suggestion: ${String(value)}`);
  }
});