<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Add Groq Provider + Bench Ranking Visibility

- **Plan**: context/changes/mistral-hallucination-bench-visibility/plan.md
- **Scope**: Phase 1 + Phase 2 (all automated items completed; manual items pending)
- **Date**: 2026-07-24
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Provider error-label convention broken for Groq

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/openai-client.ts:125-127
- **Detail**: The error-message provider detection uses `nvidia.com` and `mistral` string checks, then falls back to `baseURL.split('/')[2]`. For Groq's `api.groq.com`, this falls through to `'api.groq.com'` in error messages (e.g. "api.groq.com returned 500: ...") instead of a proper "Groq" label, breaking the established pattern where NIM shows "NIM" and Mistral shows "Mistral".
- **Fix**: Add `baseURL.includes('groq') ? 'Groq'` branch to the provider detection ternary.
  - Strength: Matches the pattern established for NIM and Mistral providers; improves error clarity.
  - Tradeoff: Minor — one additional branch in a ternary.
  - Confidence: HIGH — identical pattern used for existing providers.
  - Blind spot: None significant.
- **Decision**: FIXED via Fix — Added `baseURL.includes('groq') ? 'Groq'` branch to openai-client.ts:125-127

### F2 — GITHUB_STEP_SUMMARY writing extends beyond planned Groq scope

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: src/bench-reorder.ts:397-400
- **Detail**: The `appendFileSync` to `GITHUB_STEP_SUMMARY` is unconditional on target — any benchmark job where the env var is set (NIM, Mistral, or Groq) will now write a ranking table. The Phase 2 plan scoped this feature to the Groq benchmark specifically; NIM and Mistral daily benchmark runs will now also produce step summary output, which is a scope extension beyond what was explicitly planned.
- **Fix A ⭐ Recommended**: Accept the broader scope as intentional — it aligns with the Desired End State ("Daily bench writes a ranked model table to GITHUB_STEP_SUMMARY") and is a positive feature extension that benefits all providers.
  - Strength: Preserves the implemented work; matches the stated end-state goal; benefits NIM and Mistral benchmark visibility too.
  - Tradeoff: Existing NIM ceremony in GITHUB_STEP_SUMMARY changes output format; stakeholders who scoped P2 to Groq-only weren't notified.
  - Confidence: HIGH — the Desired End State explicitly calls for all-daily-bench visibility.
  - Blind spot: Need to verify existing NIM/Mistral benchmark runs don't break with the new summary content.
- **Fix B**: Scope the write to groq_models target only — add `target === 'groq_models'` condition around the appendFileSync block.
  - Strength: Keeps Phase 2 scope strictly bounded; preserves existing NIM/Mistral behavior unchanged.
  - Tradeoff: Delays the broader visibility improvement; would need a follow-up plan to extend to NIM/Mistral separately.
  - Confidence: MEDIUM — requires a separate change later.
  - Blind spot: Haven't checked if any pipeline consumers parse the step summary and would be affected by three ranking tables instead of one.
- **Decision**: ACCEPTED — Broader scope aligns with Desired End State ("Daily bench writes ranked model table to GITHUB_STEP_SUMMARY")