---
id: parallel-model-review
title: "Parallel Model Review"
status: implemented
created: 2026-08-03
updated: 2026-08-03
type: feature
tags: [model-chain, parallel, latency, documentation]
---

# Parallel Model Review

Frame brief identified that staggered parallel model fallback (`parallel_attempts`/
`parallel_threshold`) is already implemented and opt-in (off by default, default = 1
= sequential). The framing question is whether to build anything new, or to surface
and possibly default the existing feature. See `frame.md` for the full analysis.
