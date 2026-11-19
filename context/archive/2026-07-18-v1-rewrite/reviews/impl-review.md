<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: NIM Review Action v1 Rewrite

- **Plan**: context/changes/v1-rewrite/plan.md
- **Scope**: Phase 1–4 of 4 (full plan review)
- **Date**: 2026-07-18
- **Verdict**: NEEDS ATTENTION
- **Findings**: 1 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING ⚠️ (1 finding) |
| Scope Discipline | PASS ✅ |
| Safety & Quality | FAIL ❌ (1 finding) |
| Architecture | PASS ✅ |
| Pattern Consistency | PASS ✅ |
| Success Criteria | PASS ✅ |

## Findings

### F1 — nil context passed to Chat() panics at runtime

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: internal/nimreview/nimreview.go:222
- **Detail**: `ReviewFile` passes `nil` as the context argument to `client.Chat(nil, model, ...)`. The `Chat` method calls `http.NewRequestWithContext(ctx, ...)` which panics on nil context per Go stdlib contract. Every file review will panic.
- **Fix**: Replace `nil` with `context.Background()` (or propagate a context parameter through `ReviewFile`/`ReviewFileWithFallback`).
  - Strength: One-line fix removes the crash. `context.Background()` matches the semantics — this action runs as a short-lived CLI, cancellation is not needed.
  - Tradeoff: None meaningful — propagating a real context would be cleaner long-term but is unnecessary for the current use case.
  - Confidence: HIGH — `http.NewRequestWithContext` documents the nil panic explicitly.
  - Blind spot: None significant.
- **Decision**: FIXED

### F2 — http.DefaultClient (no timeout) for GitHub API calls

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: internal/nimreview/nimreview.go:107,182
- **Detail**: `FetchDiff` and `PostComment` use `http.DefaultClient` which has no timeout. A stalled GitHub API response hangs the action indefinitely. The shared nimclient has a 120s timeout, but these GitHub calls bypass it.
- **Fix**: Use `http.NewRequestWithContext(ctx, ...)` with the action's context or create a dedicated `&http.Client{Timeout: 30 * time.Second}`.
  - Strength: Prevents indefinite hangs; aligns with the shared-client pattern already established.
  - Tradeoff: Minimal — a few lines changed.
  - Confidence: HIGH — standard Go pattern.
  - Blind spot: None significant.
- **Decision**: FIXED

### F3 — Bench CLI uses flags instead of planned env vars for iterations/prompt

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: cmd/nim-bench/main.go:24-26
- **Detail**: Plan specified `NIM_BENCH_ITERATIONS` and `NIM_BENCH_PROMPT` as env vars (consistent with how `nim-review` reads all config from env). Implementation uses `-iterations` and `-prompt` CLI flags instead. Also, plan mentioned p95 aggregation but only median is computed.
- **Fix A ⭐ Recommended**: Accept as intentional deviation — document in plan addendum
  - Strength: Flags are arguably better UX for a standalone CLI tool (vs the action which must use env). README already documents the flag interface. The mix (env for secrets/shared config, flags for bench-specific params) is reasonable.
  - Tradeoff: Plan diverges from implementation record — future reviews may flag it again.
  - Confidence: HIGH — the flag-based interface is internally consistent and documented.
  - Blind spot: None significant.
- **Fix B**: Switch to env vars as planned
  - Strength: Strict plan adherence; consistent with how nim-review reads config.
  - Tradeoff: Flags are more ergonomic for local CLI usage; env-only config is awkward for a benchmarking tool you run interactively.
  - Confidence: MEDIUM — functional but worse UX.
  - Blind spot: Would need README update.
- **Decision**: FIXED via Fix B

### F4 — Stream goroutine lifecycle in bench TTFT measurement

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: internal/nimclient/bench.go:68-82
- **Detail**: After getting the first token for TTFT measurement, the code breaks out of the range loop but doesn't cancel the context until line 82. The streaming goroutine stays blocked trying to send on the channel between break and cancel. This is a brief goroutine leak per iteration (bounded by the deferred cancel, so not a real leak, but suboptimal).
- **Fix**: Move `cancel()` immediately after the break to release the goroutine sooner.
  - Strength: Eliminates the brief window where the goroutine is stuck.
  - Tradeoff: None — cancel is idempotent and the deferred cancel is still a safety net.
  - Confidence: HIGH — straightforward context lifecycle.
  - Blind spot: None significant.
- **Decision**: FIXED

### F5 — Non-deterministic file review order

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: cmd/nim-review/main.go:42
- **Detail**: Iterating over `map[string]string` (filesDiff) gives non-deterministic order. The "first N files" reviewed may vary between runs. Cosmetic only — all files are reviewed regardless.
- **Fix**: Sort filenames before iterating for deterministic output order.
- **Decision**: FIXED
