#!/usr/bin/env bash
# All database writes below are in disposable local PGlite, never Supabase.
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_OUTPUT="$(mktemp -d)"
trap 'rm -rf "$TEST_OUTPUT"' EXIT
export TEST_OUTPUT
node --input-type=module <<'JS'
import { build } from "./artifacts/api-server/node_modules/esbuild/lib/main.js";
await build({
  entryPoints: [
    "artifacts/api-server/src/lib/csv-import.test.ts",
    "artifacts/api-server/src/lib/recipient-exclusions.test.ts",
    "artifacts/api-server/src/lib/campaign-reputation.test.ts",
    "artifacts/api-server/src/lib/worker-campaign.test.ts",
    "artifacts/api-server/src/lib/worker-build.test.ts",
    "artifacts/api-server/src/lib/recipient-delivery-projection.test.ts",
    "artifacts/api-server/src/lib/csv-export.test.ts",
    "artifacts/api-server/src/lib/campaign-email-metrics.test.ts",
    "artifacts/api-server/src/lib/campaign-send-window.test.ts",
    "artifacts/api-server/src/lib/config-diagnostics.test.ts",
  ],
  bundle: true, platform: "node", format: "esm",
  outdir: process.env.TEST_OUTPUT, outExtension: { ".js": ".mjs" },
});
JS
node --test "$TEST_OUTPUT"/*.mjs
node --test artifacts/api-server/src/lib/flexible-import.sql.test.mjs
node --test artifacts/api-server/src/lib/campaign-controls.sql.test.mjs
pnpm --filter @workspace/amoconecta test