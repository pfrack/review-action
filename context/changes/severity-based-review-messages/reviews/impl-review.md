<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Severity-Based Review Messages

- **Plan**: context/changes/severity-based-review-messages/plan.md
- **Scope**: Phase 1-4 of 4 (full plan review)
- **Date**: 2026-07-21
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 3 observations

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

### F1 — Duplicated severity guidance across modules

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/review.ts:8-20 vs src/prompts.ts:4-16
- **Detail**: `BASE_SYSTEM_PROMPT` inlines the severity guidance text. `SEVERITY_GUIDANCE` in `src/prompts.ts` defines the identical string. If one is updated independently, prompts diverge silently. The two copies must be kept manually in sync.
- **Fix**: Import `SEVERITY_GUIDANCE` from `prompts.ts` into `review.ts` and interpolate it into `BASE_SYSTEM_PROMPT` (e.g. `` `...${SEVERITY_GUIDANCE}\n\n${JSON_SCHEMA_DEFINITION}` ``). The content tests in `prompts.test.ts` already verify `BASE_SYSTEM_PROMPT` carries the required substrings, so they'll continue to pass.
- **Decision**: FIXED — imported SEVERITY_GUIDANCE from prompts.ts into review.ts, eliminating the duplicate

### F2 — globMatch regex escape list is incomplete

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:210-211
- **Detail**: `globMatch` escapes only `[.+^${}()|[\]\\]` before converting `*` and `?` to regex. Characters like `!`, `=`, `<`, `>`, `:` are not escaped. If a user-provided `exclude_patterns` input contains these, they'll be interpreted as regex syntax. This is a pre-existing issue unrelated to this change.
- **Fix**: Replace the hand-rolled escape list with a comprehensive regex escape (e.g. `pattern.replace(/[-\/\\^$+?.()|[\]{}]/g, '\\$&')`). Pre-existing — separate from this change.
- **Decision**: FIXED — updated regex escape to cover all metacharacters including !, =, <, >, :

### F3 — Unescaped markdown in free-text fields

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:191-196
- **Detail**: `renderReview` interpolates `f.issue`, `f.suggestion`, and action fields directly into markdown without escaping. Model-returned text containing markdown characters will render as formatted markdown in the PR comment. Pre-existing — not introduced by this change.
- **Fix**: Low priority. Consider wrapping free-text fields in inline code or escaping markdown special characters if the cosmetic issue becomes noticeable.
- **Decision**: FIXED — added escapeMarkdown() helper, applied to issue, suggestion, action, and summary fields

### F4 — fetchDiff uses raw.length for byte-size check

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:252
- **Detail**: `raw.length` counts UTF-16 code units, not bytes. For ASCII diffs this is equivalent, but for multi-byte UTF-8 characters (CJK, emoji), it underestimates. The 5 MB threshold makes the difference negligible in practice. Pre-existing.
- **Fix**: Use `new TextEncoder().encode(raw).byteLength` for an exact count, or document the approximation. Pre-existing — separate from this change.
- **Decision**: FIXED — replaced raw.length with TextEncoder().encode(raw).byteLength

### F5 — loadConfig doesn't validate promptMode value

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/review.ts:59
- **Detail**: `promptMode` is read from input with default `'append'` but never validated against `('append' | 'replace')`. A typo (e.g. `"apend"`) silently falls through to the append path. Safe but produces no warning. Pre-existing.
- **Fix**: Optionally validate in `loadConfig()` and call `core.warning()` if the value isn't `'append'` or `'replace'`. Pre-existing — separate from this change.
- **Decision**: FIXED — added validation in loadConfig() with core.warning() for invalid values
