---
name: Canonical e-mail normalization
description: Standing requirement against introducing alternative e-mail normalization rules.
---

Use the existing canonical normalizer for e-mail keys, including webhook events. In SQL, use `public.normalize_email()` rather than creating another definition with `lower`, `btrim`, or an equivalent local expression.

**Why:** The user explicitly reinforced this after several review rounds. Different normalization rules can split one address into multiple contacts and inflate campaign metrics.

**How to apply:** Reuse the canonical helper when normalization is necessary. For columns already protected by validated normalized-address constraints, direct equality is appropriate and preserves index eligibility; do not wrap indexed lookup columns unnecessarily.
