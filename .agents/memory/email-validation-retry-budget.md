---
name: Email validation retry budget
description: The campaign workflow's per-address ZeroBounce retry cap and how manual resume interacts with it.
---

Keep the limit at three total attempts per address, including the initial call. Manual resume must preserve the attempt count; when the third attempt fails, mark the item `ignorado` with its reason rather than classifying it as valid or invalid. Current retry waits are 30 seconds after attempt one and 60 seconds after attempt two.

**Why:** The review identified addresses that could be retried more than 1,400 times. A manual resume must not reset an address's budget, and an exhausted address has no reliable validity verdict.

**How to apply:** Keep worker retry handling and the database resume function aligned. If the attempt limit changes, update both paths and the user-facing outcome together.
