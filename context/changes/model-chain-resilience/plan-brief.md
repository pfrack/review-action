# Model Chain Resilience — Plan Brief

> Full plan: `context/changes/model-chain-resilience/plan.md`

## What & Why

The 2026-08-01 implementation made the review action more resilient to incompatible provider response formats, verbose reasoning models, truncated output, slow model-chain heads, and singular/plural custom-model configuration. Most of that work shipped without a dedicated context record, so this retrospective plan captures the decisions and leaves explicit hardening, documentation, and live-verification work.

## Starting Point

The action already used a SWE-bench-ordered sequential fallback chain and Zod-validated review schema. Providers could still reject the requested structured-output mode, large reviews could hit a fixed token limit, slow heads delayed every fallback, and plural-only custom models did not create a client.

Existing daily benchmark, timeout, and probe-cap artifacts remain authoritative for their original scopes. This change bridges only their undocumented deltas and the new resilience work.

## Desired End State

Compatible models produce validated review JSON whether they support `json_schema`, only `json_object`, or plain text. Output budgets scale with review size, optional staggered parallel attempts reduce fallback latency without changing the sequential default, and singular/plural custom-model inputs create one correct deduplicated chain. Public docs, direct edge-case tests, and live Action evidence match the implementation.

## Key Decisions Made

| Decision | Choice | Why |
| --- | --- | --- |
| Artifact shape | One umbrella change | The work shares one outcome: model-chain resilience across provider, scheduling, and custom-chain boundaries. |
| Historical coverage | Undocumented gaps plus references | Avoid duplicating daily benchmark, timeout, and probe-cap records. |
| Structured-output fallback | `json_schema` → `json_object` → known-model text mode | Preserve schema-first behavior while supporting providers with narrower capabilities. |
| Text recovery | Strip reasoning wrappers, then extract fenced or balanced JSON | Reasoning prose and stray braces otherwise corrupt JSON recovery. |
| Truncated output | Continue only when returned content already parses as JSON | Retain complete reviews without accepting incomplete payloads. |
| Token budget | Adaptive 4,096–16,384 by default; explicit override supported | Large diffs need more output headroom, while a cap controls cost. |
| Parallel fallback | Opt-in bounded prefix with staggered starts | Reduce tail latency without changing default cost or head priority. |
| Winner rule | First result with validated non-empty findings | Invalid raw content must not cancel potentially successful siblings. |
| Custom model identity | Deduplicate singular/plural IDs in first-seen order | Prevent repeated calls without changing user priority. |
| Custom probe quality | User-supplied SWE score override, default 0.5 | Apply the existing probe-promotion quality cap to custom heads. |
| Progress recording | Mark shipped evidence complete; leave hardening/manual checks pending | Reflect reality without claiming unperformed verification. |

## Scope

**In scope:**

- Provider-specific `json_schema` and `json_object` compatibility.
- Text-mode JSON extraction and reasoning-wrapper stripping.
- Extractable truncated-response handling.
- Custom score propagation, deduplication, and plural-only client creation.
- Adaptive `max_tokens` and opt-in staggered parallel attempts.
- Missing parser/scheduler tests, README alignment, and live verification.

**Out of scope:**

- Daily model-order churn and generated-bundle-only history.
- Existing timeout and probe-cap behavior already documented elsewhere.
- Streaming review execution, retry redesign, or provider-specific clients.
- Parallel execution as the default.

## Architecture / Approach

`OpenAIClient` owns provider response-format compatibility and text extraction. `attemptModel()` owns one complete request/validation attempt. `runModelChainForBatch()` computes the batch output budget and chooses either the unchanged sequential loop or an opt-in staggered parallel prefix. A shared abort controller cancels siblings after a validated winner; untouched models remain available as a sequential tail. Custom models share one custom client and a deduplicated scored chain prefix.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Provider Output Compatibility | Schema fallback, text extraction, reasoning cleanup, truncation tolerance | Provider error wording and model behavior can change. |
| 2. Custom Chain Correctness | Score override, deduplication, plural-only client creation | Singular/plural checks remain duplicated in parts of the entrypoint. |
| 3. Adaptive Budget and Parallel Fallback | Diff-scaled output tokens and bounded staggered attempts | Parallel mode can increase provider usage and cost. |
| 4. Hardening and Verification | Missing tests, README correction, bundle build, live runs | Live checks require provider credentials and a test PR. |

**Prerequisites:** Node 20+ development environment, repository dependencies, provider credentials, and a test PR for manual verification.

**Estimated effort:** Shipped phases are complete; remaining hardening is approximately one implementation session plus live provider verification.

## Open Risks & Assumptions

- Provider-specific override tables require maintenance as model capabilities change.
- Winner cancellation is best-effort after providers accept requests and may not eliminate all usage cost.
- Existing parallel tests use zero threshold and do not prove real staggering or cancellation timing.
- New input parsers lack direct boundary tests.
- `README.md` still advertises a 60-second model timeout instead of the implemented 90-second default.
- `3154960` and `7ea1d35` were local-only commits when this artifact was created.

## Success Criteria (Summary)

- Structured, text-mode, truncated, and custom plural-only model paths produce validated live reviews.
- Adaptive and explicit token budgets stay within documented bounds; optional parallel attempts preserve sequential fallback invariants.
- Missing scheduling/config tests pass, the Action bundle rebuilds, and the full suite remains green.
- README inputs and defaults match `action.yml` and `src/config.ts`.
