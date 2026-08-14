# Optimize GitHub Workflows — Implementation Plan

## Overview

Harden the 5 daily `benchmark-*.yml` workflows for reliability and apply cheap
runtime trims, **and** extract the duplicated skeleton into a single reusable
`workflow_call` template with 5 thin callers. This plan goes *beyond* the frame
brief (which de-prioritized the reusable-template rewrite): the user explicitly
chose **"Both: trims + template"**, accepting the frame's noted risk-concentration
tradeoff in exchange for de-duplication and a single source of truth for the
commit/retry logic.

## Current State Analysis

- All 5 `benchmark-*.yml` (nim `0 6`, mistral `10 6`, groq `20 6`, openrouter
  `30 6`, kilocode `40 6`) share an identical ~80% skeleton and a single shared
  `concurrency: group: benchmark-commit`, which serializes all five providers
  (~50 min wall-clock despite 10-min-spaced crons).
- `package.json:7` `build` runs `ncc build src/index.ts -o dist/bundle` — the
  action bundle. Benchmark jobs only consume tsc output
  (`node dist/src/bench-entry.js`, `dist/src/bench-reorder.js`), so the ncc step
  is dead work discarded by `git clean -fd` every run.
- The commit/retry block is copy-pasted 5×; a future edit could drift between
  files. `src/bench-reorder.ts:530` (`patchScoresTable`) is the only shared-file
  mutation, run by kilocode + openrouter only — the source of their conflict risk.
- Reliability work already landed: env validation (`7cdfb0d`), rebase guarding
  (`f032d75`), GraphQL retry (`a178802`), rebase-first sync (`087d6a6`). The
  "remaining hardening debt" is verification + a CI guardrail, not new runtime code.
- `ci.yml` (push/PR test) and `ai-review.yml` (consumes published
  `pfrack/review-action@v1`) are orthogonal and must NOT be folded into the
  template or the `build:tsc` change.

### Key Discoveries:

- `src/bench-entry.ts:9-11` `envOrDefault` returns `process.env[key] || def`, so
  forwarding **empty** optional inputs to the template is safe — they fall back to
  built-in defaults (e.g. `BENCH_BASE_URL` → NVIDIA default, `BENCH_CONCURRENCY` → 1).
- A GitHub Actions job can hold **only one** `concurrency` group. To serialize
  kilocode+openrouter while letting nim/mistral/groq run free, those two callers
  share a single `benchmark-reorder` group; the other three get their own groups.
- `npm run package` (`package.json:9`) and `ai-review.yml` still need the ncc
  bundle, so the existing `build` script must stay for the publish path.

## Desired End State

- Benchmark jobs build with `npm run build:tsc` (no ncc), cutting dead work per
  daily run.
- Each provider runs in its own concurrency group; kilocode+openrouter are
  serialized to protect the `src/bench-reorder.ts` patch, cutting wall-clock from
  ~50 min to ~10–15 min.
- One `benchmark-template.yml` (`on: workflow_call`) owns the entire skeleton;
  the 5 `benchmark-*.yml` are thin callers passing provider-specific inputs/secrets.
- `ci.yml` runs `actionlint` so workflow YAML regressions are caught on PR.

## What We're NOT Doing

- Folding `ci.yml` or `ai-review.yml` into the benchmark template.
- Caching `dist/` across runs (deferred — provider API latency dominates runtime;
  revisit only if `tsc` proves slow on the runner).
- Changing benchmark behavior, model lists, or the commit/amend/retry semantics
  (preserved exactly, just centralized).
- Touching the ncc `build`/`package` scripts used by the publish path.

## Implementation Approach

Incremental, independently-verifiable phases: (1) build trim on the existing 5
files, (2) per-provider concurrency on the existing 5 files, (3) extract the
reusable template and rewrite the 5 files as thin callers (subsuming 1–2),
(4) CI `actionlint` + confirm the rebase-first/env-validation hardening already
holds. The template forwards optional inputs as empty strings and relies on
`envOrDefault` fallbacks, avoiding per-provider `env` branching.

## Critical Implementation Details

- **Concurrency grouping**: a job has exactly one `concurrency.group`. Use
  `benchmark-reorder` for **both** kilocode and openrouter callers (serializes
  the two `src/bench-reorder.ts` patchers); `benchmark-nim` / `benchmark-mistral`
  / `benchmark-groq` for the others. Do not attempt two groups on one job.
- **Conditional `git add` in the template**: `src/bench-reorder.ts` is only
  mutated by the `discover_new` patch step (kilocode/openrouter), so it must be
  `git add`ed **only when `inputs.discover_new` is true**; `removed_path` /
  `history_path` are added only when the file exists. The commit message is
  `chore: update ${inputs.provider} model order from daily benchmark`.
- **Gated blocks**: the "Discover new models + patch SWE-bench table" block runs
  `if: ${{ inputs.discover_new }}`; the trailing tag-moving block runs
  `if: ${{ inputs.move_tag }}`. The reorder step always runs (`--two-tier` when
  `inputs.two_tier`). These gates are the non-obvious part other phases depend on:

  ```yaml
  # inside benchmark-template.yml job
  - name: Add new models to SWE-bench table
    if: ${{ inputs.discover_new }}
    run: |
      if [ -s new-models.json ] && [ "$(cat new-models.json)" != "[]" ]; then
        cat new-models.json | node dist/src/bench-reorder.js --patch-scores src/bench-reorder.ts
      else
        echo "No new models to add"
      fi

  - name: Commit updated model order
    if: github.ref == 'refs/heads/main'
    run: |
      git add action.yml
      if [ "${{ inputs.discover_new }}" = "true" ]; then git add src/bench-reorder.ts; fi
      if [ -n "${{ inputs.removed_path }}" ] && [ -f "${{ inputs.removed_path }}" ]; then git add "${{ inputs.removed_path }}"; fi
      if [ -n "${{ inputs.history_path }}" ] && [ -f "${{ inputs.history_path }}" ]; then git add "${{ inputs.history_path }}"; fi
      # ... amend-or-commit + 3x push-retry (unchanged from current per-file logic) ...
  ```

## Phase 1: Add `build:tsc` and switch benchmark jobs to it

### Overview

Eliminate the dead `ncc` bundle from every daily benchmark run by adding a
tsc-only build script and pointing the 5 existing workflows at it.

### Changes Required:

#### 1. Add `build:tsc` script

**File**: `package.json`

**Intent**: Provide a build that produces only the tsc output benchmark jobs
consume, without the ncc action bundle (which only the publish path needs).

**Contract**: Add a sibling script to `build`
(`package.json:7`): `"build:tsc": "tsc && cp -r src/__fixtures__ dist/src/__fixtures__"`.
Leave the existing `build` script unchanged (still used by release/publish).

#### 2. Switch the 5 benchmark jobs to `build:tsc`

**File**: `.github/workflows/benchmark-{kilocode,openrouter,nim,mistral,groq}.yml`

**Intent**: Replace the `npm run build` step in each workflow with
`npm run build:tsc` so the ncc bundle is no longer built per run.

**Contract**: Change the single line `run: npm run build` (present at
`benchmark-kilocode.yml:36`, `benchmark-openrouter.yml:36`, `benchmark-nim.yml:36`,
`benchmark-mistral.yml:36`, `benchmark-groq.yml:36`) to `run: npm run build:tsc`
in all five files.

### Success Criteria:

#### Automated Verification:

- `npm run build:tsc` succeeds and produces `dist/src/bench-entry.js`.
- `npm run build` still succeeds (publish path intact).
- `npm test` passes.

#### Manual Verification:

- `dist/bundle` is NOT produced by `npm run build:tsc` (confirm the dead work is gone).
- A `workflow_dispatch` run of one provider completes and commits as before.

**Implementation Note**: After completing this phase and all automated verification
passes, pause here for manual confirmation from the human that the manual testing
was successful before proceeding to the next phase.

---

## Phase 2: Per-provider concurrency groups

### Overview

Replace the single shared `benchmark-commit` group with per-provider groups so
providers run in parallel, while serializing kilocode+openrouter to protect the
`src/bench-reorder.ts` patch.

### Changes Required:

#### 1. Repoint concurrency groups in the 5 files

**File**: `.github/workflows/benchmark-{kilocode,openrouter,nim,mistral,groq}.yml`

**Intent**: Stop global serialization; let nim/mistral/groq run concurrently, and
serialize only the two providers that patch the shared `src/bench-reorder.ts`.

**Contract**: Change `concurrency.group` (currently `benchmark-commit` at
`benchmark-kilocode.yml:11-13` etc.) as follows:
- kilocode → `benchmark-reorder`
- openrouter → `benchmark-reorder`
- nim → `benchmark-nim`
- mistral → `benchmark-mistral`
- groq → `benchmark-groq`

Keep `cancel-in-progress: false` unchanged in every file.

### Success Criteria:

#### Automated Verification:

- `npx --yes actionlint .github/workflows/benchmark-*.yml` (or local equivalent)
  passes after the change.
- YAML is valid (workflow parses).

#### Manual Verification:

- Confirm kilocode and openrouter cannot overlap (same group) while nim/mistral/groq
  may run simultaneously — inspect run timeline via two `workflow_dispatch` triggers.
- Observe wall-clock drop vs the old serialized run (sanity, not exact).

**Implementation Note**: After completing this phase and all automated verification
passes, pause here for manual confirmation from the human that the manual testing
was successful before proceeding to the next phase.

---

## Phase 3: Extract reusable template + thin callers (DRY)

### Overview

Create `.github/workflows/benchmark-template.yml` (`on: workflow_call`) owning the
entire skeleton (checkout → rebase-first sync → setup-node → `npm ci` →
`build:tsc` → benchmark → show → optional discover/patch → reorder →
commit/retry → optional tag-move), then rewrite the 5 `benchmark-*.yml` as thin
callers passing provider-specific `with:`/`secrets:` and the per-provider
concurrency group.

### Changes Required:

#### 1. Create the reusable template

**File**: `.github/workflows/benchmark-template.yml` (new)

**Intent**: Single source of truth for the benchmark skeleton and the
commit/retry logic, parameterized by provider inputs so the 5 files stop
diverging.

**Contract**: `on: workflow_call` with the following `inputs` (all strings
default `''` unless noted) and one `secrets`:

| Input | Type | Maps to | Default |
| --- | --- | --- | --- |
| `provider` | string | commit-message name | (required) |
| `action_target` | string | `ACTION_TARGET` | (required) |
| `base_url` | string | `BENCH_BASE_URL` | `''` |
| `models` | string | `BENCH_MODELS` | `''` |
| `concurrency` | string | `BENCH_CONCURRENCY` | `''` |
| `removed_path` | string | `REMOVED_MODELS_PATH` | `''` |
| `history_path` | string | `MODEL_HISTORY_PATH` | `''` |
| `scores_file` | string | `BENCH_SCORES_FILE` | `''` |
| `auto_free` | boolean | `BENCH_AUTO_FREE` | `false` |
| `two_tier` | boolean | `--two-tier` reorder flag | `false` |
| `discover_new` | boolean | discover/patch block | `false` |
| `move_tag` | boolean | trailing tag-move block | `false` |

`secrets: { BENCH_API_KEY: { required: true } }`.

Steps mirror the current kilocode skeleton order
(`benchmark-kilocode.yml:19-113`), with these parameterizations:
- Benchmark `run` step `env` sets `BENCH_API_KEY: ${{ secrets.BENCH_API_KEY }}`,
  `BENCH_ITERATIONS: '1'`, `ACTION_TARGET: ${{ inputs.action_target }}`, and the
  optional vars forwarded verbatim (`BENCH_BASE_URL: ${{ inputs.base_url }}`, etc.).
  Empty optionals fall back via `envOrDefault` (bench-entry.ts:9-11).
- Reorder step: `node dist/src/bench-reorder.js${{ inputs.two_tier && ' --two-tier' || '' }} < table.txt`.
- Commit step: `git add action.yml`, then conditionally `src/bench-reorder.ts`
  (when `discover_new`), `removed_path`, `history_path` (when file exists);
  `AMEND_MSG="chore..."` — note actual value is
  `chore: update ${{ inputs.provider }} model order from daily benchmark`.
- Discover/patch block gated `if: ${{ inputs.discover_new }}`; tag-move block
  gated `if: ${{ inputs.move_tag }}` (see Critical Implementation Details snippet).

#### 2. Rewrite the 5 callers as thin `uses:` workflows

**File**: `.github/workflows/benchmark-{kilocode,openrouter,nim,mistral,groq}.yml`

**Intent**: Replace the full job bodies with a `jobs.<name>.uses:` referencing the
template, passing provider inputs/secrets and the per-provider concurrency group.

**Contract**: Each caller becomes:

```yaml
name: Daily Model Benchmark - <Provider>
on:
  schedule: [{ cron: '<existing cron>' }]
  workflow_dispatch: {}
permissions:
  contents: write
jobs:
  benchmark:
    uses: ./.github/workflows/benchmark-template.yml
    concurrency:
      group: <benchmark-reorder | benchmark-nim | benchmark-mistral | benchmark-groq>
      cancel-in-progress: false
    secrets:
      BENCH_API_KEY: ${{ secrets.<PROVIDER_API_KEY> }}
    with:
      provider: <provider>
      action_target: <target>
      base_url: '<url or omitted>'
      auto_free: <true|false>
      two_tier: <true|false>
      discover_new: <true|false>
      move_tag: <true|false>
      removed_path: <path or omitted>
      history_path: <path or omitted>
      scores_file: <path or omitted>
```

Per-provider values (from the current files):

| Provider | cron | group | secret | action_target | auto_free | two_tier | discover_new | move_tag | base_url | removed_path | history_path | scores_file |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| kilocode | `40 6` | benchmark-reorder | KILO_API_KEY | kilocode_models | true | true | true | false | kilo url | removed-kilocode-models.txt | kilocode-model-history.json | fetched-scores.json |
| openrouter | `30 6` | benchmark-reorder | OPENROUTER_API_KEY | openrouter_models | true | true | true | false | openrouter url | removed-openrouter-models.txt | openrouter-model-history.json | fetched-scores.json |
| nim | `0 6` | benchmark-nim | NIM_API_KEY | nim_models | false | false | false | true | (omit) | (omit) | (omit) | (omit) |
| mistral | `10 6` | benchmark-mistral | MISTRAL_API_KEY | mistral_models | false | false | false | true | mistral url | removed-mistral-models.txt | (omit) | (omit) |
| groq | `20 6` | benchmark-groq | GROQ_API_KEY | groq_models | false | false | false | true | groq url | removed-groq-models.txt | (omit) | (omit) |

### Success Criteria:

#### Automated Verification:

- `npx --yes actionlint .github/workflows/*.yml` passes for all workflows.
- `npm run build:tsc` and `npm test` still pass.
- The 5 callers are each ≤ ~25 lines and contain no duplicated step logic.

#### Manual Verification:

- Trigger each of the 5 workflows via `workflow_dispatch`; each completes, commits
  (or reports "No changes"), and kilocode/openrouter never overlap.
- Confirm `action.yml` model-order updates still land for a provider that reorders
  (e.g. nim) and that kilocode/openrouter still patch `src/bench-reorder.ts`.

**Implementation Note**: After completing this phase and all automated verification
passes, pause here for manual confirmation from the human that the manual testing
was successful before proceeding to the next phase.

---

## Phase 4: CI `actionlint` + verify hardening holds

### Overview

Add a workflow YAML lint to `ci.yml` so future template/caller edits are caught
on PR, and confirm the rebase-first + env-validation hardening already in place
needs no further code change.

### Changes Required:

#### 1. Add `actionlint` to CI

**File**: `.github/workflows/ci.yml`

**Intent**: Guard against workflow YAML regressions introduced by the refactor.

**Contract**: Add a `lint` job (or extend the existing `test` job) that runs
`actionlint` over `.github/workflows/*.yml`. Use a maintained action (e.g.
`reviewdog/action-actionlint@v1`); pick the current major version at implement
time. Keep `permissions: contents: read`. The existing `test` job (build + test)
stays intact.

#### 2. Confirm hardening already holds (no code change)

**File**: n/a (verification only)

**Intent**: Close the frame's "address remaining flaky-test/hardening debt" goal
by confirming the prior commits cover it.

**Contract**: Verify `benchmark-template.yml` (or callers) still contains the
rebase-first `Sync with origin/main` step and that `bench-entry.ts` env validation
(`envOrDefault`, required `BENCH_API_KEY`) is intact. Document this in the change
notes; no source edits required.

### Success Criteria:

#### Automated Verification:

- `actionlint` runs and passes in CI on a PR touching workflows.
- `npm test` passes.

#### Manual Verification:

- Open a PR with a trivial workflow edit and confirm `actionlint` fails/passes as
  expected.
- Confirm the rebase-first sync step is present in the template and env validation
  is unchanged in `bench-entry.ts`.

---

## Testing Strategy

### Unit Tests:

- Existing `npm test` suite (no new unit tests; behavior is unchanged).
- Verify `build:tsc` produces `dist/src/bench-entry.js` and `dist/src/bench-reorder.js`.

### Integration Tests:

- `workflow_dispatch` each of the 5 providers end-to-end (real API keys in repo
  secrets) and confirm commit/retry + reorder + patch behavior matches pre-refactor.
- Confirm kilocode/openrouter serialization via overlapping dispatch.

### Manual Testing Steps:

1. `npm run build:tsc` then inspect `dist/` for absence of the ncc `bundle/`.
2. Dispatch all 5 workflows; verify independent commits and no `action.yml` push
   conflict.
3. Dispatch kilocode and openrouter within the same minute; confirm one waits for
   the other (same `benchmark-reorder` group).
4. Open a PR with a broken workflow YAML; confirm `actionlint` flags it.

## Performance Considerations

- Removes one full `ncc` bundle build per daily run (5×/day) — the dominant
  in-repo build cost; provider API latency is unchanged and still dominates.
- Per-provider concurrency cuts wall-clock from ~50 min (serialized) to ~10–15 min
  (parallel, with only kilocode+openrouter serialized).

## Migration Notes

- No data migration. The commit/amend/retry semantics and `force-with-lease`
  push are preserved exactly, just centralized in the template.
- `dist/` remains gitignored-from-commit (wiped by `git clean -fd`); build is
  reproducible per run.

## References

- Frame brief: `context/changes/optimize-gh-workflows/frame.md` (de-prioritized the
  template; user overrode to "Both").
- Research: `context/changes/optimize-gh-workflows/research.md`
- Reference skeleton: `benchmark-kilocode.yml:19-113`
- Env fallback: `src/bench-entry.ts:9-11`
- Shared-file mutation risk: `src/bench-reorder.ts:530`

## Progress

### Phase 1: Add build:tsc and switch benchmark jobs to it

#### Automated

- [ ] 1.1 `npm run build:tsc` produces `dist/src/bench-entry.js`
- [ ] 1.2 `npm run build` (publish path) still succeeds
- [ ] 1.3 `npm test` passes
- [ ] 1.4 All 5 workflows changed `npm run build` → `npm run build:tsc`

#### Manual

- [ ] 1.5 `dist/bundle` absent after `build:tsc`; one `workflow_dispatch` run commits as before

### Phase 2: Per-provider concurrency groups

#### Automated

- [ ] 2.1 `actionlint` passes on the 5 benchmark workflows after group change
- [ ] 2.2 YAML valid / parses

#### Manual

- [ ] 2.3 kilocode+openrouter serialized (same group); others concurrent via dispatch

### Phase 3: Extract reusable template + thin callers

#### Automated

- [ ] 3.1 `actionlint` passes on all workflows
- [ ] 3.2 `build:tsc` + `npm test` pass
- [ ] 3.3 Each caller ≤ ~25 lines, no duplicated step logic

#### Manual

- [ ] 3.4 All 5 dispatch runs complete and commit correctly; k+o never overlap
- [ ] 3.5 nim reorder + k/o `src/bench-reorder.ts` patch still work

### Phase 4: CI actionlint + verify hardening

#### Automated

- [ ] 4.1 `actionlint` runs and passes in CI on a workflow-touching PR
- [ ] 4.2 `npm test` passes

#### Manual

- [ ] 4.3 PR with broken workflow YAML is flagged by `actionlint`
- [ ] 4.4 rebase-first sync step present in template; env validation unchanged in `bench-entry.ts`
