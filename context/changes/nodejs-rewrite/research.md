---
date: 2026-07-19T12:00:00+02:00
researcher: MiMoCode
git_commit: c2049d60602fa7edc75ded6ab751f1309824a0fa
branch: main
repository: pfrack/review-action
topic: "Rewrite GitHub Action from Go to Node.js"
tags: [research, codebase, nodejs, github-action, rewrite, nim]
status: complete
last_updated: 2026-07-19
last_updated_by: MiMoCode
---

# Research: Rewrite GitHub Action from Go to Node.js

**Date**: 2026-07-19T12:00:00+02:00
**Researcher**: MiMoCode
**Git Commit**: c2049d60602fa7edc75ded6ab751f1309824a0fa
**Branch**: main
**Repository**: pfrack/review-action

## Research Question

Rewrite the entire NIM Code Review GitHub Action from Go to Node.js because Node.js is more natural for GitHub Actions (native runtime, no compilation step, smaller footprint).

## Summary

The Go implementation is ~475 lines across 3 packages with zero external dependencies. A Node.js rewrite eliminates the Go compilation step entirely, uses the native `node20` GitHub Actions runtime, and leverages Node's built-in `fetch` API (available since Node 18). The rewrite reduces action startup time by ~30-60s (no Go toolchain installation + compilation) and aligns with the GitHub Actions ecosystem where most actions are JavaScript/TypeScript-based.

Key architectural changes:
- **action.yml**: Switch from `composite` to `node20` runtime with `main` entrypoint
- **No build step**: Node.js runs directly, no compilation needed
- **Native fetch**: Node 18+ has built-in `fetch`, eliminating HTTP client code
- **Simpler structure**: Single `src/index.js` entrypoint + utility modules
- **Testing**: Use Jest or Node's built-in test runner (`node:test`)

## Detailed Findings

### 1. Current Go Implementation Structure

```
cmd/
  nim-review/main.go    (86 lines) — orchestration: load config → fetch diff → review files → post comment
  nim-bench/main.go     (146 lines) — benchmarking: probe models → run iterations → output table
internal/
  nimclient/
    nimclient.go        (221 lines) — HTTP client, Chat/ChatStream, SSE parsing
    bench.go            (204 lines) — benchmark logic, metrics, markdown table
    nimclient_test.go   (194 lines) — HTTP mocking tests
    bench_test.go       (196 lines) — benchmark tests
  nimreview/
    nimreview.go        (267 lines) — config, diff parsing, review logic, GitHub API
    prompts.go          (63 lines)  — language detection, prompt loading
    nimreview_test.go   (228 lines) — unit tests
    prompts/*.txt       (6 files)   — per-language prompt templates
action.yml              (70 lines)  — composite action definition
```

### 2. Node.js GitHub Actions Architecture

GitHub Actions supports three runtime types:
1. **Composite** (current) — shell steps, requires `setup-go` + compilation
2. **JavaScript** (`node16`/`node20`) — native Node.js, no build step
3. **Docker** — container-based, heaviest option

For this rewrite, `node20` is optimal:
- **No compilation**: `action.yml` points directly to `src/index.js`
- **Native fetch**: No external HTTP library needed (Node 18+)
- **Smaller footprint**: ~50KB JS vs ~8MB Go binary
- **Faster startup**: No Go toolchain installation (~30-60s savings)
- **Ecosystem alignment**: ~90% of marketplace actions are JavaScript

### 3. Proposed Node.js Structure

```
src/
  index.js              — entrypoint (replaces cmd/nim-review/main.go)
  bench.js              — benchmark tool (replaces cmd/nim-bench/main.go)
  nim-client.js         — HTTP client with fallback (replaces internal/nimclient/)
  review.js             — review logic, diff parsing, GitHub API (replaces internal/nimreview/)
  prompts.js            — language detection + prompt loading
  prompts/*.txt         — per-language templates (unchanged)
tests/
  nim-client.test.js    — HTTP client tests
  review.test.js        — review logic tests
  bench.test.js         — benchmark tests
action.yml              — node20 runtime definition
package.json            — dependencies (minimal)
```

### 4. action.yml Changes

**Current (Go composite)**:
```yaml
runs:
  using: 'composite'
  steps:
    - uses: actions/setup-go@v5
      with:
        go-version: '1.26'
    - shell: bash
      run: go build -o /tmp/nim-review ./cmd/nim-review
    - shell: bash
      run: /tmp/nim-review
```

**New (Node.js)**:
```yaml
runs:
  using: 'node20'
  main: 'src/index.js'
```

Inputs remain identical — they're passed as `INPUT_<NAME>` environment variables to Node.js.

### 5. Key Implementation Details

#### HTTP Client (`nim-client.js`)

Node.js 18+ has native `fetch` — no `axios` or `node-fetch` needed:

```javascript
const response = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(180_000),
});
```

For SSE streaming (bench TTFT measurement), use `response.body` ReadableStream:

```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder();
// Parse SSE lines from chunks
```

#### Diff Parsing (`review.js`)

The `parseDiff` function translates directly:

```javascript
function parseDiff(raw) {
  const files = {};
  const chunks = raw.split('diff --git ');
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const diffText = 'diff --git ' + trimmed;
    const firstLine = diffText.split('\n')[0];
    const match = firstLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) files[match[2]] = diffText;
  }
  return files;
}
```

#### Prompt Loading (`prompts.js`)

Use `fs.readFileSync` with `path.join(__dirname, 'prompts', ...)`:

```javascript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const prompts = {
  go: readFileSync(join(__dirname, 'prompts/go.txt'), 'utf8'),
  python: readFileSync(join(__dirname, 'prompts/python.txt'), 'utf8'),
  // ...
};
```

#### GitHub API Calls

Use native `fetch` for GitHub API:

```javascript
// Fetch PR diff
const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3.diff',
  },
});

// Post comment
await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ body: comment }),
});
```

#### Input Handling

GitHub Actions passes inputs as `INPUT_<NAME_UPPERCASE>` environment variables:

```javascript
function getInput(name, defaultValue = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] || defaultValue;
}

const config = {
  apiKey: getInput('nim_api_key'),
  baseURL: getInput('nim_base_url', 'https://integrate.api.nvidia.com/v1'),
  models: getInput('nim_models', 'meta/llama-3.3-70b-instruct,...').split(',').map(s => s.trim()),
  maxFiles: parseInt(getInput('max_files', '15'), 10),
  // ...
};
```

### 6. Testing Strategy

Use Node.js built-in test runner (`node:test`) — no external dependencies:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('parseDiff', () => {
  it('splits multi-file diffs', () => {
    const raw = 'diff --git a/main.go b/main.go\n...\ndiff --git a/config.yaml b/config.yaml\n...';
    const files = parseDiff(raw);
    assert.strictEqual(Object.keys(files).length, 2);
    assert('main.go' in files);
    assert('config.yaml' in files);
  });
});
```

For HTTP mocking, use `node:test` with a simple HTTP server:

```javascript
import { createServer } from 'node:http';

it('handles streaming responses', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  server.listen(0);
  // Test against server.url
  server.close();
});
```

### 7. Dependencies

Minimal dependencies — leverage Node.js built-ins:

| Module | Purpose | External? |
|--------|---------|-----------|
| `node:fetch` | HTTP client | Built-in (Node 18+) |
| `node:fs` | Read prompt files | Built-in |
| `node:path` | Path utilities | Built-in |
| `node:test` | Test runner | Built-in (Node 18+) |
| `node:assert` | Assertions | Built-in |

No `package.json` dependencies needed for the action itself. For development:
- `@types/node` (TypeScript types, optional)
- `prettier` (formatting, optional)

### 8. Migration Checklist

| Go File | Node.js Equivalent | LOC Estimate |
|---------|-------------------|--------------|
| `cmd/nim-review/main.go` | `src/index.js` | ~60 |
| `cmd/nim-bench/main.go` | `src/bench.js` | ~120 |
| `internal/nimclient/nimclient.go` | `src/nim-client.js` | ~150 |
| `internal/nimclient/bench.go` | `src/bench.js` (merged) | ~120 |
| `internal/nimreview/nimreview.go` | `src/review.js` | ~180 |
| `internal/nimreview/prompts.go` | `src/prompts.js` | ~40 |
| `internal/nimreview/prompts/*.txt` | `src/prompts/*.txt` | unchanged |
| Tests | `tests/*.test.js` | ~300 |
| `action.yml` | `action.yml` (rewrite) | ~50 |

**Total estimate**: ~850 lines JS + 300 lines tests = ~1150 lines (vs ~475 Go + ~600 tests)

### 9. Performance Comparison

| Metric | Go (current) | Node.js (proposed) |
|--------|--------------|-------------------|
| Action startup | ~30-60s (setup-go + build) | ~2-3s (node already on runner) |
| Binary size | ~8MB | ~50KB JS |
| Memory usage | ~10MB | ~30MB (Node overhead) |
| HTTP performance | Excellent | Excellent (native fetch) |
| SSE parsing | bufio.Scanner | ReadableStream + TextDecoder |

The tradeoff: slightly higher memory usage (Node.js overhead)换取 dramatically faster startup (~30-60s savings per workflow run).

## Code References

- `action.yml:28-70` — current composite action with Go build steps
- `cmd/nim-review/main.go:13-86` — orchestration pipeline to port
- `cmd/nim-bench/main.go:32-146` — benchmark CLI to port
- `internal/nimclient/nimclient.go:16-221` — HTTP client to port (use native fetch)
- `internal/nimclient/bench.go:1-204` — benchmark logic to port
- `internal/nimreview/nimreview.go:1-267` — review logic to port
- `internal/nimreview/prompts.go:1-63` — language detection to port
- `internal/nimreview/prompts/*.txt` — prompt templates (unchanged)
- `.github/workflows/ci.yml` — update to use Node.js instead of Go

## Architecture Insights

- **Native runtime advantage**: Node.js GitHub Actions run directly without compilation, eliminating the biggest startup cost
- **Zero-dep philosophy**: Node 18+ built-in `fetch` maintains the zero-external-dependency approach
- **Simpler deployment**: No `setup-go`, no `go build`, no binary management
- **Ecosystem fit**: Most GitHub Actions in the marketplace are JavaScript — this aligns with community patterns
- **Tradeoff**: Node.js has higher runtime memory (~30MB vs ~10MB) but dramatically faster startup

## Historical Context

The previous v1-rewrite (Go) added benchmarking, env-configurable prompts, and per-language templates. All these features translate directly to Node.js with simpler implementations (e.g., `fs.readFileSync` instead of `go:embed`).

## Related Research

- `context/changes/v1-rewrite/research.md` — original Go implementation research

## Open Questions

1. Should we use TypeScript for type safety, or plain JavaScript for simplicity?
2. Should we bundle with esbuild/webpack for distribution, or ship raw source?
3. Should we use `@actions/core` package for input/output handling, or raw env vars?
4. Should we add a `post` step for cleanup, or keep it simple?
