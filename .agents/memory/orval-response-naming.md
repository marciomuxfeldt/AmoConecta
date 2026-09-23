---
name: Orval response naming
description: Naming rule for OpenAPI response components generated into the shared Zod and TypeScript barrels.
---

Response schemas referenced by an operation should use an entity-shaped name rather than the operation's auto-derived response name.

**Why:** Orval can emit both the operation response schema and the referenced component into the same generated barrel. Equal names make the library typecheck fail with a duplicate export.

**How to apply:** Before running codegen, avoid component names such as `<OperationIdPascal>Response`; use a domain result name and keep the operationId descriptive.