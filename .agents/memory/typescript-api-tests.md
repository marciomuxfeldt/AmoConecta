---
name: TypeScript API tests
description: Running the API server's TypeScript node:test files in this workspace.
---

API server tests use `node:test` in TypeScript files with extensionless local imports. Node 24's built-in type stripping executes the test file but does not resolve those extensionless imports, and the API package does not provide `tsx`. Externalizing workspace packages can still make Node follow symlinks to extensionless TypeScript source and fail to resolve imports. Also, `node --test` does not discover a bundle placed under `node_modules`.

**Why:** A direct native Node test run fails during module resolution even though the TypeScript code typechecks; test-runner discovery skips `node_modules`, while bundles under `/tmp` cannot resolve external workspace package links from there.

**How to apply:** Use the API package's existing `esbuild` to bundle an individual test entrypoint. If only Node built-ins remain external, a temporary `.mjs` under `/tmp` can run with `node --test`; if external workspace packages remain, put the bundle in a temporary directory under the API package (but outside `node_modules`) so Node can resolve its workspace links. If the package later adds a supported test runner, re-check this guidance.

For stdin-based diagnostic bundles, set `resolveDir` to the API package or include its `node_modules` in esbuild's `nodePaths`: the repository root cannot resolve every API-only dependency. `NODE_PATH` does not fix native ESM resolution from a `/tmp` bundle. Bundle workspace packages rather than leaving their TypeScript entrypoints external.

**Why:** Resolution has two separate stages: esbuild resolves from the source directory, while Node resolves remaining external imports from the output location.