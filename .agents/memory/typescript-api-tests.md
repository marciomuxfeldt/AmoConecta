---
name: TypeScript API tests
description: Running the API server's TypeScript node:test files in this workspace.
---

API server tests use `node:test` in TypeScript files with extensionless local imports. Node 24's built-in type stripping executes the test file but does not resolve those extensionless imports, and the API package does not provide `tsx`. Externalizing workspace packages can still make Node follow symlinks to extensionless TypeScript source and fail to resolve imports.

**Why:** A direct native Node test run fails during module resolution even though the TypeScript code typechecks; generated test bundles under `/tmp` also cannot resolve workspace package links from there.

**How to apply:** Use the API package's existing `esbuild` to bundle an individual test entrypoint, including workspace package code, to a temporary `.mjs` inside `artifacts/api-server/node_modules/`, then run it with `node --test`. If the package later adds a supported test runner, re-check this guidance.