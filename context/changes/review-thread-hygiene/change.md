---
change_id: review-thread-hygiene
created: 2026-08-03
updated: 2026-08-03
status: implemented
title: "Configurable inline mode with auto-resolve of outdated threads + previous-finding context"
---

# Change: review-thread-hygiene

Supersedes the abandoned `always-comment-in-review` change (still in
`preparing` status since 2026-07-25) by reframing it as opt-in inline
mode with the hygiene needed to make re-review safe.

## Locked decisions (post-frame)

- `comment_mode: summary | inline` action input (default `summary`).
- On re-review in inline mode: list threads via GitHub GraphQL and
  resolve any where `isOutdated === true`. Use GitHub's own signal;
  no custom content-similarity matching.
- Carry-over context (Q4): include unresolved previous findings in the
  new model prompt, capped for token budget.
- No sentinel comments — third-party-action UX anti-pattern.
- Non-outdated thread resolution is left to humans via the GitHub UI.
- All security hardening from `parallel-review-security` must be
  preserved; carry-over text goes through the same escaping pipeline.

See `frame.md` for the full framing analysis and reasoning.