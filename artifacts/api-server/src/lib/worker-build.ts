import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function readWorkerBuildIdentity(bundleUrl: URL) {
  const manifest = JSON.parse(readFileSync(new URL("./worker-build.json", bundleUrl), "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(manifest.bundleSha256) ||
      typeof manifest.builtAt !== "string" ||
      !Number.isFinite(Date.parse(manifest.builtAt)) ||
      !(manifest.sourceCommit === null || /^[a-f0-9]{40,64}$/u.test(manifest.sourceCommit)) ||
      !(manifest.uncommittedChanges === null || typeof manifest.uncommittedChanges === "boolean")) {
    throw new Error("O manifesto de build do worker é inválido.");
  }
  const executedBundleSha256 = createHash("sha256").update(readFileSync(bundleUrl)).digest("hex");
  return {
    sourceCommit: manifest.sourceCommit as string | null,
    uncommittedChanges: manifest.uncommittedChanges as boolean | null,
    builtAt: manifest.builtAt as string,
    bundleSha256: manifest.bundleSha256 as string,
    executedBundleSha256,
    bundleMatchesBuild: executedBundleSha256 === manifest.bundleSha256,
  };
}