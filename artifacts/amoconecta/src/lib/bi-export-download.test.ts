import assert from "node:assert/strict";
import test from "node:test";
import { downloadBiExportFile } from "./bi-export-download";

test("downloads a CSV Blob and uses the server-provided filename", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const csv = "\uFEFFemail\r\nperson@example.test\r\n";

  const result = await downloadBiExportFile(
    "f8b4c7d1-0000-4000-8000-000000000001",
    async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="amoconecta-export-campanha-teste-2026-09-26.csv"',
        },
      });
    },
  );

  assert.equal(
    requestedUrl,
    "/api/bi-exports/f8b4c7d1-0000-4000-8000-000000000001/download",
  );
  assert.equal(requestInit?.credentials, "same-origin");
  assert.ok(result.blob instanceof Blob);
  assert.deepEqual(
    Buffer.from(await result.blob.arrayBuffer()),
    Buffer.from(csv),
  );
  assert.equal(
    result.filename,
    "amoconecta-export-campanha-teste-2026-09-26.csv",
  );
});

test("shows an actionable message when the server reports an expired export", async () => {
  await assert.rejects(
    downloadBiExportFile("f8b4c7d1-0000-4000-8000-000000000002", async () =>
      new Response(JSON.stringify({ error: "O arquivo expirou." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    /solicite uma nova exportação/iu,
  );
});

test("rejects a successful response that is not marked as CSV", async () => {
  await assert.rejects(
    downloadBiExportFile("f8b4c7d1-0000-4000-8000-000000000003", async () =>
      new Response("not a csv", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="wrong.txt"',
        },
      }),
    ),
    /sem um arquivo CSV válido/iu,
  );
});