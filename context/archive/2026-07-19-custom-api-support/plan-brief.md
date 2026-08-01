# Custom API Support — Plan Brief

> Full plan: `context/changes/custom-api-support/plan.md`
> Research: `context/changes/custom-api-support/research.md`

## What & Why

Add generic custom API endpoint support so users can bring any OpenAI-compatible service (OpenRouter, Ollama, vLLM, Together AI, Groq, etc.) to the code review action. This unlocks self-hosted and third-party models without requiring a first-class provider integration for each.

## Starting Point

The action already has a multi-provider architecture: a `Provider` type union (`'nim' | 'mistral'`), a clients map (`Record<Provider, NimClient | null>`), and a `TaggedModel[]` chain sorted by SWE-bench score. `NimClient` is endpoint-agnostic — it works with any OpenAI-compatible API. The extension pattern is proven by the Mistral integration.

## Desired End State

Users configure `custom_api_url` + `custom_model` (+ optional `custom_api_key`) and their model is tried first on every PR review. If it fails, the existing Mistral → NIM fallback chain handles the review transparently. The PR comment shows which model was actually used.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|-------------------|--------|
| Priority ordering | Custom always first | User explicitly chose this endpoint — honor their intent | Plan |
| Multi-model support | Single model only | Keep it simple; CSV fallback adds complexity with unclear scoring interaction | Plan |
| Timeout | Same 180s | Already generous; avoids yet another input | Research |
| SWE-bench scoring | No lookup, always prepend | Custom is user's preference, not a ranking candidate | Plan |
| Activation condition | URL + model both required | API key can be empty (supports keyless/local endpoints) | Research |
| Failure behavior | Silent fallthrough | Custom is best-effort; NIM/Mistral is the safety net | Research |

## Scope

**In scope:**
- Three new action inputs (`custom_api_url`, `custom_model`, `custom_api_key`)
- Config interface + loader extension
- `Provider` type + chain builder extension
- Custom client instantiation and wiring in main flow

**Out of scope:**
- Multiple custom models (CSV)
- Custom timeout configuration
- SWE-bench scoring for custom models
- Benchmark integration
- Streaming support

## Architecture / Approach

Extend the existing provider pattern: add `'custom'` to the `Provider` type, instantiate a second `NimClient` when configured, and prepend a `TaggedModel { id: customModel, provider: 'custom' }` to position 0 of the combined chain (after score-sorting the other models). The existing fallback loop in `reviewFileWithFallback()` and `index.ts` handles everything else unchanged.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Config & Inputs | Action inputs + Config fields | None — additive only |
| 2. Provider Type & Chain Building | `'custom'` provider + prepend logic + tests | Ensuring stable sort isn't disrupted |
| 3. Client Instantiation & Integration | Working end-to-end custom model support | Validation logic for "custom-only" mode |

**Prerequisites:** None — builds on current main
**Estimated effort:** ~1 session, 3 small phases

## Open Risks & Assumptions

- Custom endpoints with non-standard response formats will fail opaquely (NimClient expects standard OpenAI response shape)
- Users running only custom (no NIM/Mistral key) have no fallback safety net — we warn but allow it

## Success Criteria (Summary)

- Custom endpoint tried first when configured, shown in PR comment
- Silent fallthrough to existing chain on custom failure
- Action still works identically when custom inputs are not provided
