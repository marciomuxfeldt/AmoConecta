---
name: Technical error persistence
description: Persist technical failures while exposing friendly messages only at the HTTP boundary.
---

Background job error columns store structured technical details as JSON text, including exception name, original message, code, details, hint, and stack; API responses mask that value with a user-facing message.

**Why:** Replacing the original failure with a friendly sentence prevents diagnosing asynchronous jobs and can expose internal details if the persisted field is returned directly.

**How to apply:** Normalize unknown errors at the server boundary for both logs and persistence, and map internal job errors to safe response text before serializing API output.