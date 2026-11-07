---
id: probe-cap-and-stale-refs
title: "Probe Promotion Cap + Drop Unreferenced Findings"
status: in_progress
created: 2026-08-01
updated: 2026-08-01
type: bugfix
tags: [model-chain, validation, probe, swe-bench, finding-quality]
---

# Probe Promotion Cap + Drop Unreferenced Findings

Two related quality fixes to the review pipeline.

## 1. Probe promotion cap (model-chain.ts)

`probeModels` previously moved the fastest probed model to position 0 of the
chain unconditionally. A provider that happens to answer the probe call faster
than the SWE-sorted head could leapfrog the head, even when its SWE-bench
score was much lower.

Concrete failure: NIM `deepseek-v4-pro` (0.806) is the head after the merged
chain is SWE-sorted, but Mistral's `mistral-medium-3.5` (0.776) frequently
answers the probe call first because Mistral's first-token latency is lower.
The chain ends up trying `mistral-medium-3.5` first, which is the opposite of
what the SWE-bench ordering was supposed to give us.

Fix: introduce `PROBE_PROMOTE_MAX_HEAD_GAP = 0.02`. The fastest probed model
is only eligible for promotion if its SWE-bench score is within 0.02 of the
chain head's score. With the gap 0.030 between `deepseek-v4-pro` and
`mistral-medium-3.5`, the probe win is discarded and the head stays first.
The 0.02 margin exists only to absorb score-table rounding; it is not a real
score threshold.

## 2. Drop unreferenced findings (validation.ts)

`validateCodeContext` previously emitted a soft `Note:` warning when a
finding's backtick-wrapped identifier or explicit `function X` / `variable X`
reference wasn't in the diff, but kept the finding in the output. This
caused re-reviews to "speak about things no longer there" — the model would
reference an identifier from a previous diff iteration or hallucinate one,
the validator would warn, and the finding would still ship to the PR
comment.

Fix: make the behavior opt-out via a new `drop_unreferenced` config input
(default `true`). When enabled, `validateCodeContext` returns `valid: false`
for any finding whose referenced identifier isn't in the diff, and
`validateFindings` drops it with a `Warning:` log. The previous soft-warning
behavior is preserved when `drop_unreferenced: false` is set explicitly.

## 3. Detect contradicted negative claims (validation.ts)

A second hallucination pattern the model produces is the *absence* claim:
"X is used but not imported", "Missing import for X", "X is not defined in
this file". When the named identifier actually IS in the diff, the claim
is a hallucination and the finding should be dropped.

Fix: new `findContradictedNegativeClaims(issue, diff)` runs after the
positive-reference checks. It scans the issue sentence-by-sentence for
absence-claim patterns (`is not imported`, `is not defined`, `missing
import for X`, `is missing from`, `does not exist`, `has not been
defined`, etc.) and, for each backtick-wrapped subject in a sentence
with an absence claim, verifies whether the subject actually appears in
the diff. If it does, the claim is contradicted → drop the finding with
the same `drop_unreferenced` gate.

Sentence-scoping prevents cross-sentence false positives (a backtick ref
in one sentence and an absence claim in another are not paired up).
Bare "is missing" is excluded from the pattern to avoid matching
incompleteness claims like "X is missing retry fields".
