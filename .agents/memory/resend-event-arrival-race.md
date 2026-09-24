---
name: Resend event arrival race
description: Why webhook events stay durable and retry recipient matching briefly.
---

Persist a verified Resend event before acknowledging it. Recipient matching must retry for a bounded period because Resend can deliver an event before the send worker has persisted the provider email ID. Keep event application atomic and idempotent.

**Why:** Marking an unmatched event complete immediately can lose delivery, bounce, complaint, open, or click state during the short gap between provider acceptance and the sender's database update.

**How to apply:** When changing webhook acknowledgement, sender persistence, or worker event processing, preserve the retry path for unmatched provider IDs and retain the raw event for audit.

For bounce handling, suppress only when the payload explicitly identifies a `permanent` or `hard` bounce, case-insensitively. Preserve the raw classification (or a missing marker) separately for diagnosis. When inserting a suppression that already exists, use `DO NOTHING` so the first recorded reason is retained.

**Why:** Unknown provider values must not cause irreversible suppression, and overwriting an unsubscribe reason destroys important audit history.

**How to apply:** Keep bounce classification positive and narrow; make the `ON CONFLICT` target match the existing partial unique email index.