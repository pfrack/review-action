import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkdownTable, rankModels, getSweBenchScore, getEffectiveScore, fetchSweBenchScores, parseSweBenchResponse, updateActionYmlMistral, type ParsedRow } from './bench-reorder.js';

describe('parseMarkdownTable', () => {
  it('parses a well-formed benchmark table', () => {
    const table = `| Model | TTFT (median) | Latency (median) | Tokens/sec (median) | Errors |
|-------|---------------|------------------|---------------------|--------|
| \`meta/llama-3.3-70b-instruct\` | 250ms | 2.50s | 45.2 | 0 |
| \`deepseek-ai/deepseek-v4-pro\` | 180ms | 1.80s | 62.1 | 0 |
| \`nvidia/llama-3.1-nemotron-70b-instruct\` | 300ms | 3.00s | 38.5 | 1 |`;

    const rows = parseMarkdownTable(table);
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[0].model, 'meta/llama-3.3-70b-instruct');
    assert.strictEqual(rows[0].latencyMs, 2500);
    assert.strictEqual(rows[0].tokensPerSec, 45.2);
    assert.strictEqual(rows[1].model, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(rows[2].errors, 1);
  });

  it('handles N/A values', () => {
    const table = `| Model | TTFT (median) | Latency (median) | Tokens/sec (median) | Errors |
|-------|---------------|------------------|---------------------|--------|
| \`broken/model\` | N/A | N/A | 0.0 | 5 |`;

    const rows = parseMarkdownTable(table);
    assert.strictEqual(rows[0].latencyMs, Infinity);
  });

  it('returns empty for empty input', () => {
    assert.strictEqual(parseMarkdownTable('').length, 0);
  });
});

describe('getSweBenchScore', () => {
  it('returns known score', () => {
    assert.strictEqual(getSweBenchScore('deepseek-ai/deepseek-v4-pro'), 0.806);
  });

  it('returns 0.5 for unknown', () => {
    assert.strictEqual(getSweBenchScore('unknown/model'), 0.5);
  });
});

describe('getEffectiveScore', () => {
  it('no penalty under 60s', () => {
    const lat = { 'deepseek-ai/deepseek-v4-pro': 30_000 };
    assert.strictEqual(getEffectiveScore('deepseek-ai/deepseek-v4-pro', lat), 0.806);
  });

  it('moderate penalty between 60-120s', () => {
    const lat = { 'deepseek-ai/deepseek-v4-pro': 90_000 };
    const score = getEffectiveScore('deepseek-ai/deepseek-v4-pro', lat);
    assert.ok(score < 0.806);
    assert.ok(score > 0.806 * 0.7);
  });

  it('heavy penalty over 120s', () => {
    const lat = { 'deepseek-ai/deepseek-v4-pro': 150_000 };
    assert.strictEqual(getEffectiveScore('deepseek-ai/deepseek-v4-pro', lat), 0.806 * 0.5);
  });

  it('no penalty when no latency data', () => {
    assert.strictEqual(getEffectiveScore('deepseek-ai/deepseek-v4-pro', {}), 0.806);
  });
});

describe('rankModels', () => {
  it('ranks by SWE-bench when latency is fine', () => {
    const rows: ParsedRow[] = [
      { model: 'meta/llama-3.3-70b-instruct', ttftMs: 200, latencyMs: 5000, tokensPerSec: 100, errors: 0 },
      { model: 'deepseek-ai/deepseek-v4-pro', ttftMs: 200, latencyMs: 10000, tokensPerSec: 50, errors: 0 },
      { model: 'minimaxai/minimax-m3', ttftMs: 200, latencyMs: 8000, tokensPerSec: 80, errors: 0 },
    ];
    const latencies = { 'meta/llama-3.3-70b-instruct': 5000, 'deepseek-ai/deepseek-v4-pro': 10000, 'minimaxai/minimax-m3': 8000 };

    const ranked = rankModels(rows, latencies);
    assert.strictEqual(ranked[0], 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(ranked[1], 'minimaxai/minimax-m3');
    assert.strictEqual(ranked[2], 'meta/llama-3.3-70b-instruct');
  });

  it('demotes slow models even with high SWE-bench score', () => {
    const rows: ParsedRow[] = [
      { model: 'deepseek-ai/deepseek-v4-pro', ttftMs: 200, latencyMs: 150_000, tokensPerSec: 30, errors: 0 },
      { model: 'stepfun-ai/step-3.7-flash', ttftMs: 200, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
    ];
    const latencies = { 'deepseek-ai/deepseek-v4-pro': 150_000, 'stepfun-ai/step-3.7-flash': 5000 };

    const ranked = rankModels(rows, latencies);
    // deepseek effective: 0.806 * 0.5 = 0.403, step effective: 0.744
    assert.strictEqual(ranked[0], 'stepfun-ai/step-3.7-flash');
    assert.strictEqual(ranked[1], 'deepseek-ai/deepseek-v4-pro');
  });

  it('uses latency as tiebreaker for same SWE score', () => {
    const rows: ParsedRow[] = [
      { model: 'unknown/a', ttftMs: 100, latencyMs: 20000, tokensPerSec: 50, errors: 0 },
      { model: 'unknown/b', ttftMs: 100, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
    ];
    const latencies = { 'unknown/a': 20000, 'unknown/b': 5000 };

    const ranked = rankModels(rows, latencies);
    assert.strictEqual(ranked[0], 'unknown/b'); // faster
  });

  it('excludes fully failed models', () => {
    const rows: ParsedRow[] = [
      { model: 'deepseek-ai/deepseek-v4-pro', ttftMs: 200, latencyMs: 5000, tokensPerSec: 50, errors: 0 },
      { model: 'dead/model', ttftMs: 0, latencyMs: 0, tokensPerSec: 0, errors: 5 },
    ];

    const ranked = rankModels(rows);
    assert.strictEqual(ranked.length, 1);
    assert.strictEqual(ranked[0], 'deepseek-ai/deepseek-v4-pro');
  });
});

describe('getSweBenchScore — Mistral direct-API IDs', () => {
  it('returns 0.776 for mistral-medium-3.5', () => {
    assert.strictEqual(getSweBenchScore('mistral-medium-3.5'), 0.776);
  });

  it('returns 0.776 for mistral-medium-latest', () => {
    assert.strictEqual(getSweBenchScore('mistral-medium-latest'), 0.776);
  });

  it('returns 0.720 for mistral-large-2512', () => {
    assert.strictEqual(getSweBenchScore('mistral-large-2512'), 0.720);
  });

  it('returns 0.720 for mistral-large-latest', () => {
    assert.strictEqual(getSweBenchScore('mistral-large-latest'), 0.720);
  });

  it('returns 0.680 for mistral-small-2603', () => {
    assert.strictEqual(getSweBenchScore('mistral-small-2603'), 0.680);
  });

  it('returns 0.680 for mistral-small-latest', () => {
    assert.strictEqual(getSweBenchScore('mistral-small-latest'), 0.680);
  });

  it('returns 0.650 for codestral-2508', () => {
    assert.strictEqual(getSweBenchScore('codestral-2508'), 0.650);
  });

  it('returns 0.650 for codestral-latest', () => {
    assert.strictEqual(getSweBenchScore('codestral-latest'), 0.650);
  });
});

describe('updateActionYmlMistral', () => {
  it('correctly replaces mistral_models default', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-test-'));
    const actionPath = join(tmpDir, 'action.yml');

    const content = `name: 'NIM Code Review'
inputs:
  mistral_models:
    description: 'Comma-separated Mistral model fallback chain'
    default: 'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'
  nim_models:
    description: 'Comma-separated fallback model chain'
    default: 'deepseek-ai/deepseek-v4-pro'
`;

    writeFileSync(actionPath, content, 'utf-8');

    updateActionYmlMistral(actionPath, ['codestral-2508', 'mistral-medium-3.5']);

    const result = readFileSync(actionPath, 'utf-8');
    assert.ok(result.includes("default: 'codestral-2508,mistral-medium-3.5'"));
    // nim_models should be unchanged
    assert.ok(result.includes("default: 'deepseek-ai/deepseek-v4-pro'"));
  });

  it('does not modify file when mistral_models block not found', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-test-'));
    const actionPath = join(tmpDir, 'action.yml');

    const content = `name: 'NIM Code Review'
inputs:
  nim_models:
    description: 'Comma-separated fallback model chain'
    default: 'deepseek-ai/deepseek-v4-pro'
`;

    writeFileSync(actionPath, content, 'utf-8');

    updateActionYmlMistral(actionPath, ['codestral-2508']);

    const result = readFileSync(actionPath, 'utf-8');
    assert.strictEqual(result, content); // unchanged
  });
});

describe('getSweBenchScore with fetched scores', () => {
  it('prefers fetched scores over hardcoded', () => {
    const fetched = new Map([['deepseek-ai/deepseek-v4-pro', 0.999]]);
    assert.strictEqual(getSweBenchScore('deepseek-ai/deepseek-v4-pro', fetched), 0.999);
  });

  it('falls back to hardcoded when fetched does not have model', () => {
    const fetched = new Map([['other/model', 0.9]]);
    assert.strictEqual(getSweBenchScore('deepseek-ai/deepseek-v4-pro', fetched), 0.806);
  });

  it('falls back to 0.5 when neither fetched nor hardcoded has model', () => {
    const fetched = new Map([['other/model', 0.9]]);
    assert.strictEqual(getSweBenchScore('unknown/model', fetched), 0.5);
  });

  it('works without fetched scores parameter', () => {
    assert.strictEqual(getSweBenchScore('deepseek-ai/deepseek-v4-pro'), 0.806);
    assert.strictEqual(getSweBenchScore('unknown/model'), 0.5);
  });
});

describe('rankModels with fetched scores', () => {
  it('ranks new model with fetched score above 0.5 defaults', () => {
    const rows: ParsedRow[] = [
      { model: 'new-vendor/new-model', ttftMs: 200, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
      { model: 'meta/llama-3.3-70b-instruct', ttftMs: 200, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
    ];
    const latencies = { 'new-vendor/new-model': 5000, 'meta/llama-3.3-70b-instruct': 5000 };
    const fetched = new Map([['new-vendor/new-model', 0.75]]);

    const ranked = rankModels(rows, latencies, fetched);
    // new model: 0.75, llama: 0.62 → new model should be first
    assert.strictEqual(ranked[0], 'new-vendor/new-model');
    assert.strictEqual(ranked[1], 'meta/llama-3.3-70b-instruct');
  });

  it('without fetched scores, new model gets 0.5 and ranks lower', () => {
    const rows: ParsedRow[] = [
      { model: 'new-vendor/new-model', ttftMs: 200, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
      { model: 'meta/llama-3.3-70b-instruct', ttftMs: 200, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
    ];
    const latencies = { 'new-vendor/new-model': 5000, 'meta/llama-3.3-70b-instruct': 5000 };

    const ranked = rankModels(rows, latencies);
    // new model: 0.5, llama: 0.62 → llama should be first
    assert.strictEqual(ranked[0], 'meta/llama-3.3-70b-instruct');
    assert.strictEqual(ranked[1], 'new-vendor/new-model');
  });
});

describe('parseSweBenchResponse', () => {
  it('parses and filters API response correctly', () => {
    const data = {
      results: [
        { model_id: 'model-a', score: 0.85, organization_id: 'org-a' },
        { model_id: 'model-b', score: 0.72, organization_id: 'org-b' },
        { model_id: 'model-c', score: 0.4, organization_id: 'org-c' }, // below 0.5
      ],
    };

    const result = parseSweBenchResponse(data);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].modelId, 'model-a');
    assert.strictEqual(result[0].score, 0.85);
    assert.strictEqual(result[0].org, 'org-a');
    assert.strictEqual(result[1].modelId, 'model-b');
    assert.ok(!result.some(e => e.modelId === 'model-c'));
  });

  it('sorts by score descending', () => {
    const data = {
      results: [
        { model_id: 'low', score: 0.55 },
        { model_id: 'high', score: 0.9 },
        { model_id: 'mid', score: 0.7 },
      ],
    };

    const result = parseSweBenchResponse(data);
    assert.strictEqual(result[0].modelId, 'high');
    assert.strictEqual(result[1].modelId, 'mid');
    assert.strictEqual(result[2].modelId, 'low');
  });

  it('limits to top 30', () => {
    const results = Array.from({ length: 50 }, (_, i) => ({
      model_id: `model-${i}`,
      score: 0.6 + i * 0.005,
    }));

    const result = parseSweBenchResponse({ results });
    assert.strictEqual(result.length, 30);
  });

  it('handles empty results', () => {
    const result = parseSweBenchResponse({ results: [] });
    assert.deepStrictEqual(result, []);
  });

  it('handles missing organization_id', () => {
    const data = { results: [{ model_id: 'model-a', score: 0.8 }] };
    const result = parseSweBenchResponse(data);
    assert.strictEqual(result[0].org, '');
  });
});

describe('fetchSweBenchScores', () => {
  it('returns empty array on network failure (graceful degradation)', async () => {
    const result = await fetchSweBenchScores();
    assert.ok(Array.isArray(result));
    // Should not throw
  });
});
