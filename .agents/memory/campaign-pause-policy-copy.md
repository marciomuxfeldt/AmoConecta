---
name: Campaign pause policy copy
description: Keep campaign pause-limit explanations synchronized with the backend evaluation policy.
---

The campaign interface should receive pause thresholds through the API response, sourced from the same backend policy used by evaluation. Do not duplicate those values in frontend copy or import server modules into the frontend.

**Why:** The interface's old prose had drifted from the values used to pause campaigns.

**How to apply:** When reputation policy changes, update the backend policy and evaluation together, expose the effective thresholds in the API contract, and render the interface explanation only from that response. Complaint thresholds must reflect the effective trigger used by evaluation.