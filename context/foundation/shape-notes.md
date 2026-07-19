---
project: "NIM Code Review Action"
context_type: brownfield
created: 2026-07-19
updated: 2026-07-19
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "model selection strategy"
      decision: "hybrid SWE-bench + latency; daily benchmark validates top 7"
    - topic: "benchmark scope"
      decision: "only bench current 7 from action.yml; replace failures from SWE-bench ranked list"
    - topic: "ranking algorithm"
      decision: "effective score = SWE-bench × latency penalty; no historical win tracking needed"
    - topic: "model discovery"
      decision: "new models checked only if they appear in NIM API and have SWE-bench data above current worst"
    - topic: "stats persistence"
      decision: "not needed; action.yml default IS the state"
  frs_drafted: 8
  quality_check_status: accepted
---

# Shape Notes: NIM Code Review Action

## Current System

GitHub Action (`action.yml`, Node.js runtime via `node24`) that performs AI-powered code review on pull requests using NVIDIA NIM API models. The action:

- Takes a PR diff via GitHub API
- Sends it to NIM models with a fallback chain (tries models in order until one succeeds)
- Posts review comments back on the PR
- Supports per-language system prompts (Go, Python, TypeScript, Java, Rust, C++)
- Has a static, hand-curated model list as the default fallback chain

Current tech stack: TypeScript, `@actions/core`, native `fetch`, Node.js test runner, `tsc` + `ncc` for packaging.

## Problem Statement & Motivation

The model fallback chain in `action.yml` is static and hand-curated. Models degrade over time (downtime, slower inference, API changes). New better models appear on NIM regularly. There's no mechanism to:

1. Validate that models in the chain are still alive and performant
2. Automatically promote better models to the front of the chain
3. Detect and replace failed/slow models

**Trigger**: The list was manually curated and has no quality signal backing the order. A model could be down for days before anyone notices.

**Current workaround**: Manual updates when someone notices a model is broken. No data on relative performance.

## Vision

The model fallback chain should be **self-optimizing**: ordered by code review capability (SWE-bench Verified score) with a latency penalty for slow responders. A daily GitHub Actions workflow validates the current top 7 models, replaces any that failed, and commits the updated order. Users of the action always get the best available model first without manual intervention.

## User & Persona

**Primary persona**: Developer who uses this GitHub Action in their repo. They configure `nim_api_key` and expect the action to "just work" with the best available model. They never think about model selection — it's handled for them.

**Secondary persona**: Maintainer of this action repo. They want confidence that the model chain is always optimal without manual monitoring.

## Success Criteria

### Primary
- The top model in the fallback chain is always one of the top 3 SWE-bench Verified scorers available on NIM
- Failed/unavailable models are automatically replaced within 24 hours

### Secondary
- The benchmark completes in under 10 minutes (7 models × 2 iterations)
- No manual intervention needed for model rotation

### Guardrails
- A broken benchmark workflow must NOT corrupt action.yml (no empty model list)
- The action still works if the benchmark hasn't run (static default is valid)
- No API key exposure in logs or commits

## User Stories

### US-01: Daily model validation

- **Given** a scheduled workflow trigger at 06:00 UTC
- **When** the benchmark runs
- **Then** each of the 7 current models is tested with a synthetic code review prompt
- **Then** results are ranked by effective score (SWE-bench × latency penalty)
- **Then** action.yml is updated and committed if the order changed

### US-02: Failed model replacement

- **Given** a model in the current top 7 fails all benchmark iterations
- **When** the benchmark detects the failure
- **Then** it probes the next highest SWE-bench model not in the list
- **Then** if the probe succeeds, the failed model is replaced
- **Then** the new model is benchmarked and ranked into position

### US-03: Action consumer gets best model first

- **Given** a developer uses this action on a PR
- **When** the action runs with default `nim_models`
- **Then** the first model tried is the highest-performing available model per the latest benchmark

## Functional Requirements

- FR-001: System runs a daily benchmark of the current 7 models in action.yml. Priority: must-have
- FR-002: System ranks models by effective score (SWE-bench Verified × latency penalty). Priority: must-have
- FR-003: System replaces failed models with next-best from SWE-bench ranked list. Priority: must-have
- FR-004: System updates action.yml default model list and commits changes. Priority: must-have
- FR-005: System penalizes models with median latency > 60s (linear penalty 60-120s, heavy penalty >120s). Priority: must-have
- FR-006: System skips models that fail all benchmark iterations. Priority: must-have
- FR-007: System can be triggered manually via workflow_dispatch. Priority: nice-to-have
- FR-008: System seeds from SWE-bench top 7 on first run (empty action.yml). Priority: nice-to-have

## Business Logic

The core domain rule: **A model's position in the fallback chain equals its SWE-bench Verified score discounted by a latency penalty, where models responding over 60 seconds are progressively demoted regardless of code quality.**

The latency penalty is:
- ≤ 60s: no penalty (multiplier = 1.0)
- 60–120s: linear penalty (multiplier scales 1.0 → 0.7)
- > 120s: heavy penalty (multiplier = 0.5)

Effective score = SWE-bench score × latency multiplier. Models are sorted descending by effective score; ties broken by raw latency (faster wins).

Dead models (100% error rate) are excluded entirely and replaced by the next available model from the SWE-bench ranked list.

## Constraints & Preserved Behavior

- The action.yml input interface (`nim_models`, `nim_api_key`, etc.) must not change
- Users who override `nim_models` manually are unaffected by the benchmark
- The benchmark workflow is additive — it doesn't touch the review logic
- The existing CI workflow (`ci.yml`) continues to run independently
- The `review.ts`, `index.ts`, `nim-client.ts` core files are not modified by this change

## Access Control Changes

No access control changes. The benchmark uses the same `NIM_API_KEY` secret mechanism. The workflow needs `contents: write` permission (already standard for GitHub Actions that commit).

## Non-Goals

- NOT building a real-time model health dashboard
- NOT implementing A/B testing between models on actual PRs
- NOT benchmarking on real PR diffs (synthetic prompt is sufficient for latency/availability)
- NOT auto-discovering new models without SWE-bench data (unknown quality = not trusted)
- NOT tracking historical win statistics (SWE-bench + latency is sufficient signal)

## Quality cross-check

All signals present:
- ✓ Clear problem statement with trigger
- ✓ One-sentence business rule
- ✓ FR-NNN format requirements (8 FRs)
- ✓ Given/When/Then user stories (3 stories)
- ✓ Success criteria with guardrails
- ✓ Explicit non-goals
- ✓ Constraints preserving backward compatibility

## Forward: tech-stack notes

- Runtime: Node.js 20 (already established)
- Build: tsc + ncc (already established)
- Test: node:test built-in runner (already established)
- CI: GitHub Actions (already established)
- No new dependencies needed — benchmark uses existing `NimClient`
