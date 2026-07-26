import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from './config.js';
describe('loadConfig — OpenRouter fields', () => {
    const ENV_KEYS = [
        'INPUT_OPENROUTER_API_KEY', 'INPUT_OPENROUTER_BASE_URL', 'INPUT_OPENROUTER_MODELS',
        'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
        'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
        'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
    ];
    const saved = {};
    it('reads OpenRouter API key and models', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
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
        const config = loadConfig();
        assert.strictEqual(config.openRouterApiKey, 'sk-or-v1-key');
        assert.strictEqual(config.openRouterBaseUrl, 'https://openrouter.ai/api/v1');
        assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'google/gemini-2.0-flash-exp:free']);
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
    it('defaults OpenRouter fields to empty when not provided', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_OPENROUTER_API_KEY'] = '';
        process.env['INPUT_OPENROUTER_MODELS'] = '';
        process.env['INPUT_NIM_API_KEY'] = 'nim-key';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.openRouterApiKey, '');
        assert.deepStrictEqual(config.openRouterModels, ['deepseek/deepseek-r1:free', 'meta-llama/llama-4-maverick:free', 'google/gemini-2.0-flash-exp:free']);
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
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
    const saved = {};
    it('reads Kilo API key and models', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_KILOCODE_API_KEY'] = 'kilo-key';
        process.env['INPUT_KILOCODE_MODELS'] = 'kilo-auto/balanced:free';
        process.env['INPUT_KILOCODE_BASE_URL'] = 'https://api.kilo.ai/api/gateway';
        process.env['INPUT_NIM_API_KEY'] = '';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.kiloApiKey, 'kilo-key');
        assert.strictEqual(config.kiloBaseUrl, 'https://api.kilo.ai/api/gateway');
        assert.deepStrictEqual(config.kiloModels, ['kilo-auto/balanced:free']);
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
    it('defaults Kilo fields to empty when not provided', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_KILOCODE_API_KEY'] = '';
        process.env['INPUT_KILOCODE_MODELS'] = '';
        process.env['INPUT_NIM_API_KEY'] = 'nim-key';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.kiloApiKey, '');
        assert.deepStrictEqual(config.kiloModels, ['kilo-auto/balanced:free', 'kilo-auto/frontier:free']);
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
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
    const saved = {};
    it('parses custom_models CSV and defaults base URL to custom_api_url', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
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
        const config = loadConfig();
        assert.deepStrictEqual(config.customModels, ['model-a', 'model-b']);
        assert.strictEqual(config.customModelsBaseUrl, 'https://api.example.com/v1');
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
    it('custom_models empty when not provided', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
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
        const config = loadConfig();
        assert.deepStrictEqual(config.customModels, []);
        assert.strictEqual(config.customModelsBaseUrl, '');
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
});
