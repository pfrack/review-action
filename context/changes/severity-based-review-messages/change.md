---
id: severity-based-review-messages
title: Differentiate review messages by finding severity
status: impl_reviewed
created: 2026-07-21
updated: 2026-07-21
---

# severity-based-review-messages

Produce visibly-different review output depending on the severity of each
finding (Critical / Warning / Suggestion), across both the per-finding body
and the top-of-comment summary. Default rendering currently treats all three
severities as identical bullets; this change makes them visually distinct
without adding new schema fields.
