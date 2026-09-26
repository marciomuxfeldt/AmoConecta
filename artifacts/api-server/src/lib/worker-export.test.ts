import assert from "node:assert/strict";
import test from "node:test";
import { openBiExportCsv, resolveBiExportPageSize } from "./worker-export";
import { csvHeaderLine } from "./csv-export";

const originalFetch = globalThis.fetch;
const originalStorageEnv = {
  PRIVATE_OBJECT_DIR: process.env.PRIVATE_OBJECT_DIR,
  DEFAULT_OBJECT_STORAGE_BUCKET_ID: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalStorageEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("defaults BI export pages to 500 and accepts smaller positive settings", () => {
  assert.equal(resolveBiExportPageSize(undefined), 500);
  assert.equal(resolveBiExportPageSize(""), 500);
  assert.equal(resolveBiExportPageSize("5"), 5);
  assert.throws(() => resolveBiExportPageSize("0"), /inteiro entre 1 e 500/u);
  assert.throws(() => resolveBiExportPageSize("501"), /inteiro entre 1 e 500/u);
});

test("streams checkpointed export parts as one CSV with one header", async () => {
  process.env.PRIVATE_OBJECT_DIR = "test-bucket/private";
  process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID = "test-bucket";
  const jobId = "f8b4c7d1-0000-4000-8000-000000000001";
  const signedObjects = new Map<string, string>();
  const requestedObjects: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "http://127.0.0.1:1106/object-storage/signed-object-url") {
      const payload = JSON.parse(String(init?.body)) as {
        object_name: string;
        method: string;
      };
      assert.equal(payload.method, "GET");
      requestedObjects.push(payload.object_name);
      const url = `https://storage.test/object-${requestedObjects.length}`;
      signedObjects.set(url, payload.object_name);
      return new Response(JSON.stringify({ signed_url: url }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const objectName = signedObjects.get(String(input));
    assert.ok(objectName);
    const partIndex = objectName.endsWith("/parts/0.csv") ? 0 : 1;
    return new Response(`"part-${partIndex}"\r\n`, { status: 200 });
  };

  const stream = await openBiExportCsv(
    `/objects/bi-exports/${jobId}/manifest.csv`,
    2,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const csv = Buffer.concat(chunks).toString("utf8");

  assert.ok(csv.startsWith("\uFEFF"));
  assert.equal(csv.split(csvHeaderLine()).length - 1, 1);
  assert.ok(csv.endsWith(`"part-0"\r\n"part-1"\r\n`));
  assert.equal(requestedObjects.length, 2);
  assert.ok(requestedObjects[0].endsWith(`/bi-exports/${jobId}/parts/0.csv`));
  assert.ok(requestedObjects[1].endsWith(`/bi-exports/${jobId}/parts/1.csv`));
});

test("streams Supabase export parts through short-lived private signed URLs", async () => {
  process.env.SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const jobId = "f8b4c7d1-0000-4000-8000-000000000002";
  const signedExpirations: number[] = [];
  const requestedObjectPaths: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST" && url.includes("/storage/v1/object/sign/")) {
      const body = JSON.parse(String(init.body)) as { expiresIn: number };
      signedExpirations.push(body.expiresIn);
      requestedObjectPaths.push(
        decodeURIComponent(new URL(url).pathname.split("/object/sign/")[1] ?? ""),
      );
      return new Response(
        JSON.stringify({
          signedURL: `/object/sign/amoconecta-bi-exports/bi-exports/${jobId}/parts/0.csv?token=private`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/object/sign/") && url.includes("token=private")) {
      return new Response(`"supabase-part"\r\n`, { status: 200 });
    }
    throw new Error("Unexpected Supabase Storage request in test.");
  };

  const stream = await openBiExportCsv(
    `supabase://amoconecta-bi-exports/bi-exports/${jobId}/manifest.csv`,
    1,
    "supabase",
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const csv = Buffer.concat(chunks).toString("utf8");

  assert.ok(csv.startsWith("\uFEFF"));
  assert.equal(csv.split(csvHeaderLine()).length - 1, 1);
  assert.ok(csv.endsWith(`"supabase-part"\r\n`));
  assert.deepEqual(signedExpirations, [60]);
  assert.deepEqual(requestedObjectPaths, [
    `amoconecta-bi-exports/bi-exports/${jobId}/parts/0.csv`,
  ]);
});