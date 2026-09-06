---
id: eol-model-handling
title: "EOL Model Handling — Dead Models in the Runtime Chain"
status: implementing
created: 2026-09-06
updated: 2026-09-07
type: research
tags: [model-chain, bench-pipeline, eol-models, providers, fallback]
---

# EOL Model Handling — Dead Models in the Runtime Chain

Investigation into why end-of-life models (NIM 410 Gone: `stepfun-ai/step-3.7-flash`,
`nvidia/llama-3.3-nemotron-super-49b-v1(.5)`, `thinkingmachines/inkling`; Mistral 403
`tier_not_allowed`: `mistral-large-2512`) are still attempted by the runtime fallback
chain, and why the probe stage reports "no model available" while the chain keeps
running after individual models report "Done".

Research artifact: [research.md](./research.md)
Frame artifact: [frame.md](./frame.md) — reframed: the gap is the unclosed deadness
loop between the bench push channel (silently broken for pinned @v1 refs) and the
runtime pull side (probe/4xx signal discarded every run), not a missing mechanism.
