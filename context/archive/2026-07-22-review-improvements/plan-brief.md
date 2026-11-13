# review-improvements — Plan Brief

> Full plan: `context/changes/review-improvements/plan.md`

## What & Why

Comprehensive improvements to the review-action across three dimensions: review quality (new prompts, deep validation), performance (file batching, parallel probing), and features (inline comments, custom rules, analytics). The motivation is proactive maintenance — the action works but has clear improvement opportunities in prompt effectiveness, validation depth, and developer experience.

## Starting Point

The review-action is a working GitHub Action with solid foundations: Zod-validated structured output, model fallback chain with SWE-bench scoring, and per-language prompt infrastructure (defined but unused). Key gaps: prompts are generic (language-specific ones exist but are never used), validation is structural only (hunk overlap, no semantic checks), no file batching for large PRs, only top-level PR comments (no inline), no custom rules, no metrics.

## Desired End State

- Research-backed system prompts with language-aware instructions that reduce false positives
- Deep validation: code context verification + optional LLM re-validation before posting
- File batching (50 files/batch) for large PRs, completing reviews 2-3x faster
- Inline review comments on specific lines via GitHub Review API
- Custom rules defined via action inputs, injected into review prompts
- PR-level metrics (findings, severity, model performance) in step summary

## Key Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Prompt approach | New design (not enabling existing) | Existing prompts need research-backed improvements, not just activation |
| Performance strategy | File batching | Largest impact for large PRs; streaming only helps first-token latency |
| Inline comments API | GitHub Review API | Native support for line-level comments, proper review threading |
| Custom rules input | Action inputs | Simplest UX, no external config files needed |
| Metrics level | PR-level | Sufficient for debugging without external storage complexity |
| Validation depth | Code context + LLM | Structural validation catches hallucinations, LLM validates semantics |

## Scope

**In scope:**
- New prompt system with language-specific instructions
- Code context validation + optional LLM re-validation
- File batching and diff chunking for large PRs
- Inline comments via GitHub Review API
- Custom rules via action inputs
- PR metrics in step summary

**Out of scope:**
- Model chain logic or benchmark system changes
- Real-time dashboards or external storage
- Breaking changes to action.yml inputs
- A/B testing between models

## Architecture / Approach

Incremental delivery across 6 phases, each independently shippable:

1. **Prompt Redesign** — New `buildSystemPrompt(language?)` function, enhanced severity guidance, language-specific sections
2. **Enhanced Validation** — New `validation.ts` module with code context checks and LLM re-validation
3. **Performance** — New `batching.ts` and `diff-utils.ts` modules, parallel model probing
4. **Inline Comments** — New `github-review.ts` client for Review API, comment formatting
5. **Custom Rules** — New `rules.ts` module, action input, prompt injection
6. **Analytics** — New `metrics.ts` module, step summary output

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|------------------|----------|
| 1. Prompt Redesign | Better prompts, fewer false positives | Prompt changes may affect finding quality |
| 2. Enhanced Validation | Deep validation, fewer hallucinations | LLM re-validation adds latency |
| 3. Performance | 2-3x faster for large PRs | Batching may split related findings |
| 4. Inline Comments | Line-level findings | Review API has different UX than comments |
| 5. Custom Rules | User-defined focus areas | Prompt injection risk |
| 6. Analytics | Visibility into review quality | Minimal risk, additive |

**Prerequisites:** None — all phases are independent
**Estimated effort:** 6-8 sessions across 6 phases

## Open Risks & Assumptions

- Prompt redesign may require iteration to match or exceed current finding quality
- LLM re-validation adds latency (configurable, default off)
- Inline comments have different threading UX than top-level comments
- Custom rules need careful validation to prevent prompt injection

## Success Criteria (Summary)

- Finding quality improves (fewer false positives, better severity classification)
- Large PRs (100+ files) complete review in under 5 minutes
- Findings appear as inline comments on specific lines
- Custom rules are applied and produce relevant findings
- PR metrics are visible in step summary
