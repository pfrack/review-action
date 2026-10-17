# EOL Model Handling — Plan Brief

> Full plan: `context/changes/eol-model-handling/plan.md`
> Frame brief: `context/changes/eol-model-handling/frame.md`
> Research: `context/changes/eol-model-handling/research.md`

## What & Why

The runtime model chain attempts permanently dead models (410 Gone, 403 tier_not_allowed, 413) on every PR because no layer retains or acts on deadness knowledge at the point of use. The bench pipeline's push channel is silently broken for pinned `@v1` consumers (tag frozen, bundle stale 4+ days), and the runtime's pull side observes deadness first-hand every run and throws the signal away — probe result is log-only, errors swallowed, no cross-run learning. Every run pays a fixed probe/timeout tax and degrades to weak fallback models when strong heads are dead.

This plan closes the deadness loop at the point of use: make the runtime act on the 410/403/413 signal it already sees, remove hardcoded EOL fallback lists, and fix the two pipeline gaps that silently break delivery.

## Starting Point

The bench pipeline works (ejected the observed EOL models on 2026-09-03/04) but delivery is broken: `v1` tag frozen at a non-benchmark commit, `dist/bundle/` 4+ days stale, groq bench dead 18 days. Runtime probe (`src/index.ts:485-496`) is vestigial — costs ~90s for 25-model chain, returns pure logging. `probeModel` (`src/openai-client.ts:453-455`) swallows all errors. Hardcoded TS fallbacks (`src/config.ts:69-73`) still list EOL'd Mistral models. `removed-*.txt` files are bench-only; runtime imports zero of them.

## Desired End State

Runtime detects permanent deadness during probe/chat, skips dead models per-run, logs which models were skipped and why. `action.yml` defaults are the single source of truth (no hardcoded fallbacks). Pipeline rebuilds `dist/` automatically and fails loudly (not green) on all-model-fail. Consumers on pinned `@v1` refs get deadness-avoidance from the runtime even if the push channel stays broken.

## Key Decisions Made

| Decision | Choice | Why | Source |
|---|---|---|---|
| Fix locus | Primarily pull (runtime) | Works for all consumers regardless of ref pinning; immune to delivery channel breakage | Plan |
| Deadness action | Skip in current run only | Minimal change; probe already has the signal; no cross-run state | Plan |
| Weak-tail | Accept but surface | No behavior change; transparency helps consumers understand weak reviews | Plan |
| Probe future | Repurpose as deadness detector | Reuses existing infrastructure; 10s probe is cheaper than 90s timeout | Plan |
| Fallback lists | Remove hardcoded | Eliminates drift class; single source of truth = action.yml | Plan |
| Pipeline scope | Stale bundle + groq stall | Addresses "exit green when dead" and bundle staleness — the two silent killers | Plan |
| Observability | Log dead models with reason | Transparency without behavior change | Plan |

## Scope

**In scope:**
- Runtime probe status propagation and chain filtering
- Hardcoded fallback removal
- Pipeline `dist/` auto-rebuild
- All-model-fail non-zero exit
- Dead-model skip logging + winner tier visibility

**Out of scope:**
- Cross-run deadness persistence
- Tag-move guard fix
- Score-table pruning
- Cross-provider ejection
- Parallel winner selection changes
- Retry policy changes
- Fail-loudly on weak-model outcome

## Architecture / Approach

The plan adds a thin avoidance layer at the point of use without changing the "tolerate, don't avoid" philosophy. The probe — currently vestigial — becomes load-bearing: its result (permanent-failure model IDs) feeds into chain filtering before execution. The skip is per-run only, so no persistent state to manage or stale. Pipeline fixes target the two silent-breakage classes (stale bundle, green-on-all-fail) without touching the full delivery channel. Four sequential phases: runtime detection → fallback removal → pipeline reliability → observability.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Runtime Deadness Detection | Probe propagates status, chain skips permanent-fail models | Test-locked chain order (`src/index.test.ts:548`) must not break |
| 2. Remove Hardcoded Fallbacks | `action.yml` becomes single source of truth | Empty-input chains must not crash |
| 3. Pipeline Reliability | `dist/` auto-committed, all-fail exits non-zero | Pipeline workflow changes need manual trigger |
| 4. Observability & Verification | Winner tier logged, EOL test passes | Integration test needs reliable mock for permanent failures |

**Prerequisites:** `npm run typecheck`, `npm test`, `npm run lint` must all pass before starting. Bench workflow access for Phase 3 manual verification.
**Estimated effort:** ~2-3 sessions across 4 phases (Phase 1 is the largest; Phases 2-4 are smaller).

## Open Risks & Assumptions

- The probe's 10s timeout may still classify slow-responding healthy models as permanent-failures if they don't answer "Say hi" in time — need to verify the timeout boundary doesn't cause false skips
- `dist/` commit in pipeline may conflict with concurrent bench runs — needs serialization or force-push semantics
- `@v1` consumers won't get the runtime fix until the tag is manually moved — the plan doesn't solve tag propagation

## Success Criteria (Summary)

- A chain containing known 410/403/413 models skips those models, logs the skip reason, and completes from a healthy model
- Hardcoded fallback lists are gone — empty provider inputs produce shorter chains, not crashes
- Pipeline fails (non-zero exit) when all models in a provider chain fail, instead of exiting green
