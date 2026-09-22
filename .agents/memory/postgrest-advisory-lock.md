---
name: PostgREST advisory lock handling
description: Session advisory locks called through separate Supabase RPC requests need durable lease state.
---

PostgREST calls use pooled HTTP sessions, so cross-request coordination must use a tokenized, expiring database lease and release only when the token matches. A single conditional `UPDATE` is sufficient for acquisition.

**Why:** A session-only acquire/release pair can silently lose mutual exclusion when the connection pool returns the acquisition session before the worker finishes.

**How to apply:** For background jobs that span multiple Supabase calls, seed one lock row, acquire it with an atomic conditional `UPDATE`, use a short lease, and use a per-process owner token to prevent stale workers from releasing a newer lease.