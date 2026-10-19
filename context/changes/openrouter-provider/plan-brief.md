# OpenRouter & Kilo Provider — Plan Brief

> Full plan: `context/changes/openrouter-provider/plan.md`

## What & Why

Add OpenRouter and Kilo Gateway as first-class provider slots in the NIM Code Review Action, so users get curated free-model defaults and quality-first fallback chains for both gateways — no manual `custom_api_url` configuration needed.

## Starting Point

The action currently supports 4 first-class providers (NIM, Mistral, Groq) + a generic Custom slot. Adding a new provider follows a well-established ~10-file, ~150 LOC pattern (proven by the Groq addition). OpenRouter is already partially supported via the Custom slot (test fixture at `review.test.ts:129`). Kilo was previously evaluated and cancelled due to a privacy concern (prompts logged for training on free tier) — this plan reverses that cancellation.

## Desired End State

Users configure OpenRouter or Kilo by providing only an API key — the action defaults to a curated free-model list. All provider models merge into a single fallback chain sorted by SWE-bench quality, with free models forced to rank last. The `custom_models` CSV input allows multiple custom-slot models (benefiting every gateway).

## Key Decisions Made

| Decision | Choice | Why | Source |
|----------|--------|-----|--------|
| OpenRouter integration | First-class provider slot | ~150 LOC, follows Groq pattern; OpenRouter is widely used and merits first-class status | Plan |
| Kilo integration | First-class provider slot | User desired it; despite privacy concern, user chose to include it | Plan (reverses cancelled research) |
| Free model handling | Estimated SWE-bench scores + rank last | Quality-first philosophy preserved; free models as safety net, not front-runner | Plan |
| Free model scores | Estimated (0.50-0.65 range) | No verified scores exist; honest approximations with labeling | Plan |
| Free model IDs | `:free` suffix convention | Aligns with OpenRouter naming; self-documenting | User |
| Chain ordering | Free models last (after non-free, before custom) | Quality-first preserved; custom always-first | User |
| Kilo privacy | Documented warning in README | Free tier logs prompts for training — unacceptable for PR diff ingestion without notice | Kilo research |
| custom_models CSV | Added alongside first-class slots | Benefits all gateways equally; resolves multi-model gap in Custom slot | User |

## Scope

**In scope:** OpenRouter first-class slot, Kilo first-class slot, `custom_models` CSV input, free-model SWE-bench estimates, free-last chain ordering, README docs for OR/Kilo, benchmark workflow jobs, full test coverage.

**Out of scope:** Paid-model tiers in defaults, auto-discovery, custom headers, Kilo paid tiers, daily benchmarks for volatile free models until stable.

## Architecture / Approach

Two parallel first-class provider additions (following Groq pattern) + one generic enhancement (`custom_models` CSV). The key behavioral rule: free models get estimated scores and are sorted to the end of the chain after all non-free provider models. Custom-slot models remain always-first.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Config + Chain Infrastructure | action.yml inputs, Config interface, Provider type, chain logic with free-last rule | Chain ordering correctness |
| 2. Client + Index Integration | OpenAIClient labels, buildClients, URL validation, key-gate | Provider label detection |
| 3. Bench-Rank + Scores | SWE-bench estimated scores for free models, updateActionYml for OR/Kilo, custom_models CSV wiring | Free-model score volatility |
| 4. Tests + Docs + Workflows | Test fixtures, README sections, benchmark jobs | Kilo privacy warning visibility |
| 5. End-to-End Verification | Full build + test + chain sanity + README review | Regression from 6-provider interaction |

**Prerequisites:** Git on main branch; ~30 focused implementation sessions across 5 phases.

## Open Risks & Assumptions

- **Kilo privacy concern** (HIGH): Kilo free tier routes to providers that log prompts for training. PR diffs may contain sensitive code. The README must include an explicit warning. This reverses the `context/changes/kilocode-provider` cancellation decision.
- **Free-model score volatility** (MEDIUM): OpenRouter free model IDs and availability change frequently. Estimated SWE-bench scores may become stale; they should be labeled as estimates and replaced with measured values once benchmark data is available.
- **Performance surface** (LOW): Adding 2 more providers + custom_models CSV increases the chain length and probe time. Free models are forced last so they're only probed if everything else fails — this mitigates the latency concern.

## Success Criteria (Summary)

- Users can configure OpenRouter or Kilo with just an API key and get a working free-model fallback chain
- Free models rank last in the combined quality-first chain, after all NIM/Mistral/Groq non-free models
- custom_models CSV lets users pin multiple custom-slot models for any gateway
- README clearly documents all 6 providers with the Kilo privacy warning
- All existing tests pass; new provider + free-model + CSV tests pass