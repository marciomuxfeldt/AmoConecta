---
name: Campaign content lock
description: The lifecycle rule for immutable campaign message content
---

Once a campaign has entered scheduled, sending, or paused state, its message content, sender, and links must remain unchanged.

**Why:** Resuming or retrying a campaign can reuse a stable delivery identity; allowing the body or delivery metadata to change creates a mismatch between the content and the deduplication key.

**How to apply:** Enforce the rule in the backend before updates are persisted. Keep operational fields editable when safe, and leave completed campaigns outside this lock unless a later requirement adds a post-completion audit rule.