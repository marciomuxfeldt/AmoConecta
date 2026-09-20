---
name: E-mail HTML sanitization
description: Durable constraint for sanitizing the limited rich-text HTML used in campaign e-mails.
---

The rich-text sanitizer must allow both opening and closing forms of every supported tag; the allowlist match must account for an optional slash after `<`.

**Why:** A sanitizer that only recognizes opening tags silently removes closing tags, producing malformed markup and changing the visual output of formatted text.

**How to apply:** When expanding or changing the supported tag list, test nested formatting and unsafe links in the final rendered HTML, not only the sanitized fragment.