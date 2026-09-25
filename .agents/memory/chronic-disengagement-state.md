---
name: Chronic disengagement state
description: Durable storage and refresh rules for chronic e-mail disengagement.
---

Store chronic disengagement once per normalized e-mail (`lower(btrim(email))`), not on every campaign-recipient delivery row. Refresh the contact state in cursor-based batches of at most 1,000 e-mails, persisting progress between worker executions. Only advance the completed-calculation timestamp after a full pass.

**Why:** Delivery history can contain millions of rows and many rows per person. Replicated flags and row-level inheritance triggers multiply writes, make imports run one lookup per row, and make a full refresh likely to exceed the worker timeout.

**How to apply:** Queries over historical delivery rows must normalize with the same expression. Tables guaranteed normalized at write time may use their raw indexed e-mail column for lookups. Keep the classification reversible and preserve the first timestamp at which a currently chronic contact became chronic.