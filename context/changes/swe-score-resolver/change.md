---
id: swe-score-resolver
title: "SWE Score Resolver — auto-map 0.5 models to real scores"
status: impl_reviewed
created: 2026-07-28
updated: 2026-07-28
type: tooling
tags: [benchmark, swe-bench, model-matching, scores]
---

# SWE Score Resolver

CLI script that resolves models with default 0.5 SWE-bench score to their actual leaderboard scores using enhanced deterministic matching + LLM fallback. Run after benchmark to patch `SWE_BENCH_SCORES` table.
