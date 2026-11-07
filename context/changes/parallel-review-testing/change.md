---
change: "parallel-review-testing"
title: "Testing Debt from Parallel Review Findings"
status: implemented
created: 2026-08-02
updated: 2026-08-02
plan_reviewed_at: 
---

# Testing Debt from Parallel Review Findings

**Change 3 of 3** from the `parallel-review-findings` research umbrella.

Retires the testing gaps from research §4 that Change 1 (security, implemented) and Change 2
(hardening, impl_reviewed) did not cover. Change 2 already added tests for the functions it touched
(retry, swe-resolver, executeReview batch loop, prioritizeChain, github .json()/404/retry), so this
change focuses on the genuinely remaining debt.

Scope:
- CRITICAL: untested `run()` orchestrator (export + end-to-end test)
- HIGH: `diff-utils` real split assertions; `rules` all 11 injection patterns
- MEDIUM: GitHub multi-page pagination tests
- LOW: `openai-client` `listModels` / `sanitizeErrorBody` / `effectiveFormat` tests
- Hygiene: rewrite coverage-bait assertion; `withEnv()` helper to kill 20+ env boilerplate blocks
