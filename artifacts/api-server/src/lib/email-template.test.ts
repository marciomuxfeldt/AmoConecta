import assert from "node:assert/strict";
import test from "node:test";
import {
  renderEmailHtml,
  sanitizeRichTextHtml,
} from "@workspace/email-template";

test("renders Outlook-safe table markup and fixed footer", () => {
  const html = renderEmailHtml(
    [
      { id: "first", type: "text", html: "<p>Olá, <strong>{{nome}}</strong></p>" },
      { id: "second", type: "button", label: "Ver oferta", href: "https://example.com/oferta" },
      { id: "third", type: "divider" },
    ],
    { name: "Marina" },
  );

  assert.match(html, /<table/iu);
  assert.match(html, /max-width:600px/iu);
  assert.match(html, /Olá, <strong>Marina<\/strong>/iu);
  assert.match(html, /Descadastrar-se/iu);
  assert.match(html, /Você está recebendo este e-mail/iu);
  assert.doesNotMatch(html, /display:\s*(?:flex|grid)/iu);
  assert.doesNotMatch(html, /\{\{\s*nome\s*\}\}/iu);
  assert.ok(html.indexOf("Ver oferta") < html.indexOf("Descadastrar-se"));
});

test("removes the name token and greeting separator when name is absent", () => {
  const html = renderEmailHtml(
    [{ id: "greeting", type: "text", html: "Olá, {{nome}}" }],
    { name: null },
  );

  assert.match(html, />Olá<\/td>/iu);
  assert.doesNotMatch(html, /\{\{\s*nome\s*\}\}/iu);
  assert.doesNotMatch(html, /@/u);
});

test("sanitizes rich text to the supported formatting and safe links", () => {
  const html = sanitizeRichTextHtml(
    '<strong>forte</strong><em>ênfase</em><a href="javascript:alert(1)">link</a><script>alert(1)</script>',
  );

  assert.match(html, /<strong>forte<\/strong>/iu);
  assert.match(html, /<em>ênfase<\/em>/iu);
  assert.match(html, />link</iu);
  assert.doesNotMatch(html, /javascript|script/iu);
});