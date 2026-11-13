<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Code Improvements — improvements-research

- **Plan**: context/changes/improvements-research/plan.md
- **Scope**: All phases (1–5) — all automated checks marked [x]
- **Date**: 2026-07-25
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Backtick fence in lastRawContent broken by LLM output

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/index.ts:347

- **Detail**: When `promptMode === 'replace'` and all models fail schema validation, the LLM's raw output is posted in a triple-backtick code fence. If `lastRawContent` contains a line of exactly three backticks (`` ``` ``), the fence closes prematurely and the rest is rendered as raw markdown — enabling HTML injection, link injection, or emphasis manipulation via GitHub's markdown renderer. This was research finding D6, never addressed in the plan.

- **Fix A ⭐ Recommended**: Use a 5-backtick fence instead of triple-backticks
  - Strength: 5-backtick fences are practically impossible to break with standard LLM output; requires a line of exactly 5 consecutive backticks which is extremely unlikely.
  - Tradeoff: Slightly different visual rendering in GitHub comments (5-backtick fence is less common but valid).
  - Confidence: HIGH — simplest fix, well-understood markdown pattern.
  - Blind spot: Test the rendering visually in a GitHub comment to confirm it works.

- **Fix B**: Sanitize `lastRawContent` through `escapeMarkdown()` before embedding
  - Strength: Defensive — prevents any markdown injection vector regardless of fence length.
  - Tradeoff: Escaping LLM output makes it harder to read raw model responses (backticks, stars, etc. become literal).
  - Confidence: MEDIUM — effective but degrades the user's ability to read raw LLM output.
  - Blind spot: escapeMarkdown already handles `<` and `&`, but markdown has many other injection vectors (headers, links, images via `![text](url)`).

- **Decision**: FIXED via Fix A — replaced triple-backticks with 5-backticks at src/index.ts:347

### F2 — IPv4-mapped IPv6 addresses bypass SSRF host blocklist

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence + Safety & Quality
- **Location**: src/utils.ts:15-38

- **Detail**: `validateProviderUrl` blocks IPv4 link-local (`169.254.0.0/16`) but does not detect IPv4-mapped IPv6 addresses like `::ffff:169.254.169.254`. A user could configure `nim_base_url: https://::ffff:169.254.169.254/` and the action would POST the diff + Authorization header to the AWS metadata endpoint, exfiltrating instance credentials. Additionally, the plan contract specified blocking `fe80::/10` (IPv6 link-local), but the implementation only covers `fe80::/16` via `hostname.startsWith('fe80:')`.

- **Fix**: Add IPv4-mapped IPv6 check and extend IPv6 link-local coverage
  - Add: `if (hostname.startsWith('::ffff:') && hostname.slice(7).split('.').slice(0,2).every((_, i, arr) => i < 2 ? arr[i] === ['169','254'][i] : true))` or simpler regex for `::ffff:169.254.*`
  - Extend: Replace `hostname.startsWith('fe80:')` with proper `/10` range check (cover `fe80::` through `febf::`).
  - Strength: Closes the bypass path and matches the original plan contract.
  - Tradeoff: String-based IP range checking is fragile; would benefit from a proper CIDR library.
  - Confidence: MEDIUM — regex approach works for well-known addresses but is not a general CIDR solution.
  - Blind spot: RFC1918 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) are intentionally allowed per the plan for self-hosted runner flexibility; we should verify no internal-namespace bypass exists.

- **Decision**: FIXED — added IPv4-mapped IPv6 check and extended fe80::/10 to fe80::/febf:: in validateProviderUrl at src/utils.ts:30-45

### F3 — Response bodies in RetryableError messages may leak provider data

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/openai-client.ts:141, src/openai-client.ts:203, src/github-review.ts:96,174,273, src/review.ts:148

- **Detail**: Six call sites embed full HTTP response bodies in `RetryableError` messages, which get logged via `core.info()` at catch sites. `core.setSecret()` masks API keys, but response bodies can contain provider error details, stack traces, request echo fragments, or provider-internal identifiers. This risks leaking information that could aid an attacker in understanding the action's internal structure or provider configuration.

- **Fix A ⭐ Recommended**: Truncate response bodies in RetryableError messages
  - Strength: Prevents information leakage while preserving enough context for debugging. Simple: truncate body to 200 chars at throw site.
  - Strength: Matches the pattern already used for LLM output truncation (`result.content.length > 500 ? '...' + result.content.slice(-500)` at index.ts:104-105).
  - Tradeoff: Debugging becomes slightly harder if you need the full error body, but truncated output is usually sufficient.
  - Confidence: HIGH — same truncation pattern already used elsewhere in this codebase.
  - Blind spot: None significant.

- **Fix B**: Remove body from error message entirely, log body separately if needed
  - Strength: Eliminates the leak class completely (even truncated bodies could contain structured secrets).
  - Tradeoff: Loses visibility into provider error details in action logs entirely.
  - Confidence: MEDIUM — simpler but reduces debuggability.
  - Blind spot: May miss useful provider error details for troubleshooting.
- **Decision**: FIXED via Fix A — truncated response bodies to 200 chars at 6 RetryableError call sites
- **Decision**: PENDING

### F4 — chatStream ReadableStreamDefaultReader never released on early return

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/openai-client.ts:208, src/openai-client.ts:226

- **Detail**: `resp.body!.getReader()` is called at line 208, but the early `return` at line 226 (when streaming hits `[DONE]`) exits the generator without `reader.releaseLock()`. While this only affects the `bench.ts` streaming path (not the main review path), it leaves the readable stream in a locked state if iteration is broken early. The non-null assertion `resp.body!` was already flagged in the nodejs-rewrite review as remaining unfixed.

- **Decision**: FIXED — wrapped reader lifecycle in try/finally, releaseLock on all exit paths at src/openai-client.ts:213-252
  - Add `reader.releaseLock()` before the early `return` at line 226.
  - Wrap reader lifecycle in try/finally for guaranteed cleanup on all paths.

- **Decision**: PENDING

### F5 — Replace prompt mode strips all semantic guidance from the model

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: src/prompts.ts:222-228, src/config.ts:29-33

- **Detail**: When `promptMode === 'replace'` with a custom system prompt, `buildSystemMessage` returns only the custom text, stripping `SEVERITY_GUIDANCE`, `JSON_SCHEMA_DEFINITION`, anti-patterns list, and language-specific focus areas. The `response_format: json_schema` coerces the output shape, but the model has zero understanding of severity meaning, "not applicable" semantics, or rejection criteria. Output is structurally valid but semantically arbitrary. This was research finding Q5, explicitly deferred in the plan.

- **Fix**: Inject minimal framework context even in 'replace' mode
  - Append `SEVERITY_GUIDANCE` and the JSON schema definition to custom prompts in 'replace' mode.
  - Strength: Preserves the user's intent (custom prompt) while ensuring the model has enough context for correct severity classification.
- **Decision**: FIXED — appended SEVERITY_GUIDANCE and JSON_SCHEMA_DEFINITION to custom prompts in 'replace' mode at src/prompts.ts:224-227
  - Confidence: MEDIUM — exact framing needs UX discussion.
  - Blind spot: Combined prompt must not exceed context window limits for smallest models.

- **Decision**: PENDING

### F6 — Inconsistent server.unref() across test mocks

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/openai-client.test.ts:11, src/index.test.ts:14, src/validation.test.ts:99

- **Decision**: FIXED — added server.unref() to openai-client.test.ts:10, matching pattern in other test files

- **Fix**: Add `server.unref()` to index.test.ts and validation.test.ts

- **Decision**: PENDING

### F7 — Dead bracket checks in validateProviderUrl

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/utils.ts:31, src/utils.ts:36

- **Decision**: FIXED — already addressed by F2 fix (bracket variants removed as dead code)

- **Fix**: Remove the bracket variants or add a comment explaining URL.hostname strips brackets

- **Decision**: PENDING

### F8 — Duplicate startMockServer utility across test files

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/openai-client.test.ts:7-16, src/index.test.ts:10-19, src/validation.test.ts:96-106

- **Decision**: FIXED — extracted startMockServer to src/test-utils.ts, updated imports in 3 test files

- **Fix**: Extract startMockServer to a shared test utility file (src/test-utils.ts)

- **Decision**: PENDING
