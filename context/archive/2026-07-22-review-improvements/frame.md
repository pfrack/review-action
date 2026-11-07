# Frame Broad: Review-Action Improvements

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

The review-action (AI-powered GitHub PR review via NIM/Mistral/custom models)
works end-to-end but has multiple improvement opportunities across review
quality, performance/cost, developer experience, and extensibility. The user
wants a broad research sweep before prioritizing.

## Initial Framing (preserved)

- **User's stated cause or approach**: "research possibilities to improve"
- **User's proposed direction**: Broad survey across all improvement areas, no specific pain point yet
- **Pre-dispatch narrowing**: All four dimensions selected (quality, performance, DX, extensibility); all pain points noted (false positives, missed issues, slow, generic, new to project)

## Dimension Map

The observation could originate at any of these dimensions:

1. **Prompts & language awareness** — per-language prompts exist but are dead code; the action uses a generic prompt for all languages ← HIGH impact
2. **Schema richness** — the Finding schema lacks category, confidence, code_snippet, and rule_id fields, limiting filtering and deduplication
3. **Deduplication & scoring** — no dedup of similar findings; no confidence-based ranking within severity buckets
4. **Token & diff management** — no pre-check for diff size vs context window; hardcoded maxTokens=4096; no dynamic sizing
5. **Model chain strategy** — custom model always first regardless of score; no parallel speculation; latency-based scoring unused at runtime
6. **Retry & error handling** — Retry-After header ignored; no jitter on backoff; maxRetries=2 is low
7. **Comment UX** — single top-level comment, no inline review comments, no code context, no file links
8. **Configurability** — temperature, max_tokens, timeouts, comment marker all hardcoded; no outputs exposed
9. **Benchmarking efficiency** — sequential model benchmarking; 2 API calls per iteration (non-streaming + streaming for TTFT)
10. **Test coverage gaps** — zero integration tests; languageForFile, globMatch, escapeMarkdown, GitHub API layer untested

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **Prompts: language prompts are dead code** | `src/prompts.ts:18-143` defines 6 language prompt sets; `src/index.ts:141-145` only uses `BASE_SYSTEM_PROMPT` from `review.ts:6-11`; `languagePrompts` is exported but never imported by `index.ts` | STRONG |
| **Schema: missing category/confidence fields** | `src/review-schema.ts:3-13` — Finding schema has file, severity, line range, issue, suggestion, action fields. No category, confidence, rule_id, or code_snippet | STRONG |
| **No deduplication** | `src/review.ts:122-165` — `validateFindings` validates file existence and hunk overlap but does not deduplicate similar findings | STRONG |
| **Token waste: no pre-check** | `src/index.ts:117-121` — diffs concatenated without token estimation; `finishReason === 'length'` at line 155 wastes entire call + retry | STRONG |
| **Model chain: custom always first** | `src/model-chain.ts:49-51` — custom model unshifted to position 0 regardless of SWE-bench score | STRONG |
| **Retry: no jitter, ignores Retry-After** | `src/retry.ts:21` — deterministic `delay * 2^i`; `openai-client.ts` does not read Retry-After header | STRONG |
| **Comment UX: no inline reviews** | `src/review.ts:264-270` — posts single top-level comment via PR comments API, not PR reviews API | STRONG |
| **Config: hardcoded values** | `temperature: 0.2` at `index.ts:149`; `maxTokens: 4096` at line 150; timeout 180s at `openai-client.ts:120`; `COMMENT_MARKER` at `review.ts:261` | STRONG |
| **Benchmarking: sequential + 2 calls/iter** | `bench-entry.ts:292` — sequential for-loop; `bench.ts:42-56` — non-streaming + streaming per iteration | STRONG |
| **Test gaps: no integration tests** | No mock of OpenAI client or GitHub API in any test file; `languageForFile` has zero test coverage | STRONG |

## Narrowing Signals

Decisive observations from Step 4 (user reports + sub-agent findings) that
narrowed the hypothesis space:

- User selected all four improvement areas and all pain points — confirmed broad sweep is desired
- Dead language prompts (#1) is the single highest-impact finding: existing code, zero integration
- Schema limitations (#2) compound multiple issues: no dedup, no filtering, no trend tracking
- Token waste (#4) is the most concrete cost improvement — measurable and fixable

## Cross-System Convention

GitHub Actions for code review typically:
- Use inline review comments (via PR Reviews API) for line-level findings
- Expose outputs (finding counts, model used, comment URL) for downstream steps
- Support configurable severity thresholds and review modes
- Use chunking or streaming for large diffs

The review-action deviates from convention in: single top-level comment only,
no outputs, no chunking, no inline comments. The schema innovation (triple
action fields) is ahead of convention — most similar tools lack per-severity
action guidance.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: The review-action has strong
> foundations (schema validation, hallucination detection, severity guidance)
> but multiple disconnected gaps that compound each other: unused language
> prompts reduce review quality, a thin schema prevents deduplication and
> filtering, hardcoded configuration wastes tokens and API calls, and a
> single top-level comment limits developer actionability.

The initial framing was correct — the user correctly identified that improvement
is needed across multiple dimensions. The investigation confirms this and
provides the specific evidence to prioritize.

## Confidence

- **HIGH** — all 10 hypotheses have strong evidence with file:line references;
  patterns match convention gaps; the user confirmed broad scope

## What Changes for /10x-plan

The plan should address improvements in priority order:
1. Wire language prompts into the pipeline (existing code, biggest quality gain)
2. Enrich the schema (category, confidence) to enable dedup and filtering
3. Add deduplication and confidence-based ranking
4. Make token management smarter (pre-check, dynamic maxTokens)
5. Improve comment UX (inline reviews, file links, collapsible sections)
6. Expose action outputs for downstream use
7. Make hardcoded values configurable (temperature, max_tokens, timeouts)
8. Add integration tests for the full pipeline

This is a multi-phase improvement plan. Each phase is independently shippable.

## References

- Source files: `src/prompts.ts:18-143` (dead language prompts), `src/review-schema.ts:3-13` (schema), `src/review.ts:122-165` (validation), `src/index.ts:117-220` (pipeline), `src/model-chain.ts:26-54` (chain), `src/retry.ts:10-24` (retry), `src/openai-client.ts:76-157` (API calls), `action.yml:6-49` (inputs)
- Investigation tasks: explore-1 (prompts/quality), explore-2 (performance/models), explore-3 (DX/extensibility)
