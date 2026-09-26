---
name: Worker storage boundary
description: Cross-Repl access constraints for background worker object storage.
---

The scheduled worker runs in a separate Repl and cannot rely on the main Repl's App Storage sidecar or bucket configuration. Worker-owned objects should use Supabase Storage through the server-side service-role client. Keep buckets private and proxy downloads through the authenticated API with short-lived signed URLs.

**Why:** App Storage upload URLs returned 401 when requested from the separate worker; the storage configuration belongs to the main Repl and is not shared across Repls.

**How to apply:** For new background jobs that upload or delete files, use the server-side Supabase Storage API and keep the bucket private. Retain App Storage access only for transitional reads of files created before the migration.