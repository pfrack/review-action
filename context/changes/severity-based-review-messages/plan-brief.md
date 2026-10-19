# Severity-Based Review Messages — Plan Brief

> Full plan: `context/changes/severity-based-review-messages/plan.md`
> Research: `context/changes/severity-based-review-messages/research.md`

## What & Why

`review-action` currently renders every finding as an identical flat bullet with `- **Severity:** ${f.severity}` ([`src/review.ts:153`](src/review.ts#L153)) — Critical release blockers, Warning investigations, and Suggestion nits all look the same on a PR. This plan differentiates the rendered comment by severity (Option C, the heaviest design from the research), grouping findings into priority buckets with semantic markdown each and adding the structured fields the model needs to write severity-specific action lines.

## Starting Point

Per the research:

- A 3-tier severity enum lives at [`src/review-schema.ts:5`](src/review-schema.ts#L5) (Zod) and [`src/review-schema.ts:33`](src/review-schema.ts#L33) (hand-written JSON Schema) with `additionalProperties: false` enforcing strict shape — but only the enum, no per-severity data fields.
- Renderer is severity-blind: groups by file, not severity; no emojis, tally, or sub-lines.
- Prompts contain zero severity-tone guidance.
- The `append` / `replace` prompt-mode bug collapses both via `config.systemPrompt || BASE_SYSTEM_PROMPT` at `src/index.ts:139,170`.
- Tests are substring-based except for the file-order assertion at `src/review.test.ts:295-310`.

## Desired End State

After this plan, every model response carries `critical_action`, `warning_action`, and `suggestion_action` strings for every finding. The PR comment groups findings into `### 🚨 Critical (n)` / `### ⚠️ Warning (n)` / `### 💡 Suggestion (n)` sections in priority order (empty buckets hidden), keeps `**File:**` headers alphabetical within each section, and renders the matching-severity `*_action` as a `**Must-fix:**` / `**Investigate:**` / `**Nit:**` sub-line. The header gets a tally line. `nim_prompt_mode: append` actually appends; users in `replace` mode see only their custom prompt. `README.md`, `action.yml`, and the bundle are refreshed.

## Key Decisions Made

| Decision                       | Choice            | Why (1 sentence)  | Source |
| ------------------------------ | ----------------- | ----------------- | ------ |
| Design option                  | C (Heavy — 3 new schema fields) | Maximum differentiation between severities, structured for downstream tooling, supports per-severity action language. | Plan |
| Field names                    | `critical_action` / `warning_action` / `suggestion_action` | Verb-led, semantic, matches research Option C skeleton. | Plan |
| Field typing                   | Required `string` (non-nullable) | Forces model to commit to a concrete next step on every finding; matches the "blocking" framing. | Plan |
| Grouping in renderer           | Severity-priority buckets, files alphabetical within each | Most visible severity signal; deterministic; preserves existing test order semantically (within Warning/Suggestion buckets, `a.ts` still leads). | Plan |
| Empty-bucket policy            | Hide entirely — skip zero-severity sections and zero-count tally entries | Quietest comment; no surprise diff churn on clean PRs. | Plan |
| Missing-action rendering       | Skip the sub-line entirely (graceful) | Backward-compat safety net even though schema is required; cheap to implement. | Plan |
| Prompt guidance level          | Per-field explicit instructions in BASE_SYSTEM_PROMPT + all 6 language prompts | Maximises consistency across providers; aligns with research Option C text. | Plan |
| Append/replace fix scope       | In scope — fix real merge semantics at `src/index.ts:139,170` | Replace-mode users otherwise silently lose the new guidance; user explicitly chose to absorb the surface area. | Plan |
| Docs scope                     | In scope — refresh `README.md` + `action.yml` descriptions | Users discover new fields and rendering without reading the source. | Plan |
| Test strategy                  | Add 1 snapshot/golden test for full markdown + content test for prompt wording | Locks structure that current substring assertions don't catch. | Plan |
| Fixture migration              | In-place — `fixture-valid-complete.json` and `fixture-valid-minimal.json` gain the 3 new fields | Avoids parallel-fixture drift; minimal cost. | Plan |

## Scope

**In scope:**
- 3 new required string fields on `ReviewFinding`.
- Renderer refactor in `src/review.ts:renderReview` (severity-bucketed).
- New `severityTally()` helper exported from `src/review.ts`.
- Header assembly update at `src/index.ts:208-225`.
- Real append semantics at `src/index.ts:139,170`.
- Fixture migration (`fixture-valid-complete.json`, `fixture-valid-minimal.json`).
- Schema / prompt / renderer / index integration tests.
- 1 snapshot test for full markdown rendering.
- 1 prompt-content test locking the new severity guidance.
- `README.md` and `action.yml` updates.
- `npm run build` to regenerate `dist/bundle/index.js`.

**Out of scope:**
- Adding a 4th severity tier (e.g., `Blocker`, `Major`).
- Computing severity counts from the LLM's `summary` string — renderer derives counts from `findings`.
- Changing `postComment` update logic at [`src/review.ts:216-313`](src/review.ts#L216-L313) — already-posted comments get replaced on next re-run because the marker invariant is preserved.
- Activating `src/prompts.ts` language specialisation at runtime — it stays dormant dead code (the new guidance is mirrored in all 6 prompts forward-looking).
- New schema discriminators (`meta.display`, `category`, etc.) — a separate change if ever pursued.
- Changing diff-fetching, retry, model-chain ordering, or model scoring.

## Architecture / Approach

Three independent surfaces coordinate: the schema (model contract), the prompt (LLM-side enforcement), the renderer (PR-comment-side enforcement). Schema lands first because everything downstream compiles against it; prompt lands second because the new fields are referenced in the new guidance; renderer and integration land last because they consume both.

```
┌─ model response (JSON) ────────────────────────────┐
│  findings[]:                                        │
│    file, severity, line_*, issue, suggestion,       │
│    critical_action, warning_action, suggestion_action│
└────────────────────────────────────────────────────┘
                       │ safeParse (schema)
                       ▼
┌─ renderer (src/review.ts:renderReview) ─────────────┐
│  bucket by severity (Critical → Warning → Suggestion)│
│    skip empty buckets                                │
│  within bucket: sort files alphabetically            │
│  per finding: bullet + line range + issue +          │
│               matching *_action sub-line (graceful)  │
└────────────────────────────────────────────────────┘
                       │ severityTally()
                       ▼
┌─ index.ts header (src/index.ts:209) ────────────────┐
│  ### AI Code Review     <- marker stays literal       │
│  Model: ...                                          │
│  🚨 X criticals · ⚠️ Y warnings · 💡 Z suggestions  │
│  --- bucketed body ---                              │
└────────────────────────────────────────────────────┘
```

## Phases at a Glance

| Phase     | What it delivers       | Key risk                  |
| --------- | ---------------------- | ------------------------- |
| 1. Schema | `ReviewFinding` gains 3 required action fields; hand-written JSON Schema mirrored; fixtures + schema tests migrated. | Dual Zod/JSON sync per `src/review-schema.ts:21-23`; fixture breakage if a required field is forgotten. |
| 2. Prompt | `BASE_SYSTEM_PROMPT` and 6 language prompts carry explicit per-field instructions; `SEVERITY_GUIDANCE` extracted to module constant; content test locks wording. | Replace-mode users won't see the guidance until Phase 4 ships; the new fields are required, so responses without them cause safeParse rejection unless the prompt reliably fills `"not applicable"`. |
| 3. Renderer | Severity-bucketed `renderReview()` + `severityTally()` + 1 snapshot test + adjusted file-order test. | Stability across re-runs (sort order discipline); graceful empty-action handling. |
| 4. Integration | Header tally wired into `src/index.ts:209-225`; real append semantics at `src/index.ts:139,170`; `README.md` + `action.yml` refreshed; bundle regenerated. | `append` / `replace` mode change is observable to replace-mode users (was bug-as-feature, becomes correct behavior). |

**Prerequisites:** Working tree on `feature/model-recheck`; `npm install` already run; `dist/bundle/index.js` regenerated via `npm run build` at end of Phase 4.

**Estimated effort:** 4 phases, ~3-5 sessions. The schema work (Phase 1) is the riskiest single phase; everything else is mechanical once Phase 1 lands.

## Open Risks & Assumptions

- **Required-vs-placeholder contradiction**: the chosen "required strings" + "populate matching, leave others null" prompt instruction is internally inconsistent. The plan resolves this by having the prompt instruct the model to emit `"not applicable"` for non-matching severities — fulfilling both the required-string schema contract and the "leave meaningless content out" rendering intent. If the user prefers truly nullable fields instead, the schema would change to `z.string().nullable().optional()` for the two non-matching fields (cosmetic — the renderer already handles null gracefully).
- **`prompts.ts` language prompts are dormant at runtime** today; mirroring the guidance there is forward-looking, not load-bearing.
- **Replace-mode behavior change**: users who have been silently relying on the broken "append == replace" behavior will now see the default appended. This is a fix, but it's observable — flag in the changelog.

## Success Criteria (Summary)

- A multi-severity PR renders with priority-ordered emoji headers, an at-a-glance tally, and matching-severity action sub-lines on every finding.
- `nim_prompt_mode: append` users receive the severity guidance appended to their custom prompt; `replace` users receive only their custom prompt.
- All existing tests still pass with adjustments limited to the file-order test; new tests lock in the new rendering shape and the new prompt content.
- `dist/bundle/index.js` regen produces a bundle containing the new emoji glyphs and field names, validated by a single `grep` check.
