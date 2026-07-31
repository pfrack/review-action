---
date: 2026-07-20T12:00:00+02:00
researcher: kiro
git_commit: 093c0b5184d15aa9bf88266af721927f5f16cac9
branch: main
repository: review-action
topic: "Should we add Kilo Gateway (api.kilo.ai/api/gateway) as a 4th first-class provider with kilo-auto tried first because it's the fastest?"
tags: [research, codebase, model-chain, bench-reorder, custom-api, kilocode, provider-promotion, framing, follow-up]
status: complete
last_updated: 2026-07-20
last_updated_by: kiro
last_updated_note: "Added follow-up after user clarified: Kilo's Auto routing is the value, not a problem to benchmark. Recommendation unchanged — use the existing custom_api_url slot."
---

# Research: Add Kilo Gateway as First-Class Provider (Latency-First)?

**Date**: 2026-07-20T12:00:00+02:00
**Researcher**: kiro
**Git Commit**: `093c0b5184d15aa9bf88266af721927f5f16cac9`
**Branch**: `main`
**Repository**: `review-action`

## Research Question

The user proposes adding the Kilo Gateway (`https://api.kilo.ai/api/gateway`,
OpenAI-compatible) as a new first-class provider slot named `kilocode`, with
the meta-model `kilo-auto-efficient` tried first in the fallback chain
because "it is the fastest." This research evaluates whether that proposal is
architecturally sound, evidence-backed, and consistent with the project's
existing provider-promotion rules.

User-clarified framing:
- **Provider shape**: new first-class provider (4th slot), not a `custom`-slot config.
- **Evidence**: hypothetical — no benchmark data yet.
- **Latency weight**: latency-only — pure speed, regardless of SWE-bench score.

## Summary

**Recommendation: No-Go.** The existing `custom_api_url` slot already
delivers the functional behavior the user wants (Kilo tried first, falls
through to NIM/Mistral chain) with zero code changes. Promoting Kilo to a
first-class slot violates three project rules, breaks the bench-reorder
system, and locks in an unverifiable "fastest" claim.

| Question | Answer |
|---|---|
| Is `NimClient` already Kilo-compatible? | Yes — same OpenAI wire format (`src/nim-client.ts:58-93`). |
| Can users configure Kilo today via `custom_*`? | Yes — already works (`src/model-chain.ts:48-51`). |
| Does "Kilo Auto Efficient" have a SWE-bench score? | No — it's a non-deterministic router over 500+ models. |
| Does "fastest" actually win in the existing ranker? | No — quality leads, latency <60s is multiplier 1.0 (`src/bench-reorder.ts:113-130`). |
| Would adding a 4th slot require changes to NIM/Mistral code paths? | No — but 10 files, ~150 lines, plus a benchmark workflow job. |
| Does the project's PRD endorse quality-first ranking? | Yes — explicit (`context/foundation/prd.md:118-127`). |
| **Go / No-Go** | **No-Go for first-class; Yes-Go for README docs snippet under "Custom API Support".** |

## Detailed Findings

### 1. Kilo Gateway — What It Actually Is (Web Research)

Source: [kilocode.ai/gateway](https://kilocode.ai/gateway),
[kilocode.ai/docs/ai-providers/kilocode](https://kilocode.ai/docs/ai-providers/kilocode).

- Kilo Code is a real, popular open-source AI coding agent (Anaconda acquired it
  Jul 2026 per their blog).
- Kilo Gateway (`https://api.kilo.ai/api/gateway`) is their hosted
  OpenAI-compatible inference endpoint. Models include frontier tiers
  (`anthropic/claude-opus-4.8`, `z-ai/glm-5.2`, `mistral-medium-3.5`,
  `gpt-5.5`, etc.) plus "Auto" virtual models that route dynamically.
- "Kilo Auto Efficient" / `kilo-auto-efficient` is a **virtual router**, not
  a single model. The underlying model changes per request based on task
  classification. (See `Auto Model` section of their landing page.)
- BYOK supported; their pricing page advertises "zero AI inference markup."
- The product explicitly markets itself as "drop-in compatible with standard
  AI SDKs" — meaning it is deliberately designed to plug into generic
  OpenAI-compatible clients. This is the same shape as the existing
  `custom_api_url` slot already targets.

**Implication**: Kilo is architecturally a peer of OpenRouter, Ollama, vLLM,
Groq, and Together — all of which the `custom_api_url` slot already lists as
target endpoints (`context/changes/custom-api-support/research.md:175-203`).

### 2. Codebase Cost of a 4th First-Class Slot

If we add `kilocode` as a first-class provider (mirroring the `mistral_*`
pattern), every layer of the action needs a parallel set of edits:

| File | Range | Change shape |
|---|---|---|
| `action.yml` | `17-25` | Insert 3 new inputs (`kilocode_api_key`, `kilocode_base_url`, `kilocode_models`) before the `custom_*` block |
| `src/review.ts` | `17-31` | Add 3 fields to `Config` |
| `src/review.ts` | `37-54` | Add 3 `core.getInput()` calls in `loadConfig()` |
| `src/review.ts` test fixtures | `57-71, 117-122, 178-184, 241-255` | Update every `Config` literal to include the 3 new fields |
| `src/model-chain.ts` | `3` | Add `'kilocode'` to `Provider` union |
| `src/model-chain.ts` | `10-17` | Add `kilocodeModels`, `hasKilocodeKey` to `ChainOptions` |
| `src/model-chain.ts` | `26-54` | Either prepend (custom-style) or scored-peer (NIM/Mistral-style) — different semantics |
| `src/index.ts` | `9-51` | Add `hasKilocode` validation, `kilocodeClient`, `clients['kilocode']`, chain-build args |
| `src/index.ts` | `Record<Provider, NimClient \| null>` | TypeScript requires `kilocode: null` in every test fixture |
| `src/bench-reorder.ts` | `155-166` | Add `'kilocode_models'` to `ActionTarget` + `TARGET_CONFIG` |
| `src/bench-reorder.ts` | (after 204) | Add `updateActionYmlKilocode()` mirroring `updateActionYmlMistral` |
| `src/bench-entry.ts` | (none) | Reusable as-is via env vars — no code change |
| `.github/workflows/benchmark.yml` | `82-148` | Add 3rd job `benchmark-kilocode` mirroring `benchmark-mistral` |
| `src/model-chain.test.ts` | full file | Add kilocode-only and combined-with-kilocode-prepended cases |
| `src/review.test.ts` | `286-290, 340-344, 381-385, 417-421` | Add `kilocode: null` to every `clients` literal |
| `src/bench-reorder.test.ts` | (after 200) | Add `updateActionYmlKilocode` describe block |
| `README.md` | `3, 31-43, 45-94, 150-169` | Add 3 rows to Inputs table, new "Kilocode Support" section, benchmarking snippet |

**Net**: 10+ files, ~150 lines of code + tests + a new benchmark job.

**Zero new code needed to reuse `custom_*`** — the user sets:

```yaml
custom_api_url: https://api.kilo.ai/api/gateway
custom_model: kilo-auto-efficient
custom_api_key: ${{ secrets.KILOCODE_API_KEY }}
nim_api_key: ${{ secrets.NIM_API_KEY }}   # safety-net fallback
```

This:
- Hits the same `/chat/completions` endpoint via the same `NimClient`
- Routes to Kilo first (via `unshift` at `src/model-chain.ts:48-51`)
- Falls through to NIM/Mistral chain on failure (`src/index.ts:107-131`)
- Shows `kilo-auto-efficient` in the PR comment
- Validates URL protocol at `src/index.ts:12-21`
- Already supports keyless mode for local testing

### 3. The Custom Slot Already Gives the User What They Want

The user's stated goal: "try Kilo first because it is the fastest."

That goal is already implemented by `custom_*`:

| User goal | Already works via `custom_*`? | Reference |
|---|---|---|
| Try Kilo first | Yes | `src/model-chain.ts:48-51` (`chain.unshift(...)`) |
| Fall back to NIM/Mistral on Kilo failure | Yes | `src/index.ts:107-131` |
| Use Kilo in Kilo-only mode (no NIM/Mistral key) | Yes | `src/index.ts:23-29` |
| Show Kilo model name in PR comment | Yes | `src/index.ts:137` |
| Custom routing headers (e.g. Kilo's `x-kilocode-mode`) | **No** — `NimClient` has no custom-header hook (`src/nim-client.ts:58-75`) | Would need a generic `custom_headers` feature |
| Pin multiple Kilo models as a fallback chain | **No** — only one `custom_model` slot (`action.yml:30-33`) | Would need generic `custom_models` CSV support |
| Daily benchmark of Kilo's availability | **No** — custom intentionally excluded (`context/changes/custom-api-support/plan.md:27-33`) | Would need a separate bench workflow |

The four "No" rows are real gaps, but **none of them require a Kilo-specific
slot.** They are general shortcomings of the `custom_*` surface that affect
OpenRouter, Together, Groq, Ollama, and vLLM equally. The right fix is a
generic enhancement, not a Kilo-specific slot.

### 4. "Fastest" Conflicts with the Project's Quality-First Rule

The PRD explicitly states:

> *"Quality leads; latency only discounts quality. Models rank by SWE-bench
> score × latency multiplier; responses under 60 seconds receive the same
> multiplier, so 'fastest' alone does not win. Latency only breaks ties after
> effective score."* (`context/foundation/prd.md:118-127`)

Mechanically in `bench-reorder.ts:113-130`:

```ts
if (lat <= maxLatencyMs) return swe;                       // <60s → no penalty
if (lat <= maxLatencyMs * 2) return swe * (1.0 - 0.3 * ratio); // 60-120s → 0.7
return swe * 0.5;                                          // >120s → half
```

A 10-second model with SWE-bench 0.55 ranks **above** a 59-second model with
SWE-bench 0.776. "Fastest" only matters as a tiebreaker between models with
the same effective score (`src/bench-reorder.ts:147-151`).

The user's stated rule — "latency-only, pure speed" — directly inverts this.
Adding Kilo as first-class with "always tried first" overrides the
quality-first ranking and would be the only provider in the action's history
that gets unconditional priority.

**Architectural precedent**: only `custom_*` has unconditional-first priority
today, and only because it represents an explicit user override of the
managed fallback chain. That exception is the precedent the user is asking to
extend — but to a provider that has *less* user commitment than `custom_*`
(no key configured by default) and a verifiable behavioral signature
(non-deterministic routing).

### 5. "Kilo Auto Efficient" Cannot Be Honestly Benchmarked

`SWE_BENCH_SCORES` (`src/bench-reorder.ts:58-104`) is the action's quality
signal. Its header comment reads:

> *"Known SWE-bench Verified scores for models available on NIM."*

Three issues with placing `kilo-auto-efficient` there:

1. **No model identity.** SWE-bench measures a specific model's issue-solving
   ability. Kilo Auto is a router — its underlying model changes per request.
   There is no fixed identity to score.

2. **`getSweBenchScore()` returns 0.5 for unknowns (`src/bench-reorder.ts:106-111`)** —
   which would put `kilo-auto-efficient` *below every currently mapped
   model* (the lowest mapped score is 0.55 for `ai21labs/jamba-1.5-large-instruct`).
   Even worse: the score is silently reported as `SWE=0.500` in the diagnostic
   log (`src/bench-reorder.ts:246-251`), making it indistinguishable from a
   measured value. This is a data-integrity trap.

3. **The benchmark pipeline cannot measure routing stability.** The
   bench-tool records latency, TTFT, throughput, and errors, but does not
   record which downstream model Kilo Auto selected or how stable that
   selection is across iterations (`src/bench.ts:23-129`). For a routing
   model, the actionable data is per-route latency distribution and
   downstream-model entropy — neither of which is captured.

If we want to verify "Kilo Auto is fastest," we need a benchmark that
captures variance, downstream identity, and quality on a fixed task set.
The current bench is not that.

### 6. Go / No-Go Matrix for First-Class Promotion

Criteria synthesized from the Mistral precedent, the custom-slot boundary,
and the PRD.

| Criterion | Result | Note |
|---|---|---|
| OpenAI-compatible transport | PASS | `NimClient` works as-is |
| Stable endpoint + credential boundary | PASS | `https://api.kilo.ai/api/gateway` is fixed |
| Stable candidate model ID | **FAIL** | `kilo-auto-efficient` is not a stable model; reviewed Kilo docs expose auto tiers like `kilo-auto/frontier`, `kilo-auto/balanced`, `kilo-auto/free`, `kilo-auto/small` — confirm canonical API ID before documenting |
| Stable model identity | **FAIL** | Router aliases change server-side |
| Known SWE-bench score | **FAIL** | Router has no defensible single-model score |
| Verified "fastest" claim | **FAIL** | No project benchmark data |
| Curated default fallback list | **FAIL** | No bounded Kilo model list, quality threshold, or replacement policy proposed |
| Dedicated health benchmark + reorder path | **FAIL** | Reorder targets only `nim_models` + `mistral_models` |
| Provider-neutral quality ordering | **FAIL** | "First because fastest" violates quality-first rule |
| Unique value unavailable through `custom_*` | **FAIL** | The primary user goal is already delivered by `custom_*` |
| Credential safety + backward compatibility | PASS | Could be additive, optional |
| Low ongoing maintenance | **FAIL** | Large catalog + mutable auto-routing creates persistent scoring, lifecycle, doc, and benchmark maintenance |

**Result: 3 PASS / 9 FAIL.**

### 7. Where First-Class *Would* Earn Its Keep (Future Re-evaluation Triggers)

These are real gaps that *could* justify first-class promotion — but only if
Kilo-specific user demand emerges:

1. **Multiple pinned Kilo models in a fallback chain.** Today `custom_model`
   is a single string; `kilocode_models` could be a curated CSV. This is a
   general feature (`custom_models` CSV) that benefits every gateway.
2. **Kilo plus a second generic gateway.** Today there is only one
   `custom_*` tuple; a dedicated Kilo slot would free `custom_*` for Ollama
   or OpenRouter. Same generic fix applies.
3. **Organization allowlisted egress.** A hardcoded Kilo hostname with no
   URL override could satisfy strict destination policies that `custom_*`'s
   arbitrary-hostname validation rejects. (Note: input-name renames don't
   accomplish this — only a code-enforced fixed URL does.)
4. **Kilo-specific routing mode.** Kilo supports an optional `x-kilocode-mode`
   header; `NimClient` has no custom-header hook. A generic `custom_headers`
   input would be the cleaner fix than a Kilo-only code path.
5. **Provider-specific diagnostics.** Today, missing Kilo credentials surface
   as generic "NIM returned" errors (`src/nim-client.ts:78-85`). A
   provider-aware error message would help debugging — but again, this is
   a generic improvement.

None of these require a Kilo-only slot. They require generic improvements to
the `custom_*` surface.

## Code References

| Topic | File:Line |
|---|---|
| Custom slot always-first behavior | `src/model-chain.ts:48-51` |
| Custom-slot chain placement | `src/model-chain.ts:41-50` |
| OpenAI-compatible NimClient transport | `src/nim-client.ts:49-93` |
| Custom-only validation gate | `src/index.ts:23-29` |
| Client instantiation for custom | `src/index.ts:32-42` |
| Fallback loop on failure | `src/index.ts:107-131` |
| PR-comment model display | `src/index.ts:137` |
| SWE-bench × latency ranking | `src/bench-reorder.ts:113-130` |
| Unknown-score 0.5 fallback | `src/bench-reorder.ts:106-111` |
| Bench-reorder provider targets | `src/bench-reorder.ts:155-166` |
| Quality-first PRD statement | `context/foundation/prd.md:118-127` |
| Auto-discovery non-goal | `context/foundation/prd.md:72-81, 133-140` |
| Custom-slot scope (excludes bench) | `context/changes/custom-api-support/plan.md:27-33` |
| Custom-slot endpoint list (Kilo peers) | `context/changes/custom-api-support/research.md:175-203` |
| Mistral first-class rationale | `context/changes/mistral-support/research.md:28-33, 226-231` |

## Architecture Insights

1. **The action's provider model is data-driven, not code-driven.** Adding a
   provider means adding data (inputs, config fields, score entries), not new
   transports. The cost is real but bounded — and exactly zero of it is
   spent on capabilities the `custom_*` slot doesn't already provide.
2. **`custom_*` was designed for exactly this case.** Reading the
   custom-support research end-to-end makes the intent explicit: the slot
   exists so users can plug in OpenAI-compatible gateways (OpenRouter, Ollama,
   vLLM, Together, Groq) without bloating the first-class surface. Kilo
   Gateway fits that list.
3. **Quality-first is a load-bearing rule, not a tuning knob.** Promoting any
   provider to unconditional first priority would be the first time the rule
   is broken. Establishing that precedent should require evidence, not a
   hypothesis.
4. **The bench-reorder system is tightly coupled to model identity.** A
   routing model breaks three assumptions simultaneously (stable identity,
   meaningful SWE-bench score, comparable benchmark iterations). Adding it
   requires either lying in `SWE_BENCH_SCORES` or restructuring the ranker.
5. **The user can adopt Kilo today with zero code.** The fastest path to
   validating the "Kilo is fastest" hypothesis is to deploy the action with
   the `custom_*` config above, run the daily benchmark against the Kilo
   endpoint manually, and gather real latency data. If Kilo actually wins,
   the case for first-class promotion becomes evidence-based.

## Historical Context (from prior changes)

- `context/changes/custom-api-support/research.md:175-203` — Existing custom
  slot explicitly targets OpenAI-compatible gateways (OpenRouter, Ollama,
  vLLM, Together, Groq). Kilo Gateway is a peer of these.
- `context/changes/custom-api-support/plan.md:27-33` — The decision to
  exclude `custom_*` from the daily benchmark was deliberate, not an oversight.
  Promoting a specific gateway to first-class is a different conversation.
- `context/changes/mistral-support/research.md:28-33, 226-231` — The Mistral
  promotion rationale required **known model IDs, known scores, and benchmark
  integration.** Kilo Auto has none of these.
- `context/foundation/prd.md:118-127` — Quality-first is a project rule, not
  a default. The user's "fastest-first" framing conflicts with it.

## Open Questions

1. **Is `kilo-auto-efficient` the correct API model ID?** The reviewed Kilo
   docs expose `kilo-auto/frontier|balanced|free|small`. Confirm the exact
   ID before any docs change.
2. **What is the actual latency distribution of Kilo Auto across iterations?**
   No project benchmark data exists. The fastest unblocker is to deploy the
   action with the `custom_*` config and gather real numbers.
3. **Are there plans for a generic `custom_models` (CSV) input?** That
   feature would close the multi-pinned-model gap for every gateway without
   Kilo-specific code.
4. **Are there plans for a generic `custom_headers` input?** That would
   close the Kilo `x-kilocode-mode` gap (and any other gateway's custom
   header) without Kilo-specific code.
5. **Does the team want a daily benchmark job for Kilo specifically?** If
   yes, it would be the third job in `benchmark.yml`, mirroring Mistral —
   but only makes sense if a curated, stable Kilo model list is in scope
   (not the Auto router).

## Follow-up Research 2026-07-20 (post-decision)

### User pushback captured

User: *"I dont know if kilo need to have a benchmark they have auto that routes properly"*

User: *"yes I would like to use kilo 'auto' model as first"*

### Framing correction

The original research treated Kilo Auto's non-determinism as a problem to
solve ("Kilo Auto is a router, so its behavior is non-deterministic and we
need to verify it's actually fast"). The user's correction flips this:

**Kilo Auto's routing IS the value proposition.** Kilo markets Auto as
"Stop choosing models. Start shipping." — routing is what the user is
buying, not a defect. The right model is to treat the gateway as opaque and
trust the vendor, exactly like we trust OpenRouter, Groq, Together, and
Mistral as opaque endpoints. We do not benchmark those gateways either.

### Impact on the recommendation

**None.** The recommendation is reinforced, not weakened. Every Go/No-Go
criterion that turned on "Kilo Auto is a router" was already a reason to
keep it in the custom slot:

| Criterion | Before | After |
|---|---|---|
| Stable model identity | FAIL — Auto changes server-side | (irrelevant) — gateways are opaque by definition |
| Known SWE-bench score | FAIL — router has no score | (irrelevant) — we don't score OpenRouter either |
| Verified "fastest" claim | FAIL — no project data | (irrelevant) — we trust vendor claims for OpenRouter/Groq/Together |
| Curated default fallback list | FAIL — no bounded list | (irrelevant) — gateways expose their own catalogs |
| Dedicated health benchmark | FAIL — no reorder target | (irrelevant) — we don't benchmark gateways, only curated models |

The custom slot is precisely the abstraction for "trust the gateway, no
scoring, no benchmark." Removing the bad-fit criteria leaves the remaining
ones (provider-neutral quality ordering, first-class-when-no-unique-value,
premature provider sprawl) — all of which independently support keeping
Kilo in `custom_*`.

### Updated path forward (no change to user-visible plan)

1. **Confirm the canonical `kilo-auto/*` API model ID** — likely
   `kilo-auto/balanced` or similar. The user's "kilo code auto" phrasing
   matches the `kilo-auto/*` tier family.
2. **Deploy with `custom_*` config** (works today, zero code):
   ```yaml
   custom_api_url: 'https://api.kilo.ai/api/gateway'
   custom_model: 'kilo-auto/<tier>'           # confirm exact tier
   custom_api_key: ${{ secrets.KILOCODE_API_KEY }}
   nim_api_key: ${{ secrets.NIM_API_KEY }}    # safety net
   ```
3. **Add a README docs snippet** under "Custom API Support" titled "Using
   Kilo Gateway" — 5-line change.
4. **Do not add a SWE-bench entry, do not add a daily benchmark job, do not
   add a first-class slot.** Gateways are opaque.
5. **Re-evaluate** only if Kilo ships a non-OpenAI-compatible surface or
   user demand for Kilo-specific behavior (multi-model pin, custom headers)
   emerges that the generic `custom_*` surface can't serve.

## Related Research

- `context/changes/custom-api-support/research.md` — Generic custom provider
  design; defines the slot the user should reuse.
- `context/changes/mistral-support/research.md` — First-class provider
  promotion precedent and criteria.
- `context/changes/daily-benchmark/plan.md` — Bench-driven reorder system;
  explains why first-class needs curated scores.

## Recommendation

**Do not add `kilocode` as a first-class provider slot.**

Instead:

1. **Add a README section** under "Custom API Support" titled "Using Kilo
   Gateway" showing the three-line YAML preset (URL + model + key) and the
   Kilo-first fallback YAML.
2. **Confirm the exact `kilo-auto-efficient` API model ID** before
   documenting it. Kilo's docs surface tier IDs like
   `kilo-auto/frontier|balanced|free|small`; `kilo-auto-efficient` may not
   be the canonical name.
3. **Benchmark Kilo Auto** against the existing NIM/Mistral chain over
   multiple days with the same review prompt. Record median latency,
   variance, error rate, and (if Kilo exposes the routed model in headers or
   response metadata) the downstream model identity distribution.
4. **Re-evaluate first-class promotion only when:**
   - a stable Kilo model contract exists (specific, pinned models with
     IDs + scores),
   - measured latency + quality data beats the existing NIM/Mistral chain,
   - user demand appears that `custom_*` cannot satisfy (e.g., need for
     multiple pinned Kilo models, organization policy, custom headers).

If the team later decides to invest in `custom_*` enhancements
(`custom_models` CSV, `custom_headers`, a generic priority knob, etc.), all
of those improvements benefit every gateway equally — including Kilo —
without committing to a Kilo-specific first-class slot.