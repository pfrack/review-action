---
change_id: bench-ejects-best-models
title: "Frame: why only mistral-medium-3.5 reviews — bench ejected high-SWE NIM models"
status: archived
created: 2026-08-06
updated: 2026-08-10
archived_at: 2026-08-10T18:34:47Z
---

# Bench Ejects Best Models

Framing change. The user observed only `mistral-medium-3.5` doing PR reviews and
believed the system "favors faster models." Investigation shows speed is NOT the
current driver — the runtime probe is log-only / cap-gated, already fixed via
`probe-cap-and-stale-refs`. The real cause is that the daily benchmark
(commit `e8f50b4`) ejected the highest-SWE NIM models — `deepseek-v4-pro`
(0.806), `minimax-m3` (0.805), `glm-5.2` (0.778) — from `action.yml` into
`removed-models.txt`, despite all three still being published on NIM. With them
gone, `mistral-medium-3.5` (0.776) is the legitimate highest-SWE provider model
in the merged NIM+Mistral chain and always succeeds.

See `context/changes/bench-ejects-best-models/frame.md`.

## Related prior changes (do not duplicate)

- `probe-cap-and-stale-refs` — already fixed the "faster probe leapfrogs SWE
  head" bug (`PROBE_PROMOTE_MAX_HEAD_GAP=0.02` at `model-chain.ts:12`; probe is
  now log-only). This is what the user's "faster models favored" theory recalls,
  but it is NOT the current cause.
- `review-speed` (planned) — about probe LATENCY tax; a distinct concern.
- `daily-benchmark` — parent feature: the benchmark/reorder system itself.
