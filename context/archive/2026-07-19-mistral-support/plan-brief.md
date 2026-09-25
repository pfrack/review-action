# First-Class Mistral Support — Plan Brief

> Full plan: `context/changes/mistral-support/plan.md`
> Research: `context/changes/mistral-support/research.md`

## What & Why

Add Mistral as a first-class provider with its own API key and model fallback chain, identical in structure to the existing NIM integration. When both keys are configured, models from both providers merge into a single fallback chain sorted by SWE-bench score — the best model wins regardless of which provider hosts it.

## Starting Point

The action currently supports one provider (NVIDIA NIM) with a CSV model fallback chain (`nim_models`) ordered by SWE-bench score + latency. The `NimClient` class is already compatible with Mistral's OpenAI-compatible API — only routing and configuration need adding.

## Desired End State

Users configure `mistral_api_key` and/or `nim_api_key`. The action builds a unified fallback chain from all available models across both providers, tries them in SWE-bench score order, and routes each to the correct endpoint. A daily benchmark job independently tracks Mistral model performance.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|-------------------|--------|
| Chain strategy when both keys present | Combined unified chain sorted by SWE-bench | Best model wins regardless of provider — no artificial provider priority. | Plan |
| Mistral input pattern | `mistral_models` CSV with defaults, same as `nim_models` | Symmetry — users already understand the pattern. | Plan |
| Default Mistral models | `mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508` | Pinned IDs with known SWE-bench scores for reproducibility. | Research |
| `nim_api_key` optionality | Optional — require at least one key | Supports Mistral-only, NIM-only, or both without forcing unused keys. | Plan |
| Benchmark approach | Separate `benchmark-mistral` job, reorder independently | Each provider's latency is measured against its own endpoint; combined merge uses static scores at runtime. | Plan |
| Failure behavior | Silent fallthrough to next model in combined chain | Matches existing NIM fallback pattern — maximizes availability. | Research |

## Scope

**In scope:**
- `mistral_api_key` and `mistral_models` action inputs
- Make `nim_api_key` optional
- Combined fallback chain with provider-aware routing
- Mistral direct-API model IDs in SWE-bench score map
- Separate benchmark job for Mistral
- Tests and README update

**Out of scope:**
- Generic custom API support (separate change)
- Renaming `NimClient` to a generic name
- Streaming differences between providers
- Mistral-specific error handling

## Architecture / Approach

New `src/model-chain.ts` exports a `buildCombinedChain()` function that merges `nimModels[]` and `mistralModels[]` into `TaggedModel[]` (model ID + provider), filtered by which keys are present, sorted by SWE-bench score. The main loop instantiates both clients conditionally and iterates the combined chain — picking the right client per model. `NimClient` is reused unchanged for both endpoints.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Config & Inputs | New action inputs, optional `nim_api_key` | Breaking existing users if validation is wrong |
| 2. Combined Fallback Chain | Unified model iteration with provider routing | Regression in existing NIM-only behavior |
| 3. SWE-bench Score Map | Mistral model IDs scored correctly | Incorrect scores affecting sort order |
| 4. Benchmark Workflow | Daily Mistral benchmarks + reorder | Secret not set → job must skip gracefully |
| 5. Tests & Docs | Full coverage + README | None significant |

**Prerequisites:** Mistral API key for manual testing and benchmark job.
**Estimated effort:** ~2 sessions across 5 phases.

## Open Risks & Assumptions

- Codestral-2508 SWE-bench Verified score (0.650) is estimated — no official score found. May need adjustment after benchmarking.
- Mistral API rate limits under heavy PR load are unknown — fallthrough to NIM handles this gracefully.
- `nim_api_key` changing from `required: true` to `required: false` is non-breaking for GitHub Actions, but should be verified.

## Success Criteria (Summary)

- Users with only a Mistral key get working code reviews using Mistral models
- Users with both keys get the best model across providers (highest SWE-bench score first)
- Existing NIM-only users see zero behavior change
