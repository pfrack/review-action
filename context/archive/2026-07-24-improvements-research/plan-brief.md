# Code Improvements — Plan Brief

> Full plan: `context/changes/improvements-research/plan.md`
> Research: `context/changes/improvements-research/research.md`

## What & Why

Harden the review-action codebase by closing 2 CRITICAL security vulnerabilities (HTML injection via LLM output, SSRF to cloud metadata), fixing 8 correctness bugs that cause action failures or prompt injection relays, adding reliability safeguards (aggregate timeout, Retry-After), and decomposing the two largest modules into focused, testable units.

## Starting Point

The codebase has gone through 9 implementation reviews that fixed most historical issues. What remains are incomplete fixes (`escapeMarkdown` was added but doesn't escape `<`/`&`; SSRF check validates scheme but not host), bugs that were never caught (cleanup failures abort the action, revalidation parse failure bypasses all filtering), and structural debt accumulated over rapid iteration (`review.ts` = 14 exports, 7 responsibilities; `run()` = 389 LOC).

## Desired End State

The action is resilient to LLM output containing HTML, rejects metadata-endpoint URLs, gracefully handles transient failures, eliminates prompt injection relay paths, completes within 2 minutes even with unresponsive models, and has a modular codebase where each file has a single clear responsibility.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|-------------------|--------|
| Scope | Security + correctness + reliability + structure | Highest ROI combo: closes real vulnerabilities while paying down the structural debt that makes future fixes harder. | Plan |
| PR strategy | Single branch, single PR | Security fixes aren't urgent enough to warrant a separate fast-track PR given the single-maintainer context. | Plan |
| SSRF blocklist scope | Link-local + cloud metadata only | Self-hosted runners legitimately access RFC1918 addresses; only metadata endpoints are exploit targets. | Plan |
| Refactor ordering | Fixes first, then refactors | Ensures security fixes land without being blocked by larger structural changes. | Plan |
| review.ts split | config.ts + render.ts + merge into github-review.ts | Follows research's analysis of 7 responsibilities; each new module has a single clear purpose. | Research |
| run() decomposition | Extract all 5 functions to module scope | Makes each sub-operation independently testable; run() becomes a readable orchestrator. | Plan |
| Revalidation fallback | Return findings as-is on parse failure | Findings already passed mechanical hunk/file validation; LLM revalidation is a second-pass enhancement. | Plan |
| Zod error handling | Strip received values, use fixed strings | Eliminates injection relay without removing the schema-retry mechanism that improves success rates. | Plan |
| Cross-hunk findings | Deferred (not in scope) | Requires UX decisions about rendering context findings differently; current hard-drop is safe if imperfect. | Plan |
| Performance items | Aggregate timeout + Retry-After only | These two eliminate the worst failure modes (~15 lines total); parallel batching and token budgets are larger changes deferred. | Plan |

## Scope

**In scope:**
- Fix `escapeMarkdown` (add `<`, `&`)
- SSRF host blocklist for all provider URLs
- `max_files` validation
- `core.setSecret` for API keys
- `cleanupPreviousOutput` try/catch
- Zod error message sanitization
- `resp.json()` error handling
- `promptMode` coercion
- Revalidation fail-open fix + `f.issue` truncation
- Aggregate timeout on model chain
- `Retry-After` header support
- Split `review.ts` into `config.ts`, `render.ts`, expanded `github-review.ts`
- Decompose `run()` into 5 named functions

**Out of scope:**
- Cross-hunk findings, token budgets, parallel batching, dynamic batch sizing
- Dead code cleanup, bench-entry decomposition, language detection improvements
- Global LLM call budget counter

## Architecture / Approach

Phases 1-3 are surgical patches (5-20 lines each) applied to existing files. Phase 4 splits `review.ts`'s 14 exports across 3 new/expanded modules, leaving it as a focused "diff parsing and validation" module. Phase 5 flattens `run()`'s nested closures into module-level functions with explicit parameters. All changes are covered by unit tests using the existing `node:test` + `assert` pattern.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Security & Input Validation | Closes HTML injection + SSRF + input validation gaps | Regex change could over-escape legitimate markdown (mitigated by tests) |
| 2. Correctness & Robustness | 6 bug fixes: cleanup, Zod, json, promptMode, revalidation | Changing retry prompt format could affect schema-retry success rate |
| 3. Reliability | Aggregate timeout + Retry-After | Timeout too aggressive could kill slow-but-working models (120s is generous) |
| 4. Split review.ts | 14 exports → 3 focused modules | Import path changes across many files; risk of missed update |
| 5. Decompose run() | 389 LOC → ~60 LOC orchestrator | Hoisting closure captures 6 vars; risk of missed parameter |

**Prerequisites:** None — all changes are against the current `fix/review-creation-500-fallback` branch.
**Estimated effort:** ~3-4 implementation sessions across 5 phases.

## Open Risks & Assumptions

- The `Retry-After` parsing assumes providers return seconds (integer) rather than HTTP-date format — may need both
- `madge` (circular dependency check in Phase 4) would need to be installed as a dev dependency or run ad-hoc
- Phase 5's `dispatchOutput` extraction may be complex due to the 4-way branching that depends on multiple state variables

## Success Criteria (Summary)

- All known HTML injection and SSRF vectors are closed with tests proving it
- The action no longer crashes on transient cleanup failures or malformed LLM responses
- Model chain completes within 2 minutes regardless of provider state
- `review.ts` < 200 LOC; `run()` < 80 LOC
