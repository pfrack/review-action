<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: SWE Score Resolver — auto-map 0.5 models to real scores

- **Plan**: context/changes/swe-score-resolver/plan.md
- **Scope**: Phase 1 of 3
- **Date**: 2026-07-28
- **Verdict**: APPROVED
- **Findings**: 1 critical, 3 warnings, 3 observations (all fixed)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — eval() to parse SWE_BENCH_SCORES table

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/swe-resolver.ts:126
- **Detail**: Uses `eval('(' + scoresMatch[1] + ')')` to parse a TypeScript object literal from the source file. While the file is repo-controlled today, any compromise (malicious PR, supply-chain attack) yields arbitrary code execution. `eval` also breaks static analysis.
- **Fix**: Replace with a JSON-safe parser. Convert the object literal to valid JSON (quote keys, strip trailing commas) then use `JSON.parse`, or use `json5` library.
  - Strength: Eliminates the injection class entirely; the matched text is a simple `key: value` object that converts to JSON trivially.
  - Tradeoff: Minimal — a few-line conversion helper.
  - Confidence: HIGH — identical pattern used in `bench-reorder.ts` `readFetchedScores`.
  - Blind spot: None significant.
- **Decision**: FIXED — replaced eval() with parseScoresLiteral helper

### F2 — LLM fallback stubbed out

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence
- **Location**: src/swe-resolver.ts:59,79
- **Detail**: Plan requires "enhanced deterministic match → LLM fallback for each". The `resolveScores` signature types `llmClient?: undefined` and the body silences `options.matcherModel` with `void`. No LLM fallback exists. Models that need LLM disambiguation will stay at 0.5 permanently.
- **Fix A ⭐ Recommended**: Remove the dead parameter for now; add a `--no-llm` flag that's the default
  - Strength: Honest API surface; no false promise of LLM matching. The existing `matchModelScore` in bench-entry.ts can be extracted later.
  - Tradeoff: Some models stay at 0.5 that could have been resolved via LLM.
  - Confidence: HIGH — the deterministic match already handles the 2 models that exist on the leaderboard.
  - Blind spot: Haven't verified whether the LLM path was critical for the 11 unresolved models.
- **Fix B**: Implement the LLM fallback properly using the existing `matchModelScore` logic
  - Strength: Matches plan intent fully.
  - Tradeoff: Adds API cost, requires NIM API key, complexity.
  - Confidence: MEDIUM — the existing LLM prompt logic would need extraction/refactor.
  - Blind spot: LLM may hallucinate scores for models not on leaderboard.
- **Decision**: FIXED — removed dead parameter; resolveScores now takes 2 args

### F3 — patchScoresTable and deterministicMatch duplicated

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: src/swe-resolver.ts:38-54, 83-107
- **Detail**: `patchScoresTable` is copy-pasted identically from `bench-reorder.ts:522-547`. `deterministicMatch` is a simplified copy of `bench-entry.ts:89-125` (missing substring strategy). Already diverging — the resolver's matcher is less capable than the benchmark's.
- **Fix**: Import `patchScoresTable` from `bench-reorder.ts` instead of duplicating. For `deterministicMatch`, either import from `bench-entry.ts` or extract both to a shared `src/model-match.ts`.
  - Strength: Single source of truth; future bug fixes propagate automatically.
  - Tradeoff: Adds an import dependency from the resolver to upstream modules.
  - Confidence: HIGH — both functions are pure and easy to extract.
  - Blind spot: None significant.
- **Decision**: FIXED — imported patchScoresTable from bench-reorder.ts and deterministicMatch from bench-reorder.ts

### F4 — Score filter drops valid low-scoring models

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/swe-resolver.ts:31
- **Detail**: `fetchLeaderboard` filters `m.score > 0.5`, silently dropping models scored between 0.5 and the threshold. The plan says "fetch latest leaderboard" with no filtering. A model like `nemotron-3-nano-30b-a3b` (score=0.388) would be excluded, but a free-tier variant at 0.51 would also be excluded despite being a valid match target.
- **Fix**: Remove the `score > 0.5` filter (or lower to `score > 0`).
  - Strength: Captures all leaderboard entries; matches plan intent.
  - Tradeoff: None significant — the leaderboard only has 104 models.
  - Confidence: HIGH — the API returns all scored models.
  - Blind spot: None significant.
- **Decision**: FIXED — removed score > 0.5 filter; now validates API response (typeof m.score === 'number')

### F5 — Fragile marker selection heuristic

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/swe-resolver.ts:85-87
- **Detail**: Marker comment is chosen by checking if any entry model starts with `kilo-auto/`. This heuristic is brittle — a new provider or coincidental name collision silently picks the wrong section.
- **Fix**: Accept marker as CLI parameter or detect by section header pattern.
- **Decision**: FIXED — added --section flag to resolver; patchScoresTable accepts explicit section

### F6 — Dead matcherModel parameter

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/swe-resolver.ts:59
- **Detail**: `options.matcherModel` is accepted but silenced with `void`. Misleading to callers.
- **Fix**: Remove the parameter until LLM fallback is implemented.
- **Decision**: FIXED — removed as part of F2

### F7 — API response not validated

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/swe-resolver.ts:33-35
- **Detail**: `fetchLeaderboard` casts the API response without validating `m.model_id` and `m.score`. A malformed entry produces `undefined` in the score field.
- **Fix**: Add `if (typeof m.score !== 'number' || !m.model_id) continue;`.
- **Decision**: FIXE|F4 — also validates API response
