---
change: "parallel-review-hardening"
title: "Pipeline Hardening from Parallel Review Findings"
status: implemented
created: 2026-08-02
updated: 2026-08-02
plan_reviewed_at: 2026-08-02T14:47:42Z
---

# Pipeline Hardening from Parallel Review Findings

**Change 2 of 3** from the `parallel-review-findings` research umbrella.

Fixes the reliability, execution-safety, probe, and GitHub-integration findings
from research §1-3 that were not covered by Change 1 (security, implemented)
or Change 3 (testing, separate).

Scope:
- Retry: fix dead-retry error type in benchmark callers + add jitter
- Response robustness: guard undefined `usage`/`finishReason`
- Execution safety: batch-loop try/catch + dropped-batch logging + winner-take-all abort observability
- Probe redesign: availability check + latency measurement, no chain reorder
- GitHub/config cleanup: `.json()` parse guard, `createComment` 404 handling, event-type validation
