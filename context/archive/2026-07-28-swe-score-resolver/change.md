---
id: swe-score-resolver
title: "SWE Score Resolver — auto-map 0.5 models to real scores"
status: archived
archived_at: 2026-08-01T21:33:46Z
created: 2026-07-28
updated: 2026-08-01
type: tooling
tags: [benchmark, swe-bench, model-matching, scores]
---

# SWE Score Resolver

CLI script that resolves models with default 0.5 SWE-bench score to their actual leaderboard scores using enhanced deterministic matching + LLM fallback. Run after benchmark to patch `SWE_BENCH_SCORES` table.
