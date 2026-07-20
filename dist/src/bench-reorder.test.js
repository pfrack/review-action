import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseMarkdownTable, rankModels, getSweBenchScore, getEffectiveScore, updateActionYmlMistral } from './bench-reorder.js';
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
        const rows = [
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
        const rows = [
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
        const rows = [
            { model: 'unknown/a', ttftMs: 100, latencyMs: 20000, tokensPerSec: 50, errors: 0 },
            { model: 'unknown/b', ttftMs: 100, latencyMs: 5000, tokensPerSec: 80, errors: 0 },
        ];
        const latencies = { 'unknown/a': 20000, 'unknown/b': 5000 };
        const ranked = rankModels(rows, latencies);
        assert.strictEqual(ranked[0], 'unknown/b'); // faster
    });
    it('excludes fully failed models', () => {
        const rows = [
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
