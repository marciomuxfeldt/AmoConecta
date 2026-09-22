---
name: PostgREST advisory lock handling
description: Session advisory locks called through separate Supabase RPC requests need durable lease state.
---

`pg_try_advisory_lock` acquired in one PostgREST RPC cannot be assumed to remain held until a later release RPC, because pooled HTTP requests may use different PostgreSQL sessions. Pair the advisory attempt with a tokenized, expiring database lease and release only when the token matches.

**Why:** A session-only acquire/release pair can silently lose mutual exclusion when the connection pool returns the acquisition session before the worker finishes.

**How to apply:** For background jobs that span multiple Supabase calls, keep the advisory key fixed, persist ownership with an expiry, and use a per-process owner token to prevent stale workers from releasing a newer lease.