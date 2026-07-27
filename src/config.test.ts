import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig, filterFreeOnly, isFreeModel } from './config.js';

describe('loadConfig — OpenRouter fields', () => {
  const ENV_KEYS = [
    'INPUT_OPENROUTER_API_KEY', 'INPUT_OPENROUTER_BASE_URL', 'INPUT_OPENROUTER_MODELS',
    'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
    'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
    'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
  ];
  const saved: Record<string, string | undefined> = {};

  it('reads OpenRouter API key and models', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_OPENROUTER_API_KEY'] = 'sk-or-v1-key';
    process.env['INPUT_OPENROUTER_MODELS'] = 'deepseek/deepseek-r1:free,google/gemini-2.0-flash-exp:free';
    process.env['INPUT_OPENROUTER_BASE_URL'] = 'https://openrouter.ai/api/v1';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.openRouterApiKey, 'sk-or-v1-key');
    assert.strictEqual(config.openRouterBaseUrl, 'https://openrouter.ai/api/v1');
    assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults OpenRouter models to empty when no key and no models provided', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_OPENROUTER_API_KEY'] = '';
    process.env['INPUT_OPENROUTER_MODELS'] = '';
    process.env['INPUT_NIM_API_KEY'] = 'nim-key';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.openRouterApiKey, '');
    assert.deepStrictEqual(config.openRouterModels, []);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
});

describe('loadConfig — Kilo fields', () => {
  const ENV_KEYS = [
    'INPUT_KILOCODE_API_KEY', 'INPUT_KILOCODE_BASE_URL', 'INPUT_KILOCODE_MODELS',
    'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
    'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
    'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
  ];
  const saved: Record<string, string | undefined> = {};

  it('reads Kilo API key and models', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_KILOCODE_API_KEY'] = 'kilo-key';
    process.env['INPUT_KILOCODE_MODELS'] = 'kilo-auto/free';
    process.env['INPUT_KILOCODE_BASE_URL'] = 'https://api.kilo.ai/api/gateway';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.kiloApiKey, 'kilo-key');
    assert.strictEqual(config.kiloBaseUrl, 'https://api.kilo.ai/api/gateway');
    assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults Kilo models to empty when no key and no models provided', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_KILOCODE_API_KEY'] = '';
    process.env['INPUT_KILOCODE_MODELS'] = '';
    process.env['INPUT_NIM_API_KEY'] = 'nim-key';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.kiloApiKey, '');
    assert.deepStrictEqual(config.kiloModels, []);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
});

describe('loadConfig — custom_models CSV', () => {
  const ENV_KEYS = [
    'INPUT_CUSTOM_MODELS', 'INPUT_CUSTOM_MODELS_BASE_URL', 'INPUT_CUSTOM_API_URL',
    'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
    'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
    'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
  ];
  const saved: Record<string, string | undefined> = {};

  it('parses custom_models CSV and defaults base URL to custom_api_url', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_CUSTOM_MODELS'] = 'model-a, model-b';
    process.env['INPUT_CUSTOM_API_URL'] = 'https://api.example.com/v1';
    process.env['INPUT_CUSTOM_MODELS_BASE_URL'] = '';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.deepStrictEqual(config.customModels, ['model-a', 'model-b']);
    assert.strictEqual(config.customModelsBaseUrl, 'https://api.example.com/v1');

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('custom_models empty when not provided', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_CUSTOM_MODELS'] = '';
    process.env['INPUT_CUSTOM_API_URL'] = '';
    process.env['INPUT_CUSTOM_MODELS_BASE_URL'] = '';
    process.env['INPUT_NIM_API_KEY'] = 'nim-key';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.deepStrictEqual(config.customModels, []);
    assert.strictEqual(config.customModelsBaseUrl, '');

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
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
  const ENV_KEYS = [
    'INPUT_OPENROUTER_API_KEY', 'INPUT_OPENROUTER_MODELS', 'INPUT_OPENROUTER_FREE_ONLY',
    'INPUT_KILOCODE_API_KEY', 'INPUT_KILOCODE_MODELS', 'INPUT_KILOCODE_FREE_ONLY',
    'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
    'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
    'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
  ];
  const saved: Record<string, string | undefined> = {};

  it('filters OpenRouter models to free-only when openrouter_free_only is true', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_OPENROUTER_API_KEY'] = 'or-key';
    process.env['INPUT_OPENROUTER_MODELS'] = 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free';
    process.env['INPUT_OPENROUTER_FREE_ONLY'] = 'true';
    process.env['INPUT_KILOCODE_API_KEY'] = '';
    process.env['INPUT_KILOCODE_MODELS'] = '';
    process.env['INPUT_KILOCODE_FREE_ONLY'] = '';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.openRouterFreeOnly, true);
    assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('does not filter OpenRouter models when openrouter_free_only is false', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_OPENROUTER_API_KEY'] = 'or-key';
    process.env['INPUT_OPENROUTER_MODELS'] = 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free';
    process.env['INPUT_OPENROUTER_FREE_ONLY'] = 'false';
    process.env['INPUT_KILOCODE_API_KEY'] = '';
    process.env['INPUT_KILOCODE_MODELS'] = '';
    process.env['INPUT_KILOCODE_FREE_ONLY'] = '';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.openRouterFreeOnly, false);
    assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'meta-llama/llama-4-maverick', 'google/gemini-2.0-flash-exp:free']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('filters Kilo models to free-only when kilocode_free_only is true', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_KILOCODE_API_KEY'] = 'kilo-key';
    process.env['INPUT_KILOCODE_MODELS'] = 'kilo-auto/free,kilo-auto/premium';
    process.env['INPUT_KILOCODE_FREE_ONLY'] = 'true';
    process.env['INPUT_OPENROUTER_API_KEY'] = '';
    process.env['INPUT_OPENROUTER_MODELS'] = '';
    process.env['INPUT_OPENROUTER_FREE_ONLY'] = '';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.kiloFreeOnly, true);
    assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('does not filter Kilo models when kilocode_free_only is false', async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

    process.env['INPUT_KILOCODE_API_KEY'] = 'kilo-key';
    process.env['INPUT_KILOCODE_MODELS'] = 'kilo-auto/free,kilo-auto/premium';
    process.env['INPUT_KILOCODE_FREE_ONLY'] = 'false';
    process.env['INPUT_OPENROUTER_API_KEY'] = '';
    process.env['INPUT_OPENROUTER_MODELS'] = '';
    process.env['INPUT_OPENROUTER_FREE_ONLY'] = '';
    process.env['INPUT_NIM_API_KEY'] = '';
    process.env['INPUT_NIM_BASE_URL'] = '';
    process.env['INPUT_NIM_MODELS'] = '';
    process.env['INPUT_MAX_FILES'] = '';
    process.env['INPUT_EXCLUDE_PATTERNS'] = '';
    process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
    process.env['INPUT_NIM_PROMPT_MODE'] = '';

    const config = await loadConfig();

    assert.strictEqual(config.kiloFreeOnly, false);
    assert.deepStrictEqual(config.kiloModels, ['kilo-auto/free', 'kilo-auto/premium']);

    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
});
