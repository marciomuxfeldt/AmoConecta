---
name: Import count semantics
description: Campaign import summaries distinguish new records, existing records updated, and duplicate CSV rows.
---

For campaign imports, “Salvos” means only records whose normalized email was absent before the job; existing campaign emails are “Atualizados”, and repeated emails within the same CSV are “Duplicados no arquivo”.

**Why:** The operator uses the new audience count to decide whether a campaign should be sent; counting upserted existing rows produces an unsafe operational conclusion.

**How to apply:** Snapshot existing campaign emails in stable pages before streaming, classify unique valid rows before upsert, and keep the UI card tied to the new-record count.