import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import app from "../app";
import { csvHeaderLine } from "../lib/csv-export";
import { supabaseAdminClient } from "../lib/supabase";

type HttpResult = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  receivedBytes: number;
  prefix: Buffer;
};

function getStreamingResponse(
  port: number,
  path: string,
  expectedPrefixBytes: number,
  cookie?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { cookie } : undefined;
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        let receivedBytes = 0;
        let prefix = Buffer.alloc(0);
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += bytes.length;
          if (prefix.length < expectedPrefixBytes) {
            const remaining = expectedPrefixBytes - prefix.length;
            prefix = Buffer.concat([prefix, bytes.subarray(0, remaining)]);
          }
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            receivedBytes,
            prefix,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test(
  "authenticated HTTP download streams a real Supabase export with CSV headers",
  { skip: process.env.RUN_LIVE_BI_EXPORT_HTTP_TEST !== "1" },
  async (t) => {
    const { data: exportJob, error } = await supabaseAdminClient()
      .from("exportacao_csv")
      .select("id,campanha_id,criado_em")
      .eq("status", "concluida")
      .eq("provedor_armazenamento", "supabase")
      .gt("expira_em", new Date().toISOString())
      .order("criado_em", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    assert.ok(exportJob?.id, "No unexpired completed Supabase export is available");

    let campaignPart = "todas-campanhas";
    if (typeof exportJob.campanha_id === "string") {
      campaignPart = `campanha-${exportJob.campanha_id.slice(0, 8)}`;
      const campaign = await supabaseAdminClient()
        .from("campanha")
        .select("nome")
        .eq("id", exportJob.campanha_id)
        .maybeSingle();
      if (!campaign.error && typeof campaign.data?.nome === "string") {
        campaignPart =
          campaign.data.nome
            .normalize("NFKD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/gu, "-")
            .replace(/^-+|-+$/gu, "")
            .slice(0, 60)
            .replace(/-+$/gu, "") || campaignPart;
      }
    }
    const createdAt = new Date(exportJob.criado_em);
    const datePart = Number.isNaN(createdAt.getTime())
      ? new Date().toISOString().slice(0, 10)
      : createdAt.toISOString().slice(0, 10);
    const expectedFilename = `amoconecta-export-${campaignPart}-${datePart}.csv`;

    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const originalFetch = globalThis.fetch;
    const supabaseOrigin = new URL(process.env.SUPABASE_URL as string).origin;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (
        url.origin === supabaseOrigin &&
        url.pathname === "/auth/v1/user"
      ) {
        return new Response(
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            aud: "authenticated",
            role: "authenticated",
            email: "bi-export-http-test@example.invalid",
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: {},
            created_at: "2026-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };

    t.after(async () => {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) =>
          closeError ? reject(closeError) : resolve(),
        );
      });
    });

    const unauthorized = await getStreamingResponse(
      port,
      `/api/bi-exports/${exportJob.id}/download`,
      128,
    );
    assert.equal(unauthorized.statusCode, 401);

    const expectedPrefix = Buffer.from(`\uFEFF${csvHeaderLine()}`);
    const downloaded = await getStreamingResponse(
      port,
      `/api/bi-exports/${exportJob.id}/download`,
      expectedPrefix.length,
      "amoconecta_session=bi-export-http-test-token",
    );
    assert.equal(downloaded.statusCode, 200);
    assert.match(downloaded.headers["content-type"] ?? "", /^text\/csv;\s*charset=utf-8$/iu);
    assert.equal(
      downloaded.headers["content-disposition"] ?? "",
      `attachment; filename="${expectedFilename}"`,
    );
    assert.equal(downloaded.headers["cache-control"], "private, no-store");
    assert.ok(downloaded.receivedBytes > expectedPrefix.length);
    assert.deepEqual(downloaded.prefix, expectedPrefix);
  },
);