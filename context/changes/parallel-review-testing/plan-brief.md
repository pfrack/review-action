# Testing Debt from Parallel Review Findings — Plan Brief

> Full plan: `context/changes/parallel-review-testing/plan.md`
> Research: `context/changes/parallel-review-findings/research.md`

## What & Why

The parallel review of `review-action` (research §4) found critical testing gaps: the entire `run()`
orchestrator is untested (CRITICAL), `diff-utils` splitting is asserted with trivially-true checks,
`rules` only tests 2 of 11 prompt-injection patterns, GitHub pagination loops are untested, and three
`openai-client` functions have no direct tests. Change 1 (security) and Change 2 (hardening) already
shipped tests for the functions they touched — this change 3 retires the *remaining* testing debt so
the suite honestly covers the pipeline.

## Starting Point

`retry.test.ts`, `swe-resolver.test.ts`, and parts of `index.test.ts` / `github-review.test.ts` were
filled in by the hardening change. What's left open was verified by reading the current files: the
`run()` orchestrator (index.ts:582) is not exported and untested; `diff-utils.test.ts` "split" test
asserts only `chunks.length >= 1`; `rules.test.ts` covers `ignore`/`disregard` only; `github-review`
pagination loops have no tests; `openai-client` `listModels`/`sanitizeErrorBody`/`effectiveFormat`
are untested.

## Desired End State

`run()` is exercised end-to-end (config → chain → diff → review → dispatch) and proven to post the AI
Code Review comment. `diff-utils` asserts real hunk-boundary splitting, `rules` asserts all 11
injection patterns, GitHub pagination scans multiple pages and terminates, and `openai-client`'s
three functions have direct tests. Coverage-bait is gone and env boilerplate is consolidated into
`withEnv()`. `npm run build && npm test` is green.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|------------------|--------|
| Scope | All open gaps (CRITICAL→LOW) + hygiene | Single change retires the debt completely | Plan |
| `run()` coverage | Full orchestrator test (export `run`, guarded mock) | Closes the CRITICAL gap and proves wiring | Plan |
| Coverage bait | Rewrite as real assertions | Removes false confidence; honest coverage | Plan |
| `withEnv()` refactor | Include in this change | Kills 20+ duplicated env blocks; test hygiene | Plan |
| GitHub pagination | Add multi-page tests | Proves loop termination / match on later page | Plan |
| Success gate | Tests pass + explicit list (no coverage tool) | Matches current `node --test` tooling; no new CI infra | Plan |

## Scope

**In scope:**
- Export `run()` and add an end-to-end orchestrator test (success + no-reviewable-files cases)
- `diff-utils.test.ts` real split + `startLine` assertions
- `rules.test.ts` tests for all 11 `INJECTION_PATTERNS`
- `github-review.test.ts` multi-page `findExistingReview` / `findExistingComment` tests
- `openai-client.test.ts` `listModels`, `sanitizeErrorBody`, `effectiveFormat` (export `effectiveFormat`)
- Rewrite `index.test.ts` bait test into a real parsed-shape assertion
- `withEnv()` helper in `test-utils.ts` + refactor `config.test.ts` / `review.test.ts`

**Out of scope:**
- Coverage-enforcement tooling (c8 / `--experimental-coverage`)
- Testing benchmark CLI (`swe-resolver.main`, `bench-entry`, `model-history`)
- Behavior changes to `effectiveFormat` / `sanitizeErrorBody` (export only)
- Winner-take-all → compare-quality redesign (separate change)

## Architecture / Approach

Four risk-ordered phases, each shipping green:
1. **HIGH gaps** — `diff-utils` + `rules` (lowest risk, highest value).
2. **CRITICAL orchestrator** — export `run()`, drive it with env inputs + a custom-model
   `startMockServer` returning valid `ReviewJsonSchema` JSON + a `globalThis.fetch` mock that returns
   the diff and captures the posted comment.
3. **MEDIUM/LOW** — GitHub pagination + `openai-client` (export `effectiveFormat`).
4. **Hygiene** — rewrite the bait test; add `withEnv()` and refactor the two duplicated suites.

The `run()` test relies on the existing `if (!inTest)` guard (index.ts:656) that already prevents
auto-invocation under `node --test`; the test also sets `NODE_TEST_CONTEXT=1` as a safety net.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|------------------|----------|
| 1. HIGH gaps | Real diff-split + all injection-pattern tests | Low — pure test additions |
| 2. CRITICAL orchestrator | End-to-end `run()` test asserting comment posted | `run()` wiring/mock fidelity; env-input names |
| 3. MEDIUM/LOW | Pagination + openai-client tests | Low — `effectiveFormat` export only source change |
| 4. Hygiene | Bait rewrite + `withEnv()` refactor | Mechanical refactor of 2 suites must preserve behavior |

**Prerequisites:** None — independent of Change 1/2 (both shipped).
**Estimated effort:** ~2-3 sessions across 4 phases (~10 test files touched, 2 `export` source edits).

## Open Risks & Assumptions

- The `run()` test depends on `core.getInput` reading `INPUT_*` env vars (verified in config.ts:47) —
  if a CI wrapper sets inputs differently, the test env setup must match.
- `startMockServer` must return valid `ReviewJsonSchema` JSON or `validateFindings` drops all findings;
  the mock body shape is load-bearing.
- `process.argv` may or may not contain `--test` under `node --test`; `NODE_TEST_CONTEXT` is set in the
  test as a guarantee, but the existing `index.test.ts` import already proves the guard holds.
- The `withEnv()` refactor touches `config.test.ts` / `review.test.ts` broadly; it must be mechanical
  (behavior-preserving) and gated on all suites staying green.

## Success Criteria (Summary)

- `npm run build && npm test` is green across all suites.
- `run()` is proven to post the AI Code Review comment (test fails if it doesn't).
- `diff-utils` and `rules` assertions are load-bearing (fail on regression, not bait).
- GitHub pagination and `openai-client` functions have direct, passing tests.
