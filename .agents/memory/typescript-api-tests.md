---
name: TypeScript API tests
description: Running the API server's TypeScript node:test files in this workspace.
---

API server tests use `node:test` in TypeScript files with extensionless local imports. Node 24's built-in type stripping executes the test file but does not resolve those extensionless imports, and the API package does not provide `tsx`.

**Why:** A direct native Node test run fails during module resolution even though the TypeScript code typechecks.

**How to apply:** Use the API package's existing `esbuild` to bundle an individual test entrypoint to `/tmp`, then run the bundled file with `node --test`. If the package later adds a supported test runner, re-check this guidance.