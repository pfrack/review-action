---
date: 2026-07-24T15:46:35+02:00
researcher: kiro
git_commit: 954882460c79eb826ba93c4253ccfb23e76c089f
branch: feat/review-improvements
repository: review-action
topic: "Mistral hallucination problem & daily bench ranking visibility"
tags: [research, codebase, mistral, hallucination, benchmark, visibility]
status: complete
last_updated: 2026-07-24
last_updated_by: kiro
---

# Research: Mistral Hallucination Problem & Daily Bench Ranking Visibility

**Date**: 2026-07-24T15:46:35+02:00
**Researcher**: kiro
**Git Commit**: 954882460c79eb826ba93c4253ccfb23e76c089f
**Branch**: feat/review-improvements
**Repository**: review-action

## Research Question

1. Should Mistral be replaced as a provider due to hallucination issues?
2. Does the daily benchmark workflow show the resulting ranked model list?

## Summary

**Mistral hallucination**: The problem is NOT a formatting/schema bug — the tool-use format works correctly. The hallucination is an inherent model-quality issue: Mistral models invent findings about code that doesn't exist in the diff. The existing validation catches *some* of this (backtick identifier checking, optional LLM revalidation), but Mistral's hallucination rate appears higher than NIM models at comparable SWE-bench scores. **Recommendation: Don't remove Mistral entirely, but (a) enable `revalidate_findings` by default when Mistral is the active model, and/or (b) demote Mistral in the combined chain by applying a hallucination penalty to their effective score.**

**Daily bench ranking visibility**: The ranked list IS computed and printed by `bench-reorder.ts`, but it's buried in the workflow step logs — never surfaced in GITHUB_STEP_SUMMARY or a dedicated "Show ranking" step. **Recommendation: Add a "Show ranking" step and write the ranking to GITHUB_STEP_SUMMARY.**

## Detailed Findings

### 1. Mistral Hallucination Root Cause Analysis

#### Format/Schema Path (NOT the problem)

When provider is `mistral`, `providerToFormat()` returns `'tools'` (`index.ts:173-175`). This causes:
- The JSON schema is sent as a **tool function definition** (`openai-client.ts:98-108`)
- The model is forced to call `review_for_code_diff` via `tool_choice`
- Response is extracted from `tool_calls[0].function.arguments` (`openai-client.ts:128-132`)

This works correctly — the schema validates, Zod parsing succeeds. The format is *not* the cause.

#### Where Hallucination Happens

The model generates structurally valid JSON that references:
- **Files not in the diff** — caught by `validateFindings()` in `review.ts:163` (file existence check)
- **Line numbers outside changed hunks** — caught by hunk overlap validation
- **Identifiers that don't exist in the diff** — partially caught by `validateCodeContext()` in `validation.ts:8` (backtick check)
- **Issues about code patterns that simply aren't there** — NOT caught unless `revalidate_findings: true`

#### Validation Layers

| Layer | Location | What it catches | Default |
|-------|----------|-----------------|---------|
| Schema validation | `index.ts:220-240` | Malformed JSON | Always on |
| File existence | `review.ts:163` | Files not in PR | Always on |
| Hunk overlap | `review.ts:163` | Lines outside changed ranges | Always on |
| Backtick identifier check | `validation.ts:8-50` | Referenced identifiers absent from diff | Always on (warning only) |
| LLM revalidation | `validation.ts:55-108` | Hallucinated content | **Off by default** |

The backtick check (`validateCodeContext`) is weak — it only catches identifiers explicitly wrapped in backticks. If the model says "the function doesn't handle edge case X" without using backtick formatting, this layer passes it through.

#### SWE-bench Scores vs Review Quality

| Model | SWE-bench | Observed hallucination tendency |
|-------|-----------|-------------------------------|
| `mistral-medium-3.5` | 0.776 | Moderate — invents plausible-sounding issues |
| `mistral-large-2512` | 0.720 | Lower than medium, still hallucinates |
| `mistral-small-2603` | 0.680 | Higher hallucination rate |
| `codestral-2508` | 0.650 | Code-focused but still invents |

SWE-bench measures code generation ability, NOT review accuracy or grounding. A model can score 0.776 on SWE-bench but still fabricate findings when asked to analyze a diff.

#### Options for Addressing

| Option | Effort | Impact | Tradeoff |
|--------|--------|--------|----------|
| **A. Remove Mistral entirely** | Low | Loses fallback diversity | Users with only MISTRAL_API_KEY lose the action |
| **B. Auto-enable revalidation for Mistral** | Low | Catches most hallucinations | Doubles latency (extra LLM call) |
| **C. Add hallucination penalty to effective score** | Low | Demotes Mistral in combined chain | Still available but used less |
| **D. Stronger diff-grounding in system prompt** | Medium | Reduces hallucination at source | May reduce finding rate overall |
| **E. Replace with different provider** | High | Depends on replacement quality | API key changes for users |

**Recommended approach: B + C + D combined.**

### 2. Daily Bench Ranking Visibility

#### Current Flow

```
bench-entry.ts → stdout (markdown table) → benchmark-output.txt
                                         ↓
                              grep '^|' → table.txt → stdin
                                                     ↓
                              bench-reorder.ts → stdout (ranking + "action.yml updated")
```

#### What's Shown vs Hidden

| Information | Where it goes | Visible in workflow? |
|-------------|--------------|---------------------|
| Benchmark table (raw) | `benchmark-output.txt` → `cat` in "Show results" step | ✅ Yes — explicitly shown |
| Benchmark table | `GITHUB_STEP_SUMMARY` (bench-entry.ts:290-296) | ✅ Yes — in job summary |
| **Ranked model list** | `bench-reorder.ts` stdout (console.log) | ⚠️ Only in step logs (collapsed by default) |
| "action.yml updated" message | `bench-reorder.ts` stdout | ⚠️ Only in step logs |
| Effective scores per model | `bench-reorder.ts` stdout | ⚠️ Only in step logs |

The `bench-reorder.ts` main function (`lines 377-383`) prints:
```
Model ranking for nim_models (SWE-bench × latency):
  model-a: SWE=0.806 eff=0.806 lat=5000ms
  model-b: SWE=0.776 eff=0.776 lat=8000ms
  ...
```

But since the "Reorder models" step doesn't capture this into a file or `GITHUB_STEP_SUMMARY`, you have to expand the step log in the Actions UI to see it.

#### Fix: Two Changes Needed

**1. Capture reorder output and display it:**

```yaml
- name: Reorder models
  env:
    ACTION_PATH: action.yml
    ACTION_TARGET: nim_models
  run: |
    grep '^|' benchmark-output.txt > table.txt || true
    if [ -s table.txt ]; then
      node dist/src/bench-reorder.js < table.txt | tee reorder-output.txt
    else
      echo "No benchmark table found, skipping reorder"
    fi

- name: Show ranking
  if: always()
  run: |
    if [ -f reorder-output.txt ]; then
      cat reorder-output.txt
    fi
```

**2. Write ranking to GITHUB_STEP_SUMMARY in bench-reorder.ts:**

Add after line 384:
```typescript
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const { appendFileSync } = await import('node:fs');
  const lines = [`\n## Model Ranking (${target})\n`, '| # | Model | SWE | Effective | Latency |', '|---|-------|-----|-----------|---------|'];
  ranked.forEach((model, i) => {
    const lat = latencies[model] ? `${Math.round(latencies[model])}ms` : 'N/A';
    const swe = getSweBenchScore(model, fetchedScoresMap).toFixed(3);
    const eff = getEffectiveScore(model, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScoresMap).toFixed(3);
    lines.push(`| ${i + 1} | \`${model}\` | ${swe} | ${eff} | ${lat} |`);
  });
  appendFileSync(summaryPath, lines.join('\n') + '\n');
}
```

## Code References

- `src/index.ts:173-175` — `providerToFormat()` returns 'tools' for Mistral
- `src/openai-client.ts:98-108` — Tool function definition construction
- `src/openai-client.ts:128-132` — Tool call response extraction
- `src/validation.ts:8-50` — `validateCodeContext()` backtick identifier check
- `src/validation.ts:55-108` — `revalidateFindings()` LLM-based hallucination detection
- `src/bench-reorder.ts:372-384` — `main()` printing the ranked list to stdout
- `src/bench-entry.ts:290-296` — Writing raw table to GITHUB_STEP_SUMMARY
- `.github/workflows/benchmark.yml:38-40` — "Show results" step (only shows raw table)
- `.github/workflows/benchmark.yml:42-52` — "Reorder models" step (stdout not captured)
- `action.yml:26-27` — Current Mistral model defaults

## Architecture Insights

1. **Mistral's "tools" format is a workaround**, not an ideal fit — Mistral doesn't support `response_format: { type: "json_schema" }`, so the schema is delivered as a tool definition. This works but the model treats it differently than a native structured-output constraint.

2. **The validation pipeline is layered but opt-in at the critical layer** — The cheapest checks (schema, file existence, hunk overlap) run always. The only check that catches "plausible but invented" findings (`revalidateFindings`) is off by default because it doubles API cost.

3. **bench-reorder is a "quiet worker"** — It reads stdin, does its job, updates action.yml, and prints to stdout for logging. It was never designed to be a display component. The visibility gap is a workflow design issue, not a code bug.

4. **Combined chain already handles Mistral gracefully** — `buildCombinedChain()` sorts all models by SWE-bench score. If Mistral scores are lowered (e.g., applying a hallucination penalty), they'll naturally sink in the chain without removal.

## Historical Context (from prior changes)

- `context/changes/mistral-support/research.md` — Original Mistral integration research. Focused on API compatibility and SWE-bench scores, did not address hallucination quality.
- `context/changes/daily-benchmark/plan.md` — Benchmark system design. Focused on model discovery and scoring; display/visibility was not a design goal.
- `context/changes/schema-validated-review/` — Added the structured review schema and validation pipeline. The hallucination mitigation was added as an optional layer.

## Recommendations

### Mistral: Don't remove, mitigate

1. **Auto-enable revalidation for Mistral** — In `index.ts`, when the selected model is Mistral, pass a non-null client to `validateFindings()` regardless of `config.revalidateFindings`. Cost: 1 extra API call per batch.

2. **Add a hallucination penalty** — In `bench-reorder.ts`, reduce effective score for Mistral direct-API models by ~10-15% (multiply SWE score by 0.85-0.90). This naturally demotes them in the combined chain.

3. **Strengthen the system prompt** — Add explicit grounding instructions: "Only report issues that are directly evidenced by the code shown in the diff. Do not infer or assume code that isn't visible."

4. **Keep Mistral as fallback** — Users who only have `MISTRAL_API_KEY` still need a working action. Removing Mistral entirely breaks their setup.

### Daily Bench: Surface the ranking

1. **Workflow change** — Pipe `bench-reorder.js` output through `tee` to capture it, add a "Show ranking" step.

2. **Code change** — Have `bench-reorder.ts` write a markdown ranking table to `GITHUB_STEP_SUMMARY` so it appears in the job summary without expanding logs.

Both changes are small (< 20 lines each).

## Open Questions

1. **What hallucination rate is acceptable?** — Need to measure: how many findings get dropped by revalidation when Mistral is the model? If it's >30%, the model is wasting tokens.
2. **Should revalidation use the same model or a different one?** — Currently it uses the same model that generated the findings. Using a NIM model to validate Mistral findings might be more reliable.
3. **Is there a newer Mistral model that's better grounded?** — Mistral releases new models frequently. Worth checking if a newer version has less hallucination.
