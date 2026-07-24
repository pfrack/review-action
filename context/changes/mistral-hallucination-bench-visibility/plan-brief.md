# Add Groq Provider + Bench Ranking Visibility — Plan Brief

> Full plan: `context/changes/mistral-hallucination-bench-visibility/plan.md`
> Research: `context/changes/mistral-hallucination-bench-visibility/research.md`

## What & Why

Add Groq as a fourth free provider in the fallback chain to reduce reliance on Mistral (which hallucinates findings). Groq is free, blazing fast (LPU hardware), OpenAI-compatible, and supports `json_schema` natively. Also fix daily bench visibility — the ranked model list is computed but buried in step logs.

## Starting Point

The action currently has 3 providers: NIM (primary), Custom (tried first if configured), Mistral (fallback). All models from NIM + Mistral are sorted by SWE-bench score in a combined chain. The daily benchmark runs separate jobs for NIM and Mistral but doesn't surface the final ranking in GITHUB_STEP_SUMMARY.

## Desired End State

Four providers in the chain: **Custom (first) → [NIM + Groq + Mistral sorted by SWE-bench]**. Groq models (`openai/gpt-oss-120b`, `kimi-k2-instruct`, `llama-3.3-70b-versatile`) compete on score alongside NIM and Mistral models. Daily benchmark shows a ranked table in the GitHub job summary.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
|----------|--------|-------------------|
| Chain position | Mixed by SWE-bench score | Best model wins regardless of provider |
| Groq base URL | Hardcoded | Single known endpoint, no user config needed |
| Default Groq models | gpt-oss-120b, kimi-k2-instruct, llama-3.3-70b-versatile | Best free models by SWE-bench score available on Groq |
| Keep Mistral | Yes | Still a valid free fallback; users may have MISTRAL_API_KEY |
| Bench visibility | Same plan | Small addition (<15 lines), natural fit |

## Scope

**In scope:**
- New `groq_api_key` and `groq_models` action inputs
- Groq client creation + chain integration
- SWE-bench scores for Groq model IDs
- `benchmark-groq` workflow job
- `bench-reorder.ts` writes ranking to GITHUB_STEP_SUMMARY

**Out of scope:**
- Removing Mistral
- Changing the `tools` format workaround for Mistral
- Groq-specific model discovery in bench-entry

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Add Groq Provider | Full chain integration (type, config, client, action.yml, scores) | None — follows existing Mistral pattern exactly |
| 2. Benchmark + Visibility | Groq benchmark job + GITHUB_STEP_SUMMARY ranking | Need `GROQ_API_KEY` secret in repo |

**Prerequisites:** Groq API key (free, no credit card)
**Estimated effort:** ~1 session, both phases

## Open Risks & Assumptions

- Groq free tier has 1,000 RPD / 30 RPM — sufficient for daily bench (4-6 requests) and PR reviews
- Groq model IDs may differ from NIM IDs for same underlying model (verified: they do)

## Success Criteria (Summary)

- With `GROQ_API_KEY` set, Groq models appear in the combined chain sorted by SWE-bench score
- Daily benchmark runs for Groq and shows final ranking in job summary
- No regression: without Groq key, action works exactly as before
