---
name: Resend event arrival race
description: Why webhook events stay durable and retry recipient matching briefly.
---

Persist a verified Resend event before acknowledging it. Recipient matching must retry for a bounded period because Resend can deliver an event before the send worker has persisted the provider email ID. Keep event application atomic and idempotent.

**Why:** Marking an unmatched event complete immediately can lose delivery, bounce, complaint, open, or click state during the short gap between provider acceptance and the sender's database update.

**How to apply:** When changing webhook acknowledgement, sender persistence, or worker event processing, preserve the retry path for unmatched provider IDs and retain the raw event for audit.