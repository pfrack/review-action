import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig, filterFreeOnly, isFreeModel } from './config.js';
import { withEnv } from './test-utils.js';

describe('loadConfig — OpenRouter fields', () => {
  it('reads OpenRouter API key and models', async () => {
    await withEnv({
      INPUT_OPENROUTER_API_KEY: 'sk-or-v1-key',
      INPUT_OPENROUTER_MODELS: 'deepseek/deepseek-r1:free,google/gemini-2.0-flash-exp:free',
      INPUT_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.openRouterApiKey, 'sk-or-v1-key');
      assert.strictEqual(config.openRouterBaseUrl, 'https://openrouter.ai/api/v1');
      assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);
    });
  });

  it('defaults OpenRouter models to empty when no key and no models provided', async () => {
    await withEnv({
      INPUT_OPENROUTER_API_KEY: '',
      INPUT_OPENROUTER_MODELS: '',
      INPUT_NIM_API_KEY: 'nim-key',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.openRouterApiKey, '');
      assert.deepStrictEqual(config.openRouterModels, []);
    });
  });
});

describe('loadConfig — Kilo fields', () => {
  it('reads Kilo API key and models', async () => {
    await withEnv({
      INPUT_KILOCODE_API_KEY: 'kilo-key',
      INPUT_KILOCODE_MODELS: 'kilo-auto/free',
      INPUT_KILOCODE_BASE_URL: 'https://api.kilo.ai/api/gateway',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.kiloApiKey, 'kilo-key');
      assert.strictEqual(config.kiloBaseUrl, 'https://api.kilo.ai/api/gateway');
      assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free']);
    });
  });

  it('defaults Kilo models to empty when no key and no models provided', async () => {
    await withEnv({
      INPUT_KILOCODE_API_KEY: '',
      INPUT_KILOCODE_MODELS: '',
      INPUT_NIM_API_KEY: 'nim-key',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.kiloApiKey, '');
      assert.deepStrictEqual(config.kiloModels, []);
    });
  });
});

describe('loadConfig — custom_models CSV', () => {
  it('parses custom_models CSV and defaults base URL to custom_api_url', async () => {
    await withEnv({
      INPUT_CUSTOM_MODELS: 'model-a, model-b',
      INPUT_CUSTOM_API_URL: 'https://api.example.com/v1',
      INPUT_CUSTOM_MODELS_BASE_URL: '',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.deepStrictEqual(config.customModels, ['model-a', 'model-b']);
      assert.strictEqual(config.customModelsBaseUrl, 'https://api.example.com/v1');
    });
  });

  it('custom_models empty when not provided', async () => {
    await withEnv({
      INPUT_CUSTOM_MODELS: '',
      INPUT_CUSTOM_API_URL: '',
      INPUT_CUSTOM_MODELS_BASE_URL: '',
      INPUT_NIM_API_KEY: 'nim-key',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.deepStrictEqual(config.customModels, []);
      assert.strictEqual(config.customModelsBaseUrl, '');
    });
  });
});

describe('isFreeModel', () => {
  it('matches :free suffix', () => {
    assert.ok(isFreeModel('model:free'));
    assert.ok(isFreeModel('org/model:free'));
  });

  it('matches free without colon', () => {
    assert.ok(isFreeModel('kilo-auto/free'));
  });

  it('is case-insensitive', () => {
    assert.ok(isFreeModel('model:Free'));
    assert.ok(isFreeModel('model:FREE'));
  });

  it('rejects non-free models', () => {
    assert.ok(!isFreeModel('model-pro'));
    assert.ok(!isFreeModel('gpt-4'));
  });
});

describe('filterFreeOnly', () => {
  it('returns all models when disabled', () => {
    const models = ['model-a:free', 'model-b', 'model-c:free'];
    assert.deepStrictEqual(filterFreeOnly(models, false, 'Test'), ['model-a:free', 'model-b', 'model-c:free']);
  });

  it('filters out non-free models when enabled', () => {
    const models = ['model-a:free', 'model-b', 'model-c:free'];
    assert.deepStrictEqual(filterFreeOnly(models, true, 'Test'), ['model-a:free', 'model-c:free']);
  });

  it('returns empty array when no free models exist', () => {
    const models = ['model-a', 'model-b'];
    assert.deepStrictEqual(filterFreeOnly(models, true, 'Test'), []);
  });

  it('returns all models when all are free', () => {
    const models = ['model-a:free', 'model-b:free', 'kilo-auto/free'];
    assert.deepStrictEqual(filterFreeOnly(models, true, 'Test'), ['model-a:free', 'model-b:free', 'kilo-auto/free']);
  });

  it('handles empty model list', () => {
    assert.deepStrictEqual(filterFreeOnly([], true, 'Test'), []);
    assert.deepStrictEqual(filterFreeOnly([], false, 'Test'), []);
  });
});

describe('loadConfig — free-only filter', () => {
  it('filters OpenRouter models to free-only when openrouter_free_only is true', async () => {
    await withEnv({
      INPUT_OPENROUTER_API_KEY: 'or-key',
      INPUT_OPENROUTER_MODELS: 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free',
      INPUT_OPENROUTER_FREE_ONLY: 'true',
      INPUT_KILOCODE_API_KEY: '',
      INPUT_KILOCODE_MODELS: '',
      INPUT_KILOCODE_FREE_ONLY: '',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.openRouterFreeOnly, true);
      assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);
    });
  });

  it('does not filter OpenRouter models when openrouter_free_only is false', async () => {
    await withEnv({
      INPUT_OPENROUTER_API_KEY: 'or-key',
      INPUT_OPENROUTER_MODELS: 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free',
      INPUT_OPENROUTER_FREE_ONLY: 'false',
      INPUT_KILOCODE_API_KEY: '',
      INPUT_KILOCODE_MODELS: '',
      INPUT_KILOCODE_FREE_ONLY: '',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.openRouterFreeOnly, false);
      assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'meta-llama/llama-4-maverick', 'google/gemini-2.0-flash-exp:free']);
    });
  });

  it('filters Kilo models to free-only when kilocode_free_only is true', async () => {
    await withEnv({
      INPUT_KILOCODE_API_KEY: 'kilo-key',
      INPUT_KILOCODE_MODELS: 'kilo-auto/free,kilo-auto/premium',
      INPUT_KILOCODE_FREE_ONLY: 'true',
      INPUT_OPENROUTER_API_KEY: '',
      INPUT_OPENROUTER_MODELS: '',
      INPUT_OPENROUTER_FREE_ONLY: '',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.kiloFreeOnly, true);
      assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free']);
    });
  });

  it('does not filter Kilo models when kilocode_free_only is false', async () => {
    await withEnv({
      INPUT_KILOCODE_API_KEY: 'kilo-key',
      INPUT_KILOCODE_MODELS: 'kilo-auto/free,kilo-auto/premium',
      INPUT_KILOCODE_FREE_ONLY: 'false',
      INPUT_OPENROUTER_API_KEY: '',
      INPUT_OPENROUTER_MODELS: '',
      INPUT_OPENROUTER_FREE_ONLY: '',
      INPUT_NIM_API_KEY: '',
      INPUT_NIM_BASE_URL: '',
      INPUT_NIM_MODELS: '',
      INPUT_MAX_FILES: '',
      INPUT_EXCLUDE_PATTERNS: '',
      INPUT_NIM_SYSTEM_PROMPT: '',
      INPUT_NIM_PROMPT_MODE: '',
    }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.kiloFreeOnly, false);
      assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free', 'kilo-auto/premium']);
    });
  });
});

describe('loadConfig — timeout fields', () => {
  const BASE = {
    INPUT_NIM_API_KEY: 'nim-key',
    INPUT_NIM_BASE_URL: '',
    INPUT_NIM_MODELS: '',
    INPUT_MAX_FILES: '',
    INPUT_EXCLUDE_PATTERNS: '',
    INPUT_NIM_SYSTEM_PROMPT: '',
    INPUT_NIM_PROMPT_MODE: '',
    INPUT_OPENROUTER_API_KEY: '',
    INPUT_OPENROUTER_MODELS: '',
    INPUT_MODEL_TIMEOUT: '',
    INPUT_CHAIN_TIMEOUT: '',
  };

  it('defaults modelTimeout to 90 and chainTimeout to 0', async () => {
    await withEnv({ ...BASE }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.modelTimeout, 90);
      assert.strictEqual(config.chainTimeout, 0);
    });
  });

  it('reads custom valid values', async () => {
    await withEnv({ ...BASE, INPUT_MODEL_TIMEOUT: '90', INPUT_CHAIN_TIMEOUT: '300' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.modelTimeout, 90);
      assert.strictEqual(config.chainTimeout, 300);
    });
  });

  it('accepts 0 as valid for both fields', async () => {
    await withEnv({ ...BASE, INPUT_MODEL_TIMEOUT: '0', INPUT_CHAIN_TIMEOUT: '0' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.modelTimeout, 0);
      assert.strictEqual(config.chainTimeout, 0);
    });
  });

  it('warns and falls back on invalid model_timeout', async () => {
    await withEnv({ ...BASE, INPUT_MODEL_TIMEOUT: '-5' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.modelTimeout, 90);
    });
  });
});

describe('loadConfig — custom_swe_score', () => {
  const BASE = {
    INPUT_NIM_API_KEY: 'nim-key',
    INPUT_NIM_BASE_URL: '',
    INPUT_NIM_MODELS: '',
    INPUT_MAX_FILES: '',
    INPUT_EXCLUDE_PATTERNS: '',
    INPUT_NIM_SYSTEM_PROMPT: '',
    INPUT_NIM_PROMPT_MODE: '',
    INPUT_OPENROUTER_API_KEY: '',
    INPUT_OPENROUTER_MODELS: '',
    INPUT_MODEL_TIMEOUT: '',
    INPUT_CHAIN_TIMEOUT: '',
    INPUT_CUSTOM_SWE_SCORE: '',
  };

  it('defaults customSweScore to 0.5 when unset', async () => {
    await withEnv({ ...BASE }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.customSweScore, 0.5);
    });
  });

  it('parses a valid customSweScore', async () => {
    await withEnv({ ...BASE, INPUT_CUSTOM_SWE_SCORE: '0.85' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.customSweScore, 0.85);
    });
  });

  it('accepts 0 and 1 as boundary values', async () => {
    await withEnv({ ...BASE, INPUT_CUSTOM_SWE_SCORE: '0' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.customSweScore, 0);
    });
    await withEnv({ ...BASE, INPUT_CUSTOM_SWE_SCORE: '1' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.customSweScore, 1);
    });
  });

  it('warns and falls back to 0.5 for out-of-range or non-numeric values', async () => {
    for (const bad of ['-0.1', '1.5', 'abc', '1.1', '2']) {
      await withEnv({ ...BASE, INPUT_CUSTOM_SWE_SCORE: bad }, async () => {
        const config = await loadConfig();
        assert.strictEqual(config.customSweScore, 0.5, `value "${bad}" should fall back to 0.5`);
      });
    }
  });

  it('warns and falls back on invalid chain_timeout', async () => {
    await withEnv({ ...BASE, INPUT_CHAIN_TIMEOUT: 'abc' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.chainTimeout, 0);
    });
  });
});

describe('loadConfig — parallel fields', () => {
  const BASE = {
    INPUT_NIM_API_KEY: 'nim-key',
    INPUT_NIM_BASE_URL: '',
    INPUT_NIM_MODELS: '',
    INPUT_MAX_FILES: '',
    INPUT_EXCLUDE_PATTERNS: '',
    INPUT_NIM_SYSTEM_PROMPT: '',
    INPUT_NIM_PROMPT_MODE: '',
    INPUT_OPENROUTER_API_KEY: '',
    INPUT_OPENROUTER_MODELS: '',
    INPUT_MODEL_TIMEOUT: '',
    INPUT_CHAIN_TIMEOUT: '',
    INPUT_PARALLEL_ATTEMPTS: '',
    INPUT_PARALLEL_THRESHOLD: '',
  };

  it('defaults parallelAttempts to 3 and parallelThreshold to 40', async () => {
    await withEnv({ ...BASE }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 3);
      assert.strictEqual(config.parallelThreshold, 40);
    });
  });

  it('reads custom valid values', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '2', INPUT_PARALLEL_THRESHOLD: '20' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 2);
      assert.strictEqual(config.parallelThreshold, 20);
    });
  });

  it('accepts boundary values 1 and 5 for parallel_attempts', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '1' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 1);
    });
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '5' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 5);
    });
  });

  it('accepts boundary values 5 and 120 for parallel_threshold', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: '5' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelThreshold, 5);
    });
    await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: '120' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelThreshold, 120);
    });
  });

  it('warns and falls back to 3 for out-of-range or non-numeric parallel_attempts', async () => {
    for (const bad of ['0', '6', '-1', 'abc']) {
      await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: bad }, async () => {
        const config = await loadConfig();
        assert.strictEqual(config.parallelAttempts, 3, `value "${bad}" should fall back to 3`);
      });
    }
  });

  it('warns and falls back to 40 for out-of-range or non-numeric parallel_threshold', async () => {
    for (const bad of ['4', '121', '-1', 'abc', '0']) {
      await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: bad }, async () => {
        const config = await loadConfig();
        assert.strictEqual(config.parallelThreshold, 40, `value "${bad}" should fall back to 40`);
      });
    }
  });
});
