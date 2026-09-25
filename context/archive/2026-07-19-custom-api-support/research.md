---
date: 2026-07-19T22:29:45+02:00
researcher: kiro
git_commit: 1d38e2d03591997789d260a9f142d2cacd4459f0
branch: main
repository: review-action
topic: "Generic custom API support (any OpenAI-compatible endpoint)"
tags: [research, codebase, nim-client, config, action-inputs, fallback-chain, custom-api]
status: complete
last_updated: 2026-07-19
last_updated_by: kiro
---

# Research: Generic Custom API Support

**Date**: 2026-07-19T22:29:45+02:00
**Researcher**: kiro
**Git Commit**: 1d38e2d03591997789d260a9f142d2cacd4459f0
**Branch**: main
**Repository**: review-action

## Research Question

How to add a generic custom API endpoint (any OpenAI-compatible service) with `custom_api_url`, `custom_model`, and `custom_api_key` inputs, tried before the NIM fallback chain.

## Summary

This is the **generic** custom endpoint feature — for users who want to bring their own OpenAI-compatible API (OpenRouter, local Ollama, vLLM, Together AI, Groq, etc). It's separate from first-class provider integrations like Mistral (see `context/changes/mistral-support/`).

Three new action inputs. When configured, a second `NimClient` instance is created for the custom endpoint and tried before the NIM models. On failure, falls through silently.

## Detailed Findings

### 1. NimClient Architecture (`src/nim-client.ts`)

The client is a simple OpenAI-compatible HTTP wrapper:
- Constructor takes `baseURL` and `apiKey`
- `chat()` calls `POST ${baseURL}/chat/completions` with Bearer auth
- Works with ANY OpenAI-compatible endpoint (OpenRouter, Ollama, vLLM, Groq, Together AI, etc)

**No class changes needed.**

### 2. Current Config & Inputs (`src/review.ts:28-44`, `action.yml`)

Current `Config` interface:
```typescript
export interface Config {
  baseURL: string;      // from nim_base_url input
  apiKey: string;       // from nim_api_key input
  models: string[];     // from nim_models input (CSV)
  maxFiles: number;
  excludePatterns: string[];
  systemPrompt: string;
  promptMode: string;
}
```

### 3. Proposed New Inputs for `action.yml`

```yaml
custom_api_url:
  description: 'Custom OpenAI-compatible API base URL (tried before NIM models)'
  default: ''
custom_model:
  description: 'Model name for the custom API endpoint'
  default: ''
custom_api_key:
  description: 'API key for the custom endpoint (can be empty for local/keyless endpoints)'
  default: ''
```

All three are optional. Feature activates when both `custom_api_url` AND `custom_model` are provided. `custom_api_key` can be empty (supports keyless endpoints like local Ollama).

### 4. Implementation Strategy

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
  // Custom API fields
  customApiUrl: string;
  customModel: string;
  customApiKey: string;
}
```

Add to `loadConfig()`:
```typescript
customApiUrl: core.getInput('custom_api_url') || '',
customModel: core.getInput('custom_model') || '',
customApiKey: core.getInput('custom_api_key') || '',
```

**Main logic changes** (`src/index.ts`):

```typescript
// Try custom model FIRST if configured
if (config.customApiUrl && config.customModel) {
  const customClient = new NimClient(config.customApiUrl, config.customApiKey);
  try {
    core.info(`Trying custom model: ${config.customModel}...`);
    const result = await customClient.chat(config.customModel, [
      { role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ], { temperature: 0.2, maxTokens: 4096 });

    if (result.content && result.content.trim()) {
      review = result.content;
      usedModel = config.customModel;
      core.info(`Done with custom model: ${config.customModel}`);
    }
  } catch (err) {
    core.info(`Custom model failed: ${err}, falling through to NIM chain...`);
  }
}

// Existing NIM fallback chain (only if custom didn't succeed)
if (!review) {
  for (const model of config.models) {
    // ... existing logic
  }
}
```

**Same for `reviewFileWithFallback()`** — accept optional custom client:

```typescript
export async function reviewFileWithFallback(
  client: NimClient,
  filePath: string,
  diff: string,
  config: Config,
  customClient?: NimClient,
): Promise<string> {
  if (customClient && config.customModel) {
    try {
      return await reviewFile(customClient, filePath, diff, config.customModel, config);
    } catch (err) {
      console.error(`Custom model failed for ${filePath}: ${err}, trying NIM chain...`);
    }
  }
  // Existing NIM fallback
  for (const model of config.models) { ... }
}
```

### 5. Priority Order (when both Mistral and custom are configured)

```
Mistral (first-class) → Custom API (generic) → NIM fallback chain
```

The custom API is second in priority — it's a user-supplied unknown, while Mistral is a curated integration with known quality scores.

### 6. Edge Cases & Decisions

| Decision | Recommendation |
|----------|---------------|
| What if only `custom_api_url` is set without `custom_model`? | Skip custom, use NIM chain (both URL and model are required) |
| What if `custom_api_key` is empty? | Allow it — supports local/keyless endpoints like Ollama |
| Should custom model failure block the PR review? | No — fail silently and fall through to NIM |
| Should the custom model appear in the comment? | Yes — show `Model: custom-model-name` in the PR comment |
| Should custom model work with bench? | Not by default — bench is for known models. But bench-entry.ts already works if you set env vars manually |
| Should `nim_api_key` be required when custom is configured? | Yes — custom is not guaranteed to work, NIM is the safety net |

### 7. Usage Examples

**OpenRouter:**
```yaml
- uses: prachwal/review-action@v1
  with:
    custom_api_url: 'https://openrouter.ai/api/v1'
    custom_model: 'anthropic/claude-sonnet-4'
    custom_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    nim_api_key: ${{ secrets.NIM_API_KEY }}
```

**Local Ollama (self-hosted runner):**
```yaml
- uses: prachwal/review-action@v1
  with:
    custom_api_url: 'http://localhost:11434/v1'
    custom_model: 'llama3.1:70b'
    custom_api_key: ''
    nim_api_key: ${{ secrets.NIM_API_KEY }}
```

**Together AI:**
```yaml
- uses: prachwal/review-action@v1
  with:
    custom_api_url: 'https://api.together.xyz/v1'
    custom_model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'
    custom_api_key: ${{ secrets.TOGETHER_API_KEY }}
    nim_api_key: ${{ secrets.NIM_API_KEY }}
```

## Code References

- `src/nim-client.ts:56-57` - Constructor takes baseURL + apiKey (works for any endpoint)
- `src/nim-client.ts:59-89` - chat() uses `/chat/completions` (universal OpenAI protocol)
- `src/index.ts:38-39` - Client instantiation point (add custom client here)
- `src/index.ts:71-88` - Model fallback loop (custom goes BEFORE this)
- `src/review.ts:28-44` - Config interface (add customApiUrl, customModel, customApiKey)
- `src/review.ts:46-60` - loadConfig() (add three new getInput calls)
- `src/review.ts:170-192` - reviewFileWithFallback() (add customClient param)
- `action.yml` - Add custom_api_url, custom_model, custom_api_key inputs

## Architecture Insights

1. **NimClient is endpoint-agnostic** — Works with any OpenAI-compatible service. No changes needed.
2. **Single-client → dual-client** — Custom breaks the one-client assumption. Two instances with different credentials.
3. **Fallback is simple sequential** — Just prepend custom to the sequence.
4. **Config stays flat** — 3 more top-level fields, consistent with existing pattern.
5. **No bench integration** — Generic custom models have unknown quality. Benchmarking is opt-in via env vars.

## Historical Context (from prior changes)

- `context/changes/nodejs-rewrite/research.md` - Established the NimClient pattern
- `context/changes/daily-benchmark/plan.md` - Benchmark system; custom API intentionally excluded from daily bench

## Related Research

- `context/changes/mistral-support/research.md` - First-class Mistral integration (separate change, different inputs)

## Open Questions

1. **Naming**: `custom_` prefix vs `primary_` vs `user_`?
2. **Multiple custom models**: Should `custom_model` support CSV for fallback within the custom endpoint?
3. **Timeout**: Should custom endpoints get a different timeout than 180s? Local Ollama might be slower.
4. **SWE-bench for custom models**: If someone configures a known model (e.g., `gpt-4o`) via custom API, should `getSweBenchScore()` recognize it? Would require a broader model→score lookup.
