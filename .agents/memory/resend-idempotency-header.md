---
name: Resend idempotency header
description: Internal deduplication keys must stay on the HTTP request, never in the delivered email payload.
---

The Resend `Idempotency-Key` belongs only in the HTTP headers sent to the Resend API. It must not appear in the message `headers` object, because Resend can deliver those entries as email headers and expose internal implementation details.

**Why:** Resend's deduplication applies to the API request, while message headers become part of the delivered email.

**How to apply:** Keep the key in the internal request metadata and set it in `fetch(..., { headers })`; defensively remove any case variant of `Idempotency-Key` from payload message headers before serialization.