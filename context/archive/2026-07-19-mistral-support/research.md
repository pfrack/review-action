---
date: 2026-07-19T22:36:31+02:00
researcher: kiro
git_commit: 1d38e2d03591997789d260a9f142d2cacd4459f0
branch: main
repository: review-action
topic: "First-class Mistral API support with MISTRAL_API_KEY"
tags: [research, codebase, mistral, nim-client, bench, swe-bench, action-inputs]
status: complete
last_updated: 2026-07-19
last_updated_by: kiro
---

# Research: First-Class Mistral API Support

**Date**: 2026-07-19T22:36:31+02:00
**Researcher**: kiro
**Git Commit**: 1d38e2d03591997789d260a9f142d2cacd4459f0
**Branch**: main
**Repository**: review-action

## Research Question

How to add Mistral as a first-class supported provider with its own `MISTRAL_API_KEY` input, integrated into the benchmark and SWE-bench scoring systems — tried first before the NIM fallback chain.

## Summary

Mistral gets a dedicated `mistral_api_key` action input (+ optional `mistral_model`). When provided, the action creates a second `NimClient` pointed at `https://api.mistral.ai/v1` and tries Mistral first. The benchmark system also gains the ability to score Mistral direct API models via their native model IDs.

This is **separate from the generic custom API feature** — Mistral is a known provider with:
- A fixed base URL (`https://api.mistral.ai/v1`)
- Known model IDs with known SWE-bench scores
- First-class bench integration

## Detailed Findings

### 1. Mistral API Compatibility

| Property | Value |
|----------|-------|
| Base URL | `https://api.mistral.ai/v1` (hardcoded, not user-configurable) |
| Auth | `Bearer <MISTRAL_API_KEY>` |
| Protocol | OpenAI-compatible `/v1/chat/completions` |
| Streaming | SSE, same as OpenAI |

The existing `NimClient` class works with zero modifications — just a different `baseURL` and `apiKey`.

### 2. Mistral Model IDs (Direct API)

| Model ID | Alias | SWE-bench Score | Notes |
|----------|-------|-----------------|-------|
| `mistral-medium-3.5` | `mistral-medium-latest` | 0.776 | Frontier 128B, 256k ctx, best for code review |
| `mistral-large-2512` | `mistral-large-latest` | 0.720 | MoE 675B |
| `mistral-small-2603` | `mistral-small-latest` | 0.680 | Efficient hybrid |
| `codestral-2508` | `codestral-latest` | ~0.650 | Code specialist |

### 3. NIM vs Direct Model ID Mapping

Currently `SWE_BENCH_SCORES` uses NIM-proxy IDs:

```
mistralai/mistral-medium-3.5-128b: 0.776    → direct: mistral-medium-3.5
mistralai/mistral-large-3-675b-instruct-2512: 0.720 → direct: mistral-large-2512
mistralai/mistral-small-4-119b-2603: 0.680   → direct: mistral-small-2603
mistralai/mistral-nemotron: 0.720            → (NIM-only, no direct equivalent)
```

### 4. Proposed New Inputs for `action.yml`

```yaml
mistral_api_key:
  description: 'Mistral API key (enables Mistral as primary model, tried before NIM)'
  default: ''
mistral_model:
  description: 'Mistral model to use (default: mistral-medium-3.5)'
  default: 'mistral-medium-3.5'
```

Only **two inputs** — the base URL is hardcoded since this is a first-class integration, not a generic endpoint.

### 5. Implementation Strategy

**Config changes** (`src/review.ts`):

```typescript
export interface Config {
  // Existing fields...
  baseURL: string;
  apiKey: string;
  models: string[];
  maxFiles: number;
  excludePatterns: string[];
  systemPrompt: string;
  promptMode: string;
  // Mistral fields
  mistralApiKey: string;
  mistralModel: string;
}
```

Add to `loadConfig()`:
```typescript
mistralApiKey: core.getInput('mistral_api_key') || '',
mistralModel: core.getInput('mistral_model') || 'mistral-medium-3.5',
```

**Main logic changes** (`src/index.ts`):

```typescript
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';

// Try Mistral FIRST if configured
if (config.mistralApiKey) {
  const mistralClient = new NimClient(MISTRAL_BASE_URL, config.mistralApiKey);
  try {
    core.info(`Trying Mistral: ${config.mistralModel}...`);
    const result = await mistralClient.chat(config.mistralModel, [
      { role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ], { temperature: 0.2, maxTokens: 4096 });

    if (result.content && result.content.trim()) {
      review = result.content;
      usedModel = config.mistralModel;
      core.info(`Done with Mistral: ${config.mistralModel}`);
    }
  } catch (err) {
    core.info(`Mistral failed: ${err}, falling through to NIM chain...`);
  }
}

// Existing NIM fallback chain (only if Mistral didn't succeed)
if (!review) {
  for (const model of config.models) { ... }
}
```

**Same in `reviewFileWithFallback()`** — accept optional Mistral client:

```typescript
export async function reviewFileWithFallback(
  client: NimClient,
  filePath: string,
  diff: string,
  config: Config,
  mistralClient?: NimClient,
): Promise<string> {
  if (mistralClient) {
    try {
      return await reviewFile(mistralClient, filePath, diff, config.mistralModel, config);
    } catch (err) {
      console.error(`Mistral failed for ${filePath}: ${err}, trying NIM chain...`);
    }
  }
  // Existing NIM fallback
  for (const model of config.models) { ... }
}
```

### 6. SWE_BENCH_SCORES Updates

Add direct Mistral API IDs to `src/bench-reorder.ts`:

```typescript
// Direct Mistral API model IDs
'mistral-medium-3.5': 0.776,
'mistral-medium-latest': 0.776,
'mistral-large-2512': 0.720,
'mistral-large-latest': 0.720,
'mistral-small-2603': 0.680,
'mistral-small-latest': 0.680,
'codestral-2508': 0.650,
'codestral-latest': 0.650,
```

### 7. Benchmark Integration

The daily benchmark workflow can add a Mistral-specific job:

```yaml
benchmark-mistral:
  runs-on: ubuntu-latest
  if: ${{ secrets.MISTRAL_API_KEY != '' }}
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: '20'
        cache: 'npm'
    - run: npm ci && npm run build
    - name: Benchmark Mistral
      env:
        NIM_API_KEY: ${{ secrets.MISTRAL_API_KEY }}
        NIM_BASE_URL: 'https://api.mistral.ai/v1'
        NIM_MODELS: 'mistral-medium-3.5,codestral-2508'
        NIM_BENCH_ITERATIONS: '2'
      run: node dist/bench-entry.js
```

No code changes to bench-entry.ts — it already reads env vars. The NimClient doesn't care which endpoint it's talking to.

### 8. Edge Cases & Decisions

| Decision | Recommendation |
|----------|---------------|
| What if `mistral_api_key` is set but model is wrong? | Fail silently, fall through to NIM |
| Should `mistral_model` support CSV for fallback within Mistral? | No — keep it simple, one model. User can set `mistral-medium-latest` for auto-latest |
| Base URL configurable? | No — this is first-class Mistral, not generic. Generic = separate custom-api-support change |
| Priority order when both Mistral and custom API are configured? | Mistral first → Custom → NIM (to be decided when custom-api-support is implemented) |
| Should `nim_api_key` still be required when Mistral is configured? | Yes for now — NIM is the fallback. Future: make nim_api_key optional if mistral_api_key is present |

## Code References

- `src/nim-client.ts:56-57` - Constructor takes baseURL + apiKey (works for Mistral as-is)
- `src/nim-client.ts:59-89` - chat() method uses `/chat/completions` (Mistral-compatible)
- `src/index.ts:38-39` - Client instantiation point (add Mistral client here)
- `src/index.ts:71-88` - Model fallback loop (Mistral goes BEFORE this)
- `src/review.ts:28-44` - Config interface (add mistralApiKey, mistralModel)
- `src/review.ts:46-60` - loadConfig() (add two new getInput calls)
- `src/review.ts:170-192` - reviewFileWithFallback() (add mistralClient param)
- `src/bench-reorder.ts:63-92` - SWE_BENCH_SCORES map (add direct Mistral IDs)
- `src/bench-reorder.ts:94-96` - getSweBenchScore() (works unchanged, just add entries)
- `.github/workflows/benchmark.yml` - Add Mistral benchmark job
- `action.yml` - Add mistral_api_key and mistral_model inputs

## Architecture Insights

1. **Mistral = known provider, not generic** — Base URL is hardcoded, model IDs are known, SWE-bench scores are mapped. This is a curated integration.
2. **NimClient reuse** — Same class, different instantiation. No abstraction layer needed.
3. **Benchmark reuse** — bench-entry.ts is endpoint-agnostic via env vars. Zero code changes for Mistral benchmarking.
4. **Priority chain**: Mistral (first-class) → NIM fallback (existing). Clean separation.

## Historical Context (from prior changes)

- `context/changes/nodejs-rewrite/research.md` - Established the NimClient pattern
- `context/changes/daily-benchmark/plan.md` - Benchmark system design; Mistral bench job follows same pattern

## Related Research

- `context/changes/custom-api-support/research.md` - Generic custom API support (separate feature)

## Open Questions

1. **Should `nim_api_key` become optional when `mistral_api_key` is set?** — Currently required. Could make it optional so users who only want Mistral don't need a NIM key.
2. **Model aliases** — Should we use `mistral-medium-latest` as default (auto-updates) or pinned `mistral-medium-3.5` (stable)?
3. **Codestral for code review** — `codestral-2508` is a code specialist but may be weaker on general review. Worth testing vs `mistral-medium-3.5`.
