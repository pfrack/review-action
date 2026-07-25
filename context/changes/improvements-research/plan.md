# Code Improvements Implementation Plan

## Overview

Harden the review-action codebase with security fixes, correctness patches, targeted reliability improvements, and structural refactors — in that order. This plan addresses 2 CRITICAL security vulnerabilities, 8 WARNING-level bugs, 2 reliability gaps, and 2 structural debt items identified in `context/changes/improvements-research/research.md`.

## Current State Analysis

The codebase is a TypeScript GitHub Action (~15 source files, ~2000 LOC) that performs AI-powered code review on PRs. It has gone through 9 implementation reviews that fixed most historical issues, but left behind:

- **Security holes**: `escapeMarkdown` doesn't escape `<` or `&` (HTML injection via LLM output), and SSRF protection only checks URL scheme — no host blocklist exists for cloud metadata endpoints.
- **Correctness bugs**: Cleanup failures abort the action, `resp.json()` errors crash unhandled, `max_files` accepts negatives, Zod error messages relay prompt injections, revalidation parse failures bypass all hallucination filtering.
- **Reliability gaps**: No aggregate timeout on the model chain (worst case 2+ hours), `Retry-After` headers ignored on 429 responses.
- **Structural debt**: `review.ts` is a 374-LOC god-module with 7 responsibilities and 14 exports; `run()` in `index.ts` is 389 LOC with nested closures capturing 6 variables.

### Key Discoveries:

- `escapeMarkdown` at `src/utils.ts:10` — regex `/[\\*_{}\[\]()#\`>+~|!]/g` omits `<` and `&`
- SSRF validation at `src/index.ts:31-39` — only checks protocol, allows `https://169.254.169.254`
- `withRetry` at `src/retry.ts:10` — pure exponential backoff, no `Retry-After` awareness
- `revalidateFindings` at `src/validation.ts:53` — on JSON parse failure returns all findings unchecked
- `review.ts` exports 14 symbols; `index.ts` imports 10 of them
- No `src/config.ts` or `src/render.ts` exist yet — clean targets for extraction
- Test runner: `node:test` with `describe`/`it`, `assert` module, no mock library, tests compiled via `tsc` then run from `dist/`

## Desired End State

After this plan is complete:
1. All known HTML injection vectors are closed (`<`, `&` escaped in markdown output)
2. Cloud metadata SSRF is blocked for all provider URL inputs
3. The action no longer crashes on transient cleanup failures, malformed JSON responses, or invalid input values
4. Prompt injection relays via Zod messages and revalidation prompts are eliminated
5. Model chain execution has a hard time cap; 429 responses are handled correctly
6. `review.ts` is decomposed into focused modules (`config.ts`, `render.ts`, `github-api.ts`)
7. `run()` is a ~60-line orchestrator calling named, testable functions

Verification: `npm run build && npm test` passes with all new tests green. Each fix has at least one unit test proving the vulnerability/bug is closed.

## What We're NOT Doing

- **Cross-hunk findings (Q7)** — Requires UX decisions about rendering "context findings" differently. Deferred.
- **Token budget enforcement / dynamic batch sizing (P3, P8)** — Valuable but requires significant changes to the batching pipeline. Separate plan.
- **Parallel batch processing (P4)** — Changes control flow substantially. Separate plan.
- **Language detection improvements (Q6)** — Requires adding filename-based detection table. Low urgency.
- **Dead code cleanup (S5)** — `diff-utils.ts` and `removed-models.ts` orphans. Trivial but unrelated to this plan's goals.
- **bench-entry.ts decomposition (S11)** — The benchmark CLI is not user-facing. Low priority.
- **Probe optimization (P6)** — Skipping probes for small chains is a micro-optimization.
- **Global LLM call budget (D10)** — Aggregate timeout (Phase 3) covers the worst case; a counter adds complexity for marginal benefit.

## Implementation Approach

Fixes first, refactors second. Phases 1-3 are surgical patches (5-20 lines each) applied to current file locations. Phases 4-5 are structural refactors that move code into proper module boundaries. This ordering means:
- Security/correctness fixes land immediately without being blocked by refactors
- Refactors operate on already-fixed code, so nothing gets lost in the move
- Each phase is independently verifiable

Single branch, single PR. All phases must pass before merge.

---

## Phase 1: Security & Input Validation

### Overview

Close the two CRITICAL security vulnerabilities (HTML injection, SSRF) and harden input validation for `max_files` and API key exposure.

### Changes Required:

#### 1. Fix `escapeMarkdown` — add `<` and `&`

**File**: `src/utils.ts`

**Intent**: Add `<` and `&` to the escape regex so LLM output cannot inject raw HTML or entity-decoded HTML into GitHub PR comments.

**Contract**: The regex character class in `escapeMarkdown` must include `<` and `&`. The function signature and return type are unchanged.

#### 2. Add SSRF host blocklist for all provider URLs

**File**: `src/index.ts`

**Intent**: Reject URLs pointing to cloud metadata endpoints (`169.254.0.0/16`, `fd00:ec2::254`, `metadata.google.internal`) for `custom_api_url` and all provider base URLs (`nim_base_url`, `mistral_base_url`, `groq_base_url`). Block link-local and known metadata hostnames. Allow RFC1918 for self-hosted runner flexibility.

**Contract**: New function `validateProviderUrl(url: string, label: string): void` that throws on blocked hosts. Called for every provider URL in the config validation block. The blocked ranges:
- `169.254.0.0/16` (IPv4 link-local, covers AWS/Azure metadata at `169.254.169.254`)
- `fe80::/10` (IPv6 link-local)
- `fd00:ec2::254` (AWS IPv6 metadata)
- Hostname equals `metadata.google.internal`

#### 3. Validate `max_files` is a positive integer

**File**: `src/review.ts`

**Intent**: Reject negative and non-integer values for `max_files` instead of silently allowing `slice(0, -N)` to drop trailing files. Clamp to a reasonable maximum (500).

**Contract**: Parse with `Number.parseInt`, validate `> 0` and `<= 500`, fall back to `100` with a `core.warning` on invalid values.

#### 4. Mask API keys with `core.setSecret`

**File**: `src/index.ts`

**Intent**: Register all API key values as secrets so they are redacted from Actions logs if accidentally included in error messages.

**Contract**: Call `core.setSecret(key)` for each non-empty API key (`nim_api_key`, `mistral_api_key`, `groq_api_key`, `custom_api_key`) immediately after `loadConfig()`.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- All tests pass: `npm test`
- New unit test: `escapeMarkdown` escapes `<`, `>`, `&` correctly
- New unit test: `validateProviderUrl` blocks `169.254.169.254`, `metadata.google.internal`, allows `api.example.com`
- New unit test: `max_files` rejects `-5`, `0`, `5e3`; accepts `1`, `100`, `500`
- Type checking passes: `npx tsc --noEmit`

#### Manual Verification:

- Confirm escaped markdown renders correctly in a GitHub comment (no raw HTML leaks)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Correctness & Robustness

### Overview

Fix 6 correctness bugs that cause action failures, information leaks, or prompt injection relays.

### Changes Required:

#### 1. Wrap `cleanupPreviousOutput` in try/catch

**File**: `src/index.ts`

**Intent**: Make cleanup of previous bot output best-effort. A transient 500 while deleting old comments should not abort the action when new review content is ready to post.

**Contract**: Each call site of `cleanupPreviousOutput` (lines ~347, 364, 392, 403) wrapped in try/catch that calls `core.warning()` on failure and continues.

#### 2. Fix Zod `i.message` interpolation in retry prompt

**File**: `src/index.ts`

**Intent**: Eliminate prompt-injection relay where an LLM's malformed first response (containing injection text in an enum field) gets echoed back via Zod's error message into the retry prompt.

**Contract**: Replace `i.message` interpolation with a fixed string per Zod issue code. The `errorSummary` variable should use only `i.path.join('.')` and a static description like `"invalid value"` — never the received value.

#### 3. Fix `resp.json()` error handling in OpenAI client

**File**: `src/openai-client.ts`

**Intent**: Prevent raw `SyntaxError` stack traces (which may contain response fragments) from leaking into Actions logs when a provider returns non-JSON on HTTP 200.

**Contract**: Wrap `resp.json()` in try/catch. On `SyntaxError`, throw `RetryableError` with a sanitized message (`"${providerLabel} returned non-JSON response"`, status 502).

#### 4. Coerce `promptMode` to valid value

**File**: `src/review.ts`

**Intent**: Make the warning message truthful — when `promptMode` is invalid, actually coerce it to `'append'` instead of keeping the invalid value.

**Contract**: `const promptMode: 'append' | 'replace' = raw === 'replace' ? 'replace' : 'append';` with the warning firing when `raw` is neither.

#### 5. Fix revalidation fail-open on JSON parse failure

**File**: `src/validation.ts`

**Intent**: When the revalidation LLM returns unparseable JSON, fall back to the mechanical filter (findings already passed hunk-overlap + file-existence checks) rather than passing everything unchecked. Also fix the silent length mismatch when the boolean array is shorter than the findings array.

**Contract**: On `JSON.parse` failure or non-array result, return findings as-is (they already passed `validateFindings`'s structural checks). On length mismatch (`parsed.length < findings.length`), log a warning and treat missing entries as `true` (pass through) rather than silently dropping.

#### 6. Cap `f.issue` length in revalidation prompt

**File**: `src/validation.ts`

**Intent**: Limit the size of untrusted LLM-generated `f.issue` text interpolated into the revalidation prompt to reduce prompt injection relay surface.

**Contract**: Truncate `f.issue` to 200 characters in the `findingsText` construction. Use `f.issue.slice(0, 200)`.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- All tests pass: `npm test`
- New unit test: `cleanupPreviousOutput` failure doesn't throw (mock the function to throw, verify run() continues)
- New unit test: Zod error summary contains no received values (parse a known-bad response, verify errorSummary content)
- New unit test: `resp.json()` SyntaxError produces RetryableError with status 502
- New unit test: invalid `promptMode` coerces to `'append'`
- New unit test: `revalidateFindings` with unparseable response returns all findings (not empty)
- New unit test: `revalidateFindings` with short boolean array doesn't silently drop findings
- New unit test: `f.issue` longer than 200 chars is truncated in revalidation prompt
- Type checking passes: `npx tsc --noEmit`

#### Manual Verification:

- Trigger the action on a test PR and verify it completes even when GitHub API is intermittently slow

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Reliability

### Overview

Add an aggregate timeout to the model chain loop and honour `Retry-After` headers on 429 responses, eliminating the two worst reliability failure modes.

### Changes Required:

#### 1. Add aggregate timeout to model chain loop

**File**: `src/index.ts`

**Intent**: Prevent the worst-case scenario where 15 models × 540s timeout = 2+ hours. Cap the entire model chain execution at a configurable timeout (default 120s).

**Contract**: Wrap the `runModelChainForBatch` call in `Promise.race` with a timeout. On timeout, log a warning and treat as "no model succeeded" (same behavior as exhausting the chain). The timeout value should be a constant `CHAIN_TIMEOUT_MS = 120_000` at module scope.

#### 2. Honour `Retry-After` header on 429

**File**: `src/retry.ts`

**Intent**: When a provider returns 429 with a `Retry-After` header, use that value as the minimum delay instead of the default exponential backoff which may be too short.

**Contract**: Extend `RetryableError` to accept an optional `retryAfterMs?: number` field. At the throw site in `openai-client.ts`, read `response.headers.get('Retry-After')`, parse it (seconds or HTTP-date), and pass it to `RetryableError`. In `withRetry`, use `Math.max(delay, error.retryAfterMs ?? 0)` as the actual sleep duration. Cap at 60s to prevent a malicious server from stalling the action indefinitely.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- All tests pass: `npm test`
- New unit test: model chain times out after the configured duration, returns gracefully
- New unit test: `withRetry` uses `retryAfterMs` when present and it exceeds computed backoff
- New unit test: `Retry-After` header parsed correctly (integer seconds case)
- New unit test: `retryAfterMs` capped at 60s even if header says higher
- Type checking passes: `npx tsc --noEmit`

#### Manual Verification:

- Verify action completes within ~2 minutes even when the first several models are unresponsive

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Structural Refactor — Split review.ts

### Overview

Decompose `review.ts` (374 LOC, 14 exports, 7 responsibilities) into focused single-responsibility modules. This is a move-only refactor — no behavior changes.

### Changes Required:

#### 1. Extract `config.ts`

**File**: `src/config.ts` (new)

**Intent**: Move `loadConfig()`, the `Config` interface, and `splitCSV` helper into a dedicated config module.

**Contract**: New file exports `Config` (interface), `loadConfig()` (function), and `splitCSV` (function — also eliminates the duplication with `bench-entry.ts`). All importers of `loadConfig` and `Config` from `review.ts` update to import from `config.ts`.

#### 2. Extract `render.ts`

**File**: `src/render.ts` (new)

**Intent**: Move `renderReview()` and `severityTally()` into a rendering module.

**Contract**: New file exports `renderReview` and `severityTally`. Both are pure functions with no side effects — clean extraction.

#### 3. Merge comment CRUD into `github-review.ts`

**File**: `src/github-review.ts` (expanded)

**Intent**: Move `postComment`, `deleteComment`, `findExistingComment` from `review.ts` into `github-review.ts`, consolidating all GitHub API interaction in one module.

**Contract**: `github-review.ts` gains three new exports: `postComment`, `deleteComment`, `findExistingComment`. The file already handles `createReview`, `findExistingReview`, `deleteReview`. After this move, all GitHub API calls live in one module.

#### 4. Leave diff logic in `review.ts` (renamed role)

**File**: `src/review.ts` (reduced)

**Intent**: After extraction, `review.ts` retains only: `parseDiff`, `parseDiffHunks`, `getFileHunks`, `fetchDiff`, `shouldExclude`, `globMatch`, `DiffTooLargeError`, and `validateFindings`. These are all diff-related. The file's responsibility is now "diff parsing and validation."

**Contract**: `review.ts` exports are reduced from 14 to 8. All removed exports are re-exported from their new homes. No behavior changes.

#### 5. Update all import paths

**Files**: `src/index.ts`, `src/index.test.ts`, `src/review.test.ts`, `src/validation.ts`, any other importers

**Intent**: Update all `import { ... } from './review.js'` statements to point at the correct new modules.

**Contract**: Every import of a moved symbol points to its new file. No runtime behavior changes. Build and tests pass.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- All existing tests pass unchanged (modulo import path updates): `npm test`
- No circular dependencies: `npx madge --circular src/`
- Type checking passes: `npx tsc --noEmit`
- `review.ts` is under 200 LOC

#### Manual Verification:

- Run the action on a test PR and verify output is identical to pre-refactor

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 5: Structural Refactor — Decompose run()

### Overview

Reduce `run()` from 389 LOC to ~60 LOC by extracting named functions to module scope. This is a move-only refactor — no behavior changes.

### Changes Required:

#### 1. Hoist `runModelChainForBatch` to module scope

**File**: `src/index.ts`

**Intent**: Move the 100+ LOC nested function out of `run()` and make its captured variables explicit parameters.

**Contract**: New module-level function with signature:
```typescript
async function runModelChainForBatch(
  chain: TaggedModel[],
  clients: Record<Provider, OpenAIClient | null>,
  batch: FileBatch,
  systemMessage: string,
  responseFormat: ResponseFormat,
  config: Config,
): Promise<BatchResult>
```
The 6 previously-captured closure variables become explicit parameters.

#### 2. Extract `validateConfig`

**File**: `src/index.ts`

**Intent**: Move the SSRF validation block and provider key checks (lines ~30-47) into a named function.

**Contract**: `function validateConfig(config: Config): void` — throws on invalid URLs, logs provider availability info.

#### 3. Extract `buildClients`

**File**: `src/index.ts`

**Intent**: Move client instantiation (lines ~49-62) into a named function.

**Contract**: `function buildClients(config: Config): Record<Provider, OpenAIClient | null>` — creates NIM, Mistral, Groq, Custom clients based on available keys.

#### 4. Extract `detectLanguage`

**File**: `src/index.ts`

**Intent**: Move the language detection loop (lines ~153-163) into a named function.

**Contract**: `function detectLanguage(files: string[]): string | undefined` — returns the dominant language from file extensions using `languageForFile`.

#### 5. Extract `dispatchOutput`

**File**: `src/index.ts`

**Intent**: Move the 4-way output dispatch block (inline review vs summary comment, with/without findings) into a named function.

**Contract**: `async function dispatchOutput(...)` — handles rendering, posting, and cleanup based on review results and config. Encapsulates the logic currently at lines ~347-413.

### Success Criteria:

#### Automated Verification:

- Build passes: `npm run build`
- All existing tests pass: `npm test`
- `run()` function body is under 80 LOC
- Type checking passes: `npx tsc --noEmit`

#### Manual Verification:

- Run the action on a test PR and verify output is identical to pre-refactor

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- **Phase 1**: `escapeMarkdown` with `<`, `&`, `>`, and combined strings; `validateProviderUrl` with blocked/allowed hosts; `max_files` edge cases
- **Phase 2**: `cleanupPreviousOutput` failure recovery; Zod error summary sanitization; `resp.json()` SyntaxError handling; `promptMode` coercion; `revalidateFindings` parse failure and length mismatch; `f.issue` truncation
- **Phase 3**: Chain timeout behavior; `Retry-After` parsing and application; cap enforcement

### Integration Tests:

- No new integration test harness needed. The existing test pattern (real HTTP servers for client tests, pure function tests for logic) is sufficient.

### Manual Testing Steps:

1. Run the action on a test PR with a known-good model — verify normal output
2. Run with `custom_api_url: https://169.254.169.254` — verify rejection
3. Run with `max_files: -5` — verify warning and fallback to 100
4. Observe Actions logs — verify no API keys visible in error messages

## Performance Considerations

- Phase 3's aggregate timeout (120s) prevents worst-case hangs without affecting normal operation (most reviews complete in 10-30s)
- `Retry-After` compliance may increase individual retry waits but prevents wasted retries that would fail anyway
- Structural refactors (Phases 4-5) have zero runtime performance impact — they're compile-time reorganization

## References

- Research: `context/changes/improvements-research/research.md`
- Existing tests pattern: `src/review.test.ts`, `src/validation.test.ts`
- Current SSRF check: `src/index.ts:31-39`
- `escapeMarkdown`: `src/utils.ts:10`
- `withRetry`: `src/retry.ts:10`
- `revalidateFindings`: `src/validation.ts:53`
- `loadConfig`: `src/review.ts:41`
- `buildSystemMessage`: `src/prompts.ts:172`
- `run()`: `src/index.ts:26-414`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Security & Input Validation

#### Automated

- [x] 1.1 Build passes: `npm run build` — 5a0d70d
- [x] 1.2 All tests pass: `npm test` — 5a0d70d
- [x] 1.3 New unit test: `escapeMarkdown` escapes `<`, `>`, `&` correctly — 5a0d70d
- [x] 1.4 New unit test: `validateProviderUrl` blocks `169.254.169.254`, `metadata.google.internal`, allows `api.example.com` — 5a0d70d
- [x] 1.5 New unit test: `max_files` rejects `-5`, `0`, `5e3`; accepts `1`, `100`, `500` — 5a0d70d
- [x] 1.6 Type checking passes: `npx tsc --noEmit` — 5a0d70d

#### Manual

- [ ] 1.7 Confirm escaped markdown renders correctly in a GitHub comment

### Phase 2: Correctness & Robustness

#### Automated

- [x] 2.1 Build passes: `npm run build` — a8e775a
- [x] 2.2 All tests pass: `npm test` — a8e775a
- [x] 2.3 New unit test: `cleanupPreviousOutput` failure doesn't throw — a8e775a
- [x] 2.4 New unit test: Zod error summary contains no received values — a8e775a
- [x] 2.5 New unit test: `resp.json()` SyntaxError produces RetryableError with status 502 — a8e775a
- [x] 2.6 New unit test: invalid `promptMode` coerces to `'append'` — a8e775a
- [x] 2.7 New unit test: `revalidateFindings` with unparseable response returns all findings — a8e775a
- [x] 2.8 New unit test: `revalidateFindings` with short boolean array doesn't silently drop findings — a8e775a
- [x] 2.9 New unit test: `f.issue` longer than 200 chars is truncated in revalidation prompt — a8e775a
- [x] 2.10 Type checking passes: `npx tsc --noEmit` — a8e775a

#### Manual

- [ ] 2.11 Trigger action on a test PR, verify it completes even with intermittent API slowness

### Phase 3: Reliability

#### Automated

- [x] 3.1 Build passes: `npm run build` — b1aeb46
- [x] 3.2 All tests pass: `npm test` — b1aeb46
- [x] 3.3 New unit test: model chain times out after configured duration — b1aeb46
- [x] 3.4 New unit test: `withRetry` uses `retryAfterMs` when it exceeds computed backoff — b1aeb46
- [x] 3.5 New unit test: `Retry-After` header parsed correctly — b1aeb46
- [x] 3.6 New unit test: `retryAfterMs` capped at 60s — b1aeb46
- [x] 3.7 Type checking passes: `npx tsc --noEmit` — b1aeb46

#### Manual

- [ ] 3.8 Verify action completes within ~2 minutes even with unresponsive models

### Phase 4: Structural Refactor — Split review.ts

#### Automated

- [x] 4.1 Build passes: `npm run build` — d7a122f
- [x] 4.2 All existing tests pass: `npm test` — d7a122f
- [x] 4.3 No circular dependencies: `npx madge --circular src/` — d7a122f
- [x] 4.4 Type checking passes: `npx tsc --noEmit` — d7a122f
- [x] 4.5 `review.ts` is under 200 LOC — d7a122f

#### Manual

- [ ] 4.6 Run action on a test PR, verify output identical to pre-refactor

### Phase 5: Structural Refactor — Decompose run()

#### Automated

- [x] 5.1 Build passes: `npm run build` — 4c98f7a
- [x] 5.2 All existing tests pass: `npm test` — 4c98f7a
- [x] 5.3 `run()` function body is under 80 LOC — 4c98f7a
- [x] 5.4 Type checking passes: `npx tsc --noEmit` — 4c98f7a

#### Manual

- [ ] 5.5 Run action on a test PR, verify output identical to pre-refactor
