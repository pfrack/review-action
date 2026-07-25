import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCombinedChain, type TaggedModel } from './model-chain.js';

describe('buildCombinedChain', () => {
  it('NIM-only: includes only NIM models when only NIM key is available', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
      mistralModels: ['mistral-medium-3.5', 'codestral-2508'],
      groqModels: [],
      hasGroqKey: false,
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
      groqModels: [],
      hasGroqKey: false,
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
      groqModels: [],
      hasGroqKey: false,
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

  it('includes Groq models in the shared score-sorted chain', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: ['mistralai/mistral-medium-3.5-128b'],
      groqModels: ['moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'],
      hasNimKey: true,
      hasMistralKey: true,
      hasGroqKey: true,
    });

    assert.deepStrictEqual(chain.map(m => `${m.provider}:${m.id}`), [
      'nim:deepseek-ai/deepseek-v4-pro',
      'groq:moonshotai/kimi-k2-instruct',
      'mistral:mistralai/mistral-medium-3.5-128b',
      'groq:llama-3.3-70b-versatile',
    ]);
  });

  it('empty: returns empty array when neither key is available', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: ['mistral-medium-3.5'],
      groqModels: [],
      hasGroqKey: false,
      hasNimKey: false,
      hasMistralKey: false,
    });

    assert.strictEqual(chain.length, 0);
  });

  it('empty models: returns empty when model lists are empty', () => {
    const chain = buildCombinedChain({ nimModels: [], mistralModels: [], groqModels: [], hasNimKey: true, hasMistralKey: true, hasGroqKey: true });
    assert.strictEqual(chain.length, 0);
  });

  it('unknown models get default score 0.5', () => {
    const chain = buildCombinedChain({
      nimModels: ['unknown/model-a'],
      mistralModels: ['unknown-mistral-model'],
      groqModels: [],
      hasGroqKey: false,
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
      groqModels: [],
      hasGroqKey: false,
      hasNimKey: true,
      hasMistralKey: true,
    });

    assert.strictEqual(chain.length, 2);
    // Both have score 0.720 — stable sort preserves original push order
    // NIM pushed first, so mistralai/mistral-nemotron comes first
    assert.strictEqual(chain[0].id, 'mistralai/mistral-nemotron');
    assert.strictEqual(chain[1].id, 'mistralai/mistral-large-3-675b-instruct-2512');
  });

  it('custom model is always first, providers follow as fallback chain', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: ['mistralai/mistral-medium-3.5-128b'],
      groqModels: [],
      hasGroqKey: false,
      hasNimKey: true,
      hasMistralKey: true,
      customModel: 'my-custom/model',
      hasCustomConfig: true,
    });

    assert.strictEqual(chain.length, 3);
    assert.strictEqual(chain[0].id, 'my-custom/model');
    assert.strictEqual(chain[0].provider, 'custom');
    assert.strictEqual(chain[1].id, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(chain[2].id, 'mistralai/mistral-medium-3.5-128b');
  });

  it('custom model absent when params not provided', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      groqModels: [],
      hasGroqKey: false,
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
      groqModels: [],
      hasGroqKey: false,
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

describe('OpenRouter provider', () => {
  it('includes OpenRouter models when key is available, sorted by SWE-bench score', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      openrouterModels: ['meta-llama/llama-4-maverick:free', 'deepseek/deepseek-r1:free'],
      hasOpenRouterKey: true,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 3);
    // deepseek-v4-pro (0.806) is non-free, comes before free models
    assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(chain[0].provider, 'nim');
    // Free models sorted by score: deepseek-r1:free (0.65) > llama-4-maverick:free (0.50)
    assert.strictEqual(chain[1].id, 'deepseek/deepseek-r1:free');
    assert.strictEqual(chain[1].provider, 'openrouter');
    assert.strictEqual(chain[2].id, 'meta-llama/llama-4-maverick:free');
    assert.strictEqual(chain[2].provider, 'openrouter');
  });

  it('free models rank last, after non-free provider models', () => {
    const chain = buildCombinedChain({
      nimModels: [],
      hasNimKey: false,
      mistralModels: ['mistralai/mistral-medium-3.5-128b', 'mistral-small-model:free'],
      hasMistralKey: true,
      openrouterModels: ['deepseek/deepseek-r1:free'],
      hasOpenRouterKey: true,
    });

    // Non-free first, then free
    assert.strictEqual(chain[0].id, 'mistralai/mistral-medium-3.5-128b');
    assert.strictEqual(chain[0].provider, 'mistral');
    // Both free models come after non-free, sorted by SWE-bench within free group
    const freeModels = chain.filter(m => m.id.endsWith(':free'));
    assert.strictEqual(freeModels.length, 2);
  });

  it('free-last rule overrides score ordering when free model scores higher than non-free', () => {
    // deepseek-r1:free (score 0.65) > jamba (score 0.55) — without free-last, :free would come first
    const chain = buildCombinedChain({
      nimModels: [],
      hasNimKey: false,
      mistralModels: [],
      hasMistralKey: false,
      groqModels: ['llama-3.3-70b-versatile'],
      hasGroqKey: true,
      openrouterModels: ['deepseek/deepseek-r1:free', 'ai21labs/jamba-1.5-large-instruct'],
      hasOpenRouterKey: true,
    });

    // Free-last rule: jamba (0.55, non-free) must come before deepseek-r1:free (0.65, free)
    // even though the free model has higher SWE-bench score
    assert.strictEqual(chain[0].id, 'llama-3.3-70b-versatile');
    assert.strictEqual(chain[1].id, 'ai21labs/jamba-1.5-large-instruct');
    assert.strictEqual(chain[2].id, 'deepseek/deepseek-r1:free');
  });

  it('OpenRouter absent when key is not available', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      openrouterModels: ['deepseek/deepseek-r1:free'],
      hasOpenRouterKey: false,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
  });
});

describe('Kilo provider', () => {
  it('includes Kilo models when key is available, sorted by SWE-bench score', () => {
    const chain = buildCombinedChain({
      nimModels: ['meta/llama-3.3-70b-instruct'],
      mistralModels: [],
      hasMistralKey: false,
      kiloModels: ['kilo-auto/balanced:free', 'kilo-auto/frontier:free'],
      hasKiloKey: true,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 3);
    // Non-free first
    assert.strictEqual(chain[0].id, 'meta/llama-3.3-70b-instruct');
    assert.strictEqual(chain[0].provider, 'nim');
    // Free models sorted by SWE-bench within free group
    assert.strictEqual(chain[1].id, 'kilo-auto/frontier:free');
    assert.strictEqual(chain[1].provider, 'kilocode');
    assert.strictEqual(chain[2].id, 'kilo-auto/balanced:free');
    assert.strictEqual(chain[2].provider, 'kilocode');
  });

  it('Kilo absent when key is not available', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      kiloModels: ['kilo-auto/balanced:free'],
      hasKiloKey: false,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
  });
});

describe('custom_models CSV', () => {
  it('multiple custom models are prepended, always-first', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      customModels: ['local Model-A', 'local Model-B'],
      hasCustomModels: true,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 3);
    assert.strictEqual(chain[0].id, 'local Model-A');
    assert.strictEqual(chain[0].provider, 'custom');
    assert.strictEqual(chain[1].id, 'local Model-B');
    assert.strictEqual(chain[1].provider, 'custom');
    assert.strictEqual(chain[2].id, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(chain[2].provider, 'nim');
  });

  it('custom_models entries prepended before single custom_model', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      customModels: ['local-model-csv'],
      customModel: 'local-model-single',
      hasCustomModels: true,
      hasCustomConfig: true,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 3);
    assert.strictEqual(chain[0].id, 'local-model-csv');
    assert.strictEqual(chain[0].provider, 'custom');
    assert.strictEqual(chain[1].id, 'local-model-single');
    assert.strictEqual(chain[1].provider, 'custom');
    assert.strictEqual(chain[2].id, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(chain[2].provider, 'nim');
  });

  it('custom_models absent when not configured', () => {
    const chain = buildCombinedChain({
      nimModels: ['deepseek-ai/deepseek-v4-pro'],
      mistralModels: [],
      hasMistralKey: false,
      hasNimKey: true,
    });

    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro');
  });
});

describe('6-provider combined chain ordering', () => {
  it('custom models first, then provider models sorted by score with free models last', () => {
    const chain = buildCombinedChain({
      nimModels: ['meta/llama-3.3-70b-instruct'],
      hasNimKey: true,
      mistralModels: ['mistralai/mistral-large-3-675b-instruct-2512'],
      hasMistralKey: true,
      groqModels: ['llama-3.3-70b-versatile'],
      hasGroqKey: true,
      openrouterModels: ['deepseek/deepseek-r1:free', 'meta-llama/llama-4-maverick:free'],
      hasOpenRouterKey: true,
      kiloModels: ['kilo-auto/frontier:free'],
      hasKiloKey: true,
      customModels: ['local-model-a'],
      customModel: 'local-model-b',
      hasCustomModels: true,
      hasCustomConfig: true,
    });

    const customModels = chain.filter(m => m.provider === 'custom');
    assert.strictEqual(customModels.length, 2);
    assert.strictEqual(customModels[0].id, 'local-model-a');
    assert.strictEqual(customModels[1].id, 'local-model-b');

    const providerModels = chain.filter(m => m.provider !== 'custom');
    const freeModels = providerModels.filter(m => m.id.endsWith(':free'));
    const nonFreeModels = providerModels.filter(m => !m.id.endsWith(':free'));

    assert.strictEqual(nonFreeModels[0].id, 'mistralai/mistral-large-3-675b-instruct-2512');
    assert.ok(nonFreeModels.some(m => m.id === 'meta/llama-3.3-70b-instruct'));
    assert.ok(nonFreeModels.some(m => m.id === 'llama-3.3-70b-versatile'));

    assert.strictEqual(freeModels.length, 3);
    assert.strictEqual(freeModels[0].id, 'deepseek/deepseek-r1:free');
    assert.strictEqual(freeModels[1].id, 'kilo-auto/frontier:free');
    assert.strictEqual(freeModels[2].id, 'meta-llama/llama-4-maverick:free');
  });
});
