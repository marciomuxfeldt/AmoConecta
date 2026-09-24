---
name: Campaign click destinations
description: Decision about the campaign-level URL columns versus email block links.
---

Use an email button block's `href` as the campaign's active primary click destination. Keep legacy `url_deeplink` and `url_landing` database columns untouched, but do not expose or use them in the current campaign API, form, or schedule validation.

**Why:** Existing stored URL values should not be destructively removed, and parallel campaign-level destinations compete with the link configured on the email itself.

**How to apply:** For future campaign UI/API work, keep button-block destinations authoritative. Do not drop the legacy database columns or reactivate them unless the user explicitly requests a migration.