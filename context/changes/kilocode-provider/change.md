---
id: kilocode-provider
title: Evaluate Kilo Gateway as first-class provider (kilocode-api)
status: cancelled
created: 2026-07-20
updated: 2026-07-20
cancelled: 2026-07-20
cancellation_reason: "After full evaluation including model-tier inspection, user decided against Kilo entirely. The privacy caveat on `kilo-auto/free` (routes to providers that log prompts and use them for training) makes it unsuitable as a default for a code-review action ingesting PR diffs. The paid Auto tiers (`kilo-auto/efficient`, `kilo-auto/balanced`, `kilo-auto/frontier`) are technically viable but the project does not yet have a clear use case that the existing `custom_api_url` slot cannot serve. Deferring until/unless a concrete Kilo-specific user need emerges."
---

# kilocode-provider — CANCELLED

This change was cancelled on 2026-07-20 after a full evaluation. See
`research.md` for the decision record (model-tier inspection, Go/No-Go matrix,
cancellation reasoning).

**TL;DR of decision**: `kilo-auto-efficient` exists and is technically viable,
but the project's existing `custom_api_url` slot already covers the use case
without the ~150-line first-class-slot cost. No current user need justifies
the investment. Reopen only if a concrete Kilo-specific gap appears that the
generic `custom_*` surface cannot serve.