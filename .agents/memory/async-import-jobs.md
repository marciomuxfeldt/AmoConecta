---
name: Asynchronous CSV import jobs
description: Large CSV validation must outlive the HTTP request and expose persisted progress.
---

CSV validation is represented by a persisted import job with status and progress; the POST only creates the job, a background worker streams Storage data in 5,000-row blocks, and the UI polls until the result is complete.

**Why:** Proxy request timeouts make synchronous validation unsuitable for large dashboard exports, even when the parser itself is streaming.

**How to apply:** Keep progress and terminal results in the import job row, return a stable job id from the POST, and never put full-file processing back inside the request handler.