---
name: Worker deployment manifest
description: Prevent the API artifact manifest from being used for the scheduled worker deployment.
---

Before publishing the scheduled worker in this Repl, rename `artifacts/api-server/.replit-artifact/artifact.toml` to `artifact.toml.disabled`.

**Why:** The API artifact manifest is active on `origin/main`; if it remains enabled, the Scheduled Deployment can start the API instead of the worker and stop all sends.

**How to apply:** Treat renaming the API manifest as a required pre-publish step and tell the user why it is needed.
