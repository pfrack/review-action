<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Schema-Validated Review Implementation Plan

- **Plan**: context/changes/schema-validated-review/plan.md
- **Scope**: Phase 1–4 (full plan review)
- **Date**: 2026-07-20
- **Verdict**: NEEDS ATTENTION → RESOLVED
- **Findings**: 1 critical, 2 warnings, 5 observations — all fixed

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS ✅ |
| Scope Discipline | PASS ✅ |
| Safety & Quality | PASS ✅ (all fixed) |
| Architecture | PASS ✅ |
| Pattern Consistency | PASS ✅ |
| Success Criteria | PASS ✅ |

## Findings

### F1 — Zod error message interpolated unsanitized into retry prompt

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/index.ts:163
- **Detail**: When schema validation fails, `parsed.error.message` is concatenated directly into the retry prompt as a user message. Zod error messages include raw input data in nested paths (e.g., `.findings[0].severity — Received: "malicious payload"`). This creates a server-to-server prompt injection vector — a crafted diff that produces a Zod error with injection payloads could influence the retry LLM call.
- **Fix**: Truncate or sanitize `parsed.error.message` before interpolation. Use a simpler string like `parsed.error.issues.length + " validation errors occurred"`.
  - Strength: Eliminates the injection class entirely with a one-line change.
  - Tradeoff: Loses detailed error info in retry messages (but this info is for the LLM, not a human debugger).
  - Confidence: HIGH — the fix is straightforward and the risk is concrete.
  - Blind spot: None significant.
- **Decision**: FIXED — replaced with `parsed.error.issues.length + " validation error(s) occurred"`

### F2 — withRetry skips network errors (TypeError from fetch)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/retry.ts:10-25
- **Detail**: `withRetry` only retries `RetryableError` with status >=500 or ===429. Network errors from `fetch()` (DNS failure, socket timeout, connection refused) throw `TypeError`, not `RetryableError`, so they fail immediately on the first attempt. This means transient network issues that the existing chain fallback would previously survive now cause hard failures on the first model.
- **Fix**: Wrap network errors in `RetryableError` with status 500, or adjust the retry predicate to also catch `TypeError`.
  - Strength: Makes the retry wrapper robust against the most common transient failures.
  - Tradeoff: Slightly widens what gets retried — but network errors are inherently transient.
  - Confidence: HIGH — the gap is clear and the fix is mechanical.
  - Blind spot: Haven't verified whether the model-chain fallback already handles this at a higher level.
- **Decision**: FIXED — added `isNetworkError` check for `TypeError` in retry predicate

### F3 — Raw model output posted to GitHub without sanitization

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/index.ts:204-205
- **Detail**: When `promptMode === 'replace'` and all models fail schema validation, `lastRawContent` is embedded directly into the GitHub PR comment markdown. A malicious diff could cause the LLM to output `@mention` directives, embedded links, or other GFM constructs that trigger notifications or mislead reviewers.
- **Fix**: Wrap the raw output in a fenced code block (`\`\`\`\n...\n\`\`\``) to neutralize GFM rendering.
  - Strength: One-line change, no functional impact on legitimate output.
  - Tradeoff: Raw output becomes slightly less readable in the comment (but it's already a fallback path).
  - Confidence: HIGH — standard mitigation for untrusted content in Markdown.
  - Blind spot: None significant.
- **Decision**: FIXED — wrapped raw output in fenced code block

### F4 — Tool call argument extraction silently falls back to raw string

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/nim-client.ts:133-139
- **Detail**: If `JSON.parse(args)` fails when extracting tool call arguments, the code falls back to the raw string with no logging. Downstream `safeParse` will handle it, but the silent path makes debugging harder.
- **Fix**: Add `core.info()` or debug log when falling back to raw args string.
- **Decision**: FIXED — added `core.info()` with char count on fallback

### F5 — chatStream has no retry on HTTP errors

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/nim-client.ts:161-169
- **Detail**: Unlike `chat()` which wraps fetch in `withRetry`, `chatStream()` makes a direct fetch without retry. A transient 500 during streaming fails the entire stream.
- **Fix**: Wrap the initial fetch in `withRetry`, or document streaming as intentionally fail-fast.
- **Decision**: FIXED — wrapped fetch in `withRetry` with `RetryableError` for HTTP errors

### F6 — fetchDiff downloads full diff without size guard

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:178-198
- **Detail**: For very large PRs, the GitHub API diff can be multi-MB. No size check or abort threshold exists. (This was already flagged as a WARNING in the nodejs-rewrite review — see plan.md line 30.)
- **Fix**: Check `Content-Length` or response size and abort with a clear message if the diff exceeds a threshold.
- **Decision**: FIXED — added 5 MB size guard (pre-flight Content-Length + post-download check)

### F7 — resolveSystemPrompt with language-specific prompts exists but is bypassed

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/index.ts:134, src/review.ts:304
- **Detail**: `resolveSystemPrompt` with language-specific prompt selection exists in `review.ts:304`, but `index.ts:134` uses `config.systemPrompt || BASE_SYSTEM_PROMPT` directly, bypassing language detection. The `prompts.ts` module's `languageForTemplate` is imported but only used inside `resolveSystemPrompt`, which itself is never called from the main flow.
- **Fix**: Either wire `resolveSystemPrompt` into the chat call or remove the dead code path.
- **Decision**: FIXED — removed `resolveSystemPrompt`, `languageForTemplate`, and their tests (dead code in combined-diff architecture)

### F8 — z.toJSONSchema() may include draft metadata

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/review-schema.ts:20
- **Detail**: `z.toJSONSchema()` may include draft metadata that some LLM providers reject in `response_format`. Depending on Zod version, this could cause silent failures with NIM/Mistral.
- **Fix**: Verify the generated schema matches provider expectations. Test with actual providers.
- **Decision**: FIXED — replaced `z.toJSONSchema()` with hand-written schema (no `$schema` draft metadata, uses `type: ["string", "null"]` instead of `anyOf`)

---

## Plan Adherence Detail

Three low-severity structural drifts were found — all functionally equivalent:

1. **src/review-schema.ts**: Fields use `.nullable().optional()` instead of plan's `.nullable()` — more permissive, allows `undefined` in addition to `null`. Arguably better for LLM output tolerance.
2. **src/nim-client.ts**: `schema`/`format` are flat on `ChatOptions` instead of nested under `structuredSchema` — cleaner design, same intent.
3. **src/review.ts**: `renderReview()` lacks `opts` param; `### AI Code Review` header assembled in `index.ts` instead — functionally identical.

---

## Automated Verification

| Check | Result |
|-------|--------|
| `npm run build` succeeds with zod bundled | ✅ PASS |
| `npm test` — all tests pass | ✅ PASS (119/119) |
| `npx tsc --noEmit` — no type errors | ✅ PASS |
| All existing tests continue to pass | ✅ PASS |
| `safeParse` rejects empty-string and non-JSON | ✅ PASS (fixtures: malformed-not-json, malformed-wrong-schema, truncated-json) |
| `safeParse` accepts all-strict-minimal and all-fields | ✅ PASS (fixtures: valid-complete, valid-minimal, valid-empty) |
| `validateFindings` drops/keeps as specified | ✅ PASS (6 test cases) |
| `renderReview` produces correct markdown | ✅ PASS (8 test cases) |
