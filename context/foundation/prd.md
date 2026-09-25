---
project: "NIM Code Review Action"
version: 1
status: draft
created: 2026-07-19
context_type: brownfield
product_type: api
target_scale:
  users: medium
  qps: low
  data_volume: small
timeline_budget:
  delivery_weeks: 1
  hard_deadline: null
  after_hours_only: true
---

## Current System Overview

GitHub Action that performs AI-powered code review on pull requests using NVIDIA NIM API models. The action takes a PR diff via the GitHub API, sends it to NIM models with a fallback chain (tries models in order until one succeeds), and posts review findings back as a PR comment. Supports per-language system prompts for Go, Python, TypeScript, Java, Rust, and C++.

Tech stack: TypeScript, `@actions/core`, native `fetch`, Node.js 20 runtime (`node24` action runner), Node.js built-in test runner, `tsc` + `ncc` for packaging.

Current user base: developers who install this action in their GitHub repositories. They configure a NIM API key and optionally override the model list. Scale is per-PR invocation — low QPS, small data volume.

Core functionality: receive PR event → fetch diff → send to NIM model for review → post comment. The model fallback chain is the quality-critical path — the order determines which model attempts the review first.

## Problem Statement & Motivation

The model fallback chain is static and hand-curated. Models degrade over time — downtime, slower inference, API deprecations. New higher-quality models appear on NIM regularly. There is no mechanism to validate that models in the chain are still alive and performant, to automatically promote better models to the front of the chain, or to detect and replace failed or slow models.

The trigger is that the list was manually curated with no quality signal backing the order. A model could be down for days before anyone notices. The current workaround is manual updates when someone notices a model is broken — no data on relative performance exists.

## User & Persona

**Primary persona**: A developer who installs this GitHub Action in their repository. They configure `nim_api_key` and expect the action to work with the best available model. They never think about model selection — it is handled for them.

**Secondary persona**: The maintainer of this action repository. They want confidence that the model chain is always optimal without manual monitoring or intervention.

## Success Criteria

### Primary
- The top model in the fallback chain is always one of the top 3 SWE-bench Verified scorers available on NIM
- Failed or unavailable models are automatically replaced within 24 hours

### Secondary
- The benchmark completes in under 10 minutes (7 models × 2 iterations)
- No manual intervention needed for model rotation

### Guardrails
- A broken benchmark workflow must not corrupt action.yml (no empty model list committed)
- The action still works if the benchmark has never run (the static default is a valid fallback chain)
- No API key exposure in logs or commits

## User Stories

### US-01: Daily model validation

- **Given** a scheduled workflow trigger at 06:00 UTC
- **When** the benchmark runs
- **Then** each of the 7 current models is tested with a synthetic code review prompt
- **Then** results are ranked by effective score (SWE-bench × latency penalty)
- **Then** action.yml is updated and committed if the order changed

#### Acceptance Criteria
- All 7 models are tested with identical prompts and parameters
- Results include median latency and tokens/sec for each model
- Commit only happens if the new order differs from the current order

### US-02: Failed model replacement

- **Given** a model in the current top 7 fails all benchmark iterations
- **When** the benchmark detects the failure
- **Then** it probes the next highest SWE-bench model not in the list
- **Then** if the probe succeeds, the failed model is replaced and benchmarked
- **Then** the new model is ranked into position

#### Acceptance Criteria
- Only models with known SWE-bench scores are considered as replacements
- The replacement is probed before being benchmarked (fast fail)
- At most one replacement attempt per failed model per run

### US-03: Action consumer gets best model first

- **Given** a developer uses this action on a PR
- **When** the action runs with default `nim_models`
- **Then** the first model tried is the highest-performing available model per the latest benchmark

#### Acceptance Criteria
- The default model list in action.yml reflects the latest benchmark results
- Users who override `nim_models` manually are completely unaffected

## Scope of Change

- [new] Daily benchmark GitHub Actions workflow (scheduled + manual trigger)
- [new] Benchmark runner script that tests current 7 models with a synthetic prompt
- [new] Reorder script that ranks models by effective score and updates action.yml
- [new] SWE-bench Verified score table mapping NIM model IDs to quality scores
- [new] Latency penalty function (linear 60–120s, heavy >120s)
- [new] Failed model replacement logic (probe + bench next-best from SWE-bench list)
- [modified] action.yml default `nim_models` value — now maintained by the benchmark (was: hand-curated)
- [preserved] All action inputs and their semantics (`nim_api_key`, `nim_base_url`, `nim_models`, `max_files`, `exclude_patterns`, `nim_system_prompt`, `nim_prompt_mode`)
- [preserved] Review logic (`review.ts`, `index.ts`, `nim-client.ts`)
- [preserved] CI workflow (`ci.yml`)
- [preserved] Per-language prompt system

## Constraints & Compatibility

- The action.yml input interface must not change — all existing inputs retain their name, type, and semantics
- Users who override `nim_models` manually are completely unaffected by the benchmark
- The benchmark workflow is additive — it does not modify the review logic or any existing source files beyond action.yml's default value
- The existing CI workflow continues to run independently
- The benchmark commit uses `[skip ci]` to avoid triggering CI on automated model-order updates
- If the benchmark fails entirely (no results), action.yml must remain unchanged (no empty list)

## Business Logic Changes

A model's position in the fallback chain equals its SWE-bench Verified score discounted by a latency penalty, where models responding over 60 seconds are progressively demoted regardless of code quality.

The latency penalty:
- ≤ 60s: no penalty (multiplier = 1.0)
- 60–120s: linear penalty (multiplier scales from 1.0 to 0.7)
- > 120s: heavy penalty (multiplier = 0.5)

Effective score = SWE-bench score × latency multiplier. Models are sorted descending by effective score. Ties are broken by raw latency (faster wins).

Dead models (100% error rate across all iterations) are excluded entirely and replaced by the next available model from the SWE-bench ranked list that responds to a probe.

## Access Control Changes

No access control changes — current model preserved. The benchmark uses the same `NIM_API_KEY` secret mechanism already established for the review action. The workflow requires `contents: write` permission to commit updated action.yml.

## Non-Goals

- Not building a real-time model health dashboard — daily validation is sufficient
- Not implementing A/B testing between models on actual PRs — adds complexity without clear user value
- Not benchmarking on real PR diffs — a synthetic prompt is sufficient for latency and availability validation
- Not auto-discovering new models without SWE-bench data — unknown quality models are not trusted in the fallback chain
- Not tracking historical win statistics — SWE-bench score plus today's latency is a sufficient ranking signal
- Not modifying the core review logic — this change is purely about model selection order

## Open Questions

No open questions. All design decisions resolved during shaping.
