---
name: CSV import validation rules
description: The dashboard CSV date format and which fields may reject an imported contact.
---

Dashboard dates may arrive as Portuguese long-form values such as `4 outubro, 2024, 22:07`; store only the calendar date. Missing or malformed dates, missing names, invalid phones, ids, and regions do not reject a row. E-mail is the only field-level validation that can reject a row; deduplication and suppression policies still apply.

**Why:** The dashboard export uses a localized timestamp format and contact imports should remain usable when optional enrichment fields are incomplete.

**How to apply:** Normalize the date to ISO `YYYY-MM-DD` when valid, otherwise store `null` and count it under `sem data`; derive a fallback name from the normalized e-mail local part when needed.