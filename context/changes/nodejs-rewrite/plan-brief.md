# Node.js Rewrite — Plan Brief

> Full plan: `context/changes/nodejs-rewrite/plan.md`
> Research: `context/changes/nodejs-rewrite/research.md`

## What & Why

Rewrite the NIM Code Review GitHub Action from Go to Node.js (TypeScript). The current Go version requires a compilation step (~30-60s overhead per workflow run) and uses a composite action. Node.js is the native GitHub Actions runtime — switching eliminates compilation, aligns with ecosystem conventions, and simplifies development.

## Starting Point

A working Go action (~475 lines) with: HTTP client with SSE streaming, per-language prompt templates (6 languages), env-configurable prompts, model fallback chain, and a benchmark tool. All tests pass. Zero external dependencies.

## Desired End State

TypeScript source in `src/`, compiled to `dist/` via `tsc`. action.yml uses `node20` runtime. Full feature parity with Go version. All Go files removed. CI runs TypeScript + node:test. README updated for Node.js development.

## Key Decisions Made

| Decision | Choice | Why |
|----------|--------|-----|
| Language | TypeScript | Type safety, better IDE support, catches errors early |
| Distribution | @vercel/ncc bundle (single dist/index.js) | Standard for GitHub Actions; no node_modules to commit |
| Build | tsc (TypeScript compiler) | No extra dependencies, comes with typescript package |
| Input handling | @actions/core | Standard GitHub Actions pattern, handles edge cases |
| Testing | node:test | Zero dependencies, built-in, sufficient for this project |
| Benchmark | Full port | Maintain feature parity with Go version |

## Scope

**In scope:**
- TypeScript rewrite of all Go modules
- Build pipeline (tsc → dist/)
- action.yml conversion to node20
- All existing features (review, fallback, prompts, bench)
- Unit tests matching Go coverage
- CI workflow update
- README update

**Out of scope:**
- Bundling (esbuild/webpack)
- Runtime TypeScript loaders
- New features beyond Go version
- Keeping Go files

## Architecture / Approach

```
src/
  index.ts        — action entrypoint (orchestration)
  nim-client.ts   — HTTP client with fallback + SSE streaming
  review.ts       — diff parsing, GitHub API, review logic
  prompts.ts      — language detection + prompt loading
  prompts/*.txt   — per-language templates (unchanged)
  bench.ts        — benchmark logic + metrics
  bench-entry.ts  — standalone benchmark CLI
dist/             — compiled JS output
```

action.yml: `runs: { using: 'node20', main: 'dist/index.js' }`

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Scaffolding | Build pipeline works | None — foundation only |
| 2. NIM client | HTTP + streaming | SSE parsing edge cases |
| 3. Review logic | Diff parsing + GitHub API | Pattern matching correctness |
| 4. Action entrypoint | Working action | Input handling integration |
| 5. Benchmark | Full bench tool | Metrics accuracy |
| 6. Tests | Test coverage | Matching Go behavior |
| 7. CI & cleanup | Production ready | Go file removal |

**Prerequisites:** None — starts from clean state
**Estimated effort:** ~2-3 sessions across 7 phases

## Open Risks & Assumptions

- Node 20 on GitHub Actions runners has native fetch (confirmed — Node 18+)
- @actions/core input names must match Go version exactly (nim_api_key, etc.)
- SSE parsing via ReadableStream may have edge cases vs Go's bufio.Scanner

## Success Criteria (Summary)

- `npm run build && npm test` passes locally
- CI passes on GitHub Actions
- Action produces same output as Go version on test PR
- All Go files removed, no references remain
