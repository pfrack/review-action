import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildCombinedChain, type TaggedModel } from './model-chain.js';

describe('buildCombinedChain', () => {
  it('NIM-only: includes only NIM models when only NIM key is available', () => {
    const chain = buildCombinedChain(
      ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
      ['mistral-medium-3.5', 'codestral-2508'],
      true,
      false,
    );

    assert.strictEqual(chain.length, 2);
    assert.ok(chain.every(m => m.provider === 'nim'));
    assert.strictEqual(chain[0].id, 'deepseek-ai/deepseek-v4-pro'); // 0.806
    assert.strictEqual(chain[1].id, 'meta/llama-3.3-70b-instruct'); // 0.620
  });

  it('Mistral-only: includes only Mistral models when only Mistral key is available', () => {
    const chain = buildCombinedChain(
      ['deepseek-ai/deepseek-v4-pro'],
      ['mistralai/mistral-medium-3.5-128b', 'mistralai/mistral-small-4-119b-2603', 'nvidia/llama-3.3-nemotron-super-49b-v1'],
      false,
      true,
    );

    assert.strictEqual(chain.length, 3);
    assert.ok(chain.every(m => m.provider === 'mistral'));
    // Sorted by score: 0.776, 0.680, 0.650
    assert.strictEqual(chain[0].id, 'mistralai/mistral-medium-3.5-128b');
    assert.strictEqual(chain[1].id, 'mistralai/mistral-small-4-119b-2603');
    assert.strictEqual(chain[2].id, 'nvidia/llama-3.3-nemotron-super-49b-v1');
  });

  it('combined: merges both lists sorted by SWE-bench score', () => {
    const chain = buildCombinedChain(
      ['deepseek-ai/deepseek-v4-pro', 'meta/llama-3.3-70b-instruct'],
      ['mistralai/mistral-medium-3.5-128b', 'mistralai/mistral-small-4-119b-2603'],
      true,
      true,
    );

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
    const chain = buildCombinedChain(
      ['deepseek-ai/deepseek-v4-pro'],
      ['mistral-medium-3.5'],
      false,
      false,
    );

    assert.strictEqual(chain.length, 0);
  });

  it('empty models: returns empty when model lists are empty', () => {
    const chain = buildCombinedChain([], [], true, true);
    assert.strictEqual(chain.length, 0);
  });

  it('unknown models get default score 0.5', () => {
    const chain = buildCombinedChain(
      ['unknown/model-a'],
      ['unknown-mistral-model'],
      true,
      true,
    );

    assert.strictEqual(chain.length, 2);
    // Both have same score (0.5), stable sort preserves insertion order
    // NIM models are added first, then Mistral
    assert.strictEqual(chain[0].id, 'unknown/model-a');
    assert.strictEqual(chain[1].id, 'unknown-mistral-model');
  });

  it('preserves order among models with same score', () => {
    // mistralai/mistral-nemotron and mistralai/mistral-large-3-675b-instruct-2512 both have 0.720
    const chain = buildCombinedChain(
      ['mistralai/mistral-nemotron'],
      ['mistralai/mistral-large-3-675b-instruct-2512'],
      true,
      true,
    );

    assert.strictEqual(chain.length, 2);
    // Both have score 0.720 — stable sort preserves original push order
    // NIM pushed first, so mistralai/mistral-nemotron comes first
    assert.strictEqual(chain[0].id, 'mistralai/mistral-nemotron');
    assert.strictEqual(chain[1].id, 'mistralai/mistral-large-3-675b-instruct-2512');
  });
});
