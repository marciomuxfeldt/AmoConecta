---
name: PGlite concurrent indexes
description: How to test a PostgreSQL concurrent-index migration with PGlite.
---

Run `CREATE INDEX CONCURRENTLY` as one standalone statement in PGlite; keep verification SQL separate.

**Why:** PGlite rejects the command with SQLSTATE `25001` when it is included in a multi-statement `db.exec` script that runs in a transaction.

**How to apply:** Load the concurrent-index migration as a single statement in the local SQL test setup, then verify `pg_index.indisvalid` in a separate query.
