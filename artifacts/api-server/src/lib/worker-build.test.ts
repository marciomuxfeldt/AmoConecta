import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readWorkerBuildIdentity } from "./worker-build";

test("build identity compares the executed bytes, not the repository HEAD", () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-build-"));
  try {
    const bundle = join(dir, "worker-entry.mjs");
    writeFileSync(bundle, "original-bundle");
    const manifest = {
      sourceCommit: "a".repeat(40) as string | null, uncommittedChanges: false,
      builtAt: "2026-10-03T12:25:00Z",
      bundleSha256: createHash("sha256").update("original-bundle").digest("hex"),
    };
    writeFileSync(join(dir, "worker-build.json"), JSON.stringify(manifest));
    assert.equal(readWorkerBuildIdentity(pathToFileURL(bundle)).bundleMatchesBuild, true);
    writeFileSync(bundle, "different-cached-bundle");
    assert.equal(readWorkerBuildIdentity(pathToFileURL(bundle)).bundleMatchesBuild, false);
    // A snapshot without Git still identifies its built/executed bundle honestly.
    manifest.sourceCommit = null;
    writeFileSync(join(dir, "worker-build.json"), JSON.stringify(manifest));
    assert.equal(readWorkerBuildIdentity(pathToFileURL(bundle)).sourceCommit, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});