---
id: openrouter-provider
title: Add OpenRouter and Kilo as first-class providers with free-model support
status: impl_reviewed
  created: 2026-07-25
  updated: 2026-07-26
---

# openrouter-provider — IMPLEMENTED

This change adds OpenRouter and Kilo Gateway as first-class provider slots, plus a `custom_models` CSV enhancement. Free-tier models get estimated SWE-bench scores and are forced to rank last in the combined fallback chain.

**Plan**: `context/changes/openrouter-provider/plan.md`
**Brief**: `context/changes/openrouter-provider/plan-brief.md`

⚠️ **Open risk**: Reverses the `kilocode-provider` cancellation (2026-07-20). Kilo free tier routes to providers that log prompts for training — see change.md cancellation note.