<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Node.js Rewrite

- **Plan**: context/changes/nodejs-rewrite/plan.md
- **Mode**: Deep
- **Date**: 2026-07-19
- **Verdict**: SOUND (after fixes)
- **Findings**: 2 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | PASS |
| Plan Completeness | PASS |

## Grounding
6/6 paths ✓, 3/3 symbols ✓, brief↔plan ✓

## Findings

### F1 — No distribution strategy for dist/ and node_modules/

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Entire plan — no phase addresses this
- **Detail**: GitHub Actions node20 runtime requires compiled JS + dependencies available at the action's path. Plan said "no bundling, raw source distribution" but never explained how dist/ and node_modules/ get to the runner.
- **Fix A ⭐ Applied**: Bundle with @vercel/ncc to produce single dist/index.js. Added ncc to devDependencies, @actions/core to dependencies, scripts.package to build pipeline.
- **Decision**: FIXED (Fix A)

### F2 — Probe-before-review flow missing from Phase 4 entrypoint

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 4 — Action Entrypoint
- **Detail**: Current action.yml probes all models before reviewing, filtering to alive ones. Phase 4 contract never mentioned probing. Implementer would build an action that skips model health checks.
- **Fix**: Added probe step to Phase 4 entrypoint contract — probe all models, filter to alive, fall back to full list, log counts.
- **Decision**: FIXED

### F3 — Prompt files loaded from src/prompts/ but runtime is dist/

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phase 2 — Core NIM Client, prompts.ts contract
- **Detail**: prompts.ts said "Load .txt files from src/prompts/" but at runtime code executes from dist/. Files wouldn't be found.
- **Fix A ⭐ Applied**: Updated contract to use `path.join(__dirname, 'prompts', file)` pattern — ncc detects this and bundles .txt assets into dist/.
- **Decision**: FIXED (Fix A)

### F4 — @actions/core missing from Phase 1 package.json contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Project Scaffolding
- **Detail**: @actions/core was used as runtime import but only devDependencies were listed in Phase 1 contract.
- **Fix**: Already addressed by F1 fix (added dependencies: @actions/core ^1.10.x).
- **Decision**: FIXED (via F1)

### F5 — Phase 3 duplicates Phase 2 test criteria for prompt resolution

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Review Logic, Success Criteria
- **Detail**: "Unit tests pass for prompt resolution" appeared in both Phase 2 and Phase 3. Phase 3's scope is review.ts, not prompts.ts.
- **Fix**: Removed duplicate from Phase 3 Success Criteria and Progress item 3.4. Renumbered remaining manual items.
- **Decision**: FIXED

### F6 — GITHUB_TOKEN passed as env var, not action input

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 4 — Action Entrypoint
- **Detail**: GITHUB_TOKEN is passed as env var (auto-injected), not as an action input. Phase 4 contract said "Read inputs via core.getInput()" which would miss GITHUB_TOKEN.
- **Fix**: Added explicit note to Phase 4 core integration contract distinguishing process.env.GITHUB_TOKEN from core.getInput() inputs.
- **Decision**: FIXED
