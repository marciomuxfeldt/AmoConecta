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

test("renders an optional hidden inbox preheader before the email content", () => {
  const html = renderEmailHtml(
    [{ id: "first", type: "text", html: "Conteúdo da campanha" }],
    { preheader: "Resumo da oferta <seguro>" },
  );

  assert.match(
    html,
    /display:none!important[^>]*>Resumo da oferta &lt;seguro&gt;/iu,
  );
  const bodyStart = html.indexOf("<body");
  assert.ok(
    html.indexOf("Resumo da oferta", bodyStart) < html.indexOf("<table", bodyStart),
  );
  const hidden = html.match(/display:none!important[^>]*>([^<]*)<\/div>/iu)?.[1];
  assert.ok((hidden?.match(/&zwnj;&nbsp;/gu)?.length ?? 0) >= 30);
});

test("limits rendered preheaders to 100 characters", () => {
  const html = renderEmailHtml([], { preheader: "x".repeat(140) });
  const hidden = html.match(/display:none!important[^>]*>([^<]*)<\/div>/iu)?.[1];

  assert.equal(hidden?.match(/^x+/u)?.[0].length, 100);
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