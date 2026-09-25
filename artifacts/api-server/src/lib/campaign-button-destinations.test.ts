import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeEmailBlocks,
  validateEmailButtonDestinations,
} from "@workspace/email-template";

test("identifies button blocks with a missing destination by position and label", () => {
  const issues = validateEmailButtonDestinations([
    { id: "intro", type: "text", html: "<p>Hello</p>" },
    { id: "offer", type: "button", label: "Ver oferta", href: "  " },
    { id: "old-button", type: "button", label: "Abrir loja" },
  ]);

  assert.deepEqual(
    issues.map(({ kind, message }) => ({ kind, message })),
    [
      { kind: "missing", message: "O botão 2 (“Ver oferta”) está sem destino." },
      { kind: "missing", message: "O botão 3 (“Abrir loja”) está sem destino." },
    ],
  );
});

test("normalization preserves an empty href so scheduling can report it as missing", () => {
  const blocks = normalizeEmailBlocks([
    { id: "offer", type: "button", label: "Ver oferta", href: "" },
  ]);

  assert.equal(blocks[0]?.type, "button");
  assert.deepEqual(validateEmailButtonDestinations(blocks).map(({ kind }) => kind), ["missing"]);
});

test("accepts only HTTPS destinations and rejects insecure protocols", () => {
  const issues = validateEmailButtonDestinations([
    { id: "https", type: "button", label: "HTTPS", href: "https://shop.amo.delivery/oferta" },
    { id: "http", type: "button", label: "HTTP", href: "http://shop.amo.delivery/oferta" },
  ]);
  assert.deepEqual(issues.map(({ blockId, kind }) => ({ blockId, kind })), [
    { blockId: "http", kind: "invalid" },
  ]);

  const [issue] = validateEmailButtonDestinations([
    { id: "ftp", type: "button", label: "FTP", href: "ftp://shop.amo.delivery/oferta" },
  ]);
  assert.equal(issue.kind, "invalid");
  assert.match(issue.message, /botão 1.*https:\/\//u);
});

test("rejects example domains, their subdomains, and localhost including ports", () => {
  const issues = validateEmailButtonDestinations([
    { id: "example-com", type: "button", label: "A", href: "https://example.com/oferta" },
    { id: "sub-example-com", type: "button", label: "B", href: "https://mail.example.com/oferta" },
    { id: "example-org", type: "button", label: "C", href: "https://example.org/" },
    { id: "localhost", type: "button", label: "D", href: "https://localhost:3000/" },
  ]);

  assert.deepEqual(issues.map(({ kind }) => kind), [
    "test-domain",
    "test-domain",
    "test-domain",
    "test-domain",
  ]);
  assert.match(issues[3].message, /botão 4.*localhost/u);
});