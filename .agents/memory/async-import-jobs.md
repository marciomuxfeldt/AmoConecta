---
name: Asynchronous CSV import jobs
description: Large CSV validation must outlive the HTTP request and expose persisted progress.
---

CSV validation is represented by a persisted import job with status and progress; the POST only creates the job, a background worker streams Storage data in 5,000-row blocks, and the UI polls until the result is complete.

**Why:** Proxy request timeouts make synchronous validation unsuitable for large dashboard exports, even when the parser itself is streaming.

**How to apply:** Keep progress and terminal results in the import job row, return a stable job id from the POST, and never put full-file processing back inside the request handler. The validation job also writes recipients, so any warning requiring operator approval must be shown before creating that job, or through a separate non-mutating preview.

**Completion rule:** After recipient writes succeed, optional delivery projections must not turn the import into `erro` or hide its persisted summary. Log projection failures and return the completed import data with unavailable enrichment clearly marked.

**Why:** A transient large-list projection query can fail after the import itself has completed; putting that read on each status poll made a successful import appear to fail.

**How to apply:** Compute optional delivery metrics once after import writes, outside the import-failure path, and keep status GETs focused on the persisted job result.

Large PostgREST `in.(...)` filters must be bounded by encoded URL size, not only recipient count.

**Why:** A read-only reproduction with 1,000 synthetic e-mails generated a 35,963-character URL and received HTTP 431 from Supabase. Previously this optional read was reached only after import completion and surfaced as a generic 502, although recipients were already saved.

**How to apply:** Keep encoded filters below a conservative 6,000-character budget, preserve stage-specific errors, and do not retry imports to repair a failed progress read.