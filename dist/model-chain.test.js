import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCombinedChain } from './model-chain.js';
describe('buildCombinedChain', () => {
    it('NIM-only: includes only NIM models when only NIM key is available', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
            mistralModels: ['mistral-medium-3.5', 'codestral-2508'],
            hasNimKey: true,
            hasMistralKey: false,
        });
        assert.strictEqual(chain.length, 2);
        assert.ok(chain.every(m => m.provider === 'nim'));
        assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro'); // 0.806
        assert.strictEqual(chain[1].id, 'meta/llama-3.3-70b-instruct'); // 0.620
    });
    it('Mistral-only: includes only Mistral models when only Mistral key is available', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro'],
            mistralModels: ['mistralai/mistral-medium-3.5-128b', 'mistralai/mistral-small-4-119b-2603', 'nvidia/llama-3.3-nemotron-super-49b-v1'],
            hasNimKey: false,
            hasMistralKey: true,
        });
        assert.strictEqual(chain.length, 3);
        assert.ok(chain.every(m => m.provider === 'mistral'));
        // Sorted by score: 0.776, 0.680, 0.650
        assert.strictEqual(chain[0].id, 'mistralai/mistral-medium-3.5-128b');
        assert.strictEqual(chain[1].id, 'mistralai/mistral-small-4-119b-2603');
        assert.strictEqual(chain[2].id, 'nvidia/llama-3.3-nemotron-super-49b-v1');
    });
    it('combined: merges both lists sorted by SWE-bench score', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
            mistralModels: ['mistralai/mistral-medium-3.5-128b', 'mistralai/mistral-small-4-119b-2603'],
            hasNimKey: true,
            hasMistralKey: true,
        });
        assert.strictEqual(chain.length, 4);
        // Expected order by score: deepseek(0.806), mistral-medium-nim(0.776), mistral-small-nim(0.680), llama(0.620)
        assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(chain[0].provider, 'nim');
        assert.strictEqual(chain[1].id, 'mistralai/mistral-medium-3.5-128b');
        assert.strictEqual(chain[1].provider, 'mistral');
        assert.strictEqual(chain[2].id, 'mistralai/mistral-small-4-119b-2603');
        assert.strictEqual(chain[2].provider, 'mistral');
        assert.strictEqual(chain[3].id, 'meta/llama-3.3-70b-instruct');
        assert.strictEqual(chain[3].provider, 'nim');
    });
    it('empty: returns empty array when neither key is available', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro'],
            mistralModels: ['mistral-medium-3.5'],
            hasNimKey: false,
            hasMistralKey: false,
        });
        assert.strictEqual(chain.length, 0);
    });
    it('empty models: returns empty when model lists are empty', () => {
        const chain = buildCombinedChain({ nimModels: [], mistralModels: [], hasNimKey: true, hasMistralKey: true });
        assert.strictEqual(chain.length, 0);
    });
    it('unknown models get default score 0.5', () => {
        const chain = buildCombinedChain({
            nimModels: ['unknown/model-a'],
            mistralModels: ['unknown-mistral-model'],
            hasNimKey: true,
            hasMistralKey: true,
        });
        assert.strictEqual(chain.length, 2);
        // Both have same score (0.5), stable sort preserves insertion order
        // NIM models are added first, then Mistral
        assert.strictEqual(chain[0].id, 'unknown/model-a');
        assert.strictEqual(chain[1].id, 'unknown-mistral-model');
    });
    it('preserves order among models with same score', () => {
        // mistralai/mistral-nemotron and mistralai/mistral-large-3-675b-instruct-2512 both have 0.720
        const chain = buildCombinedChain({
            nimModels: ['mistralai/mistral-nemotron'],
            mistralModels: ['mistralai/mistral-large-3-675b-instruct-2512'],
            hasNimKey: true,
            hasMistralKey: true,
        });
        assert.strictEqual(chain.length, 2);
        // Both have score 0.720 — stable sort preserves original push order
        // NIM pushed first, so mistralai/mistral-nemotron comes first
        assert.strictEqual(chain[0].id, 'mistralai/mistral-nemotron');
        assert.strictEqual(chain[1].id, 'mistralai/mistral-large-3-675b-instruct-2512');
    });
    it('custom model is prepended before scored models', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro'],
            mistralModels: ['mistralai/mistral-medium-3.5-128b'],
            hasNimKey: true,
            hasMistralKey: true,
            customModel: 'my-custom/model',
            hasCustomConfig: true,
        });
        assert.strictEqual(chain.length, 3);
        assert.strictEqual(chain[0].id, 'my-custom/model');
        assert.strictEqual(chain[0].provider, 'custom');
        // Remaining models sorted by score
        assert.strictEqual(chain[1].id, 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(chain[2].id, 'mistralai/mistral-medium-3.5-128b');
    });
    it('custom model absent when params not provided', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro'],
            mistralModels: [],
            hasNimKey: true,
            hasMistralKey: false,
        });
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(chain[0].provider, 'nim');
    });
    it('custom model absent when hasCustomConfig is false', () => {
        const chain = buildCombinedChain({
            nimModels: ['deepseek-ai/deepseek-v4-pro'],
            mistralModels: [],
            hasNimKey: true,
            hasMistralKey: false,
            customModel: 'my-custom/model',
            hasCustomConfig: false,
        });
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(chain[0].provider, 'nim');
    });
});
