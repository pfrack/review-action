import { describe, it } from 'node:test';
import assert from 'node:assert';
import { escapeMarkdown, validateProviderUrl } from './utils.js';
import { loadConfig } from './config.js';
describe('escapeMarkdown — HTML entity escaping', () => {
    it('escapes < character', () => {
        assert.strictEqual(escapeMarkdown('<script>'), '\\<script\\>');
    });
    it('escapes > character', () => {
        assert.strictEqual(escapeMarkdown('a > b'), 'a \\> b');
    });
    it('escapes & character', () => {
        assert.strictEqual(escapeMarkdown('foo & bar'), 'foo \\& bar');
    });
    it('escapes combined HTML injection attempt', () => {
        const input = '<img src=x onerror=alert(1)>';
        const result = escapeMarkdown(input);
        assert.ok(result.startsWith('\\<'));
        assert.ok(result.endsWith('\\>'));
        assert.ok(!result.startsWith('<'));
    });
    it('still escapes original markdown characters', () => {
        assert.strictEqual(escapeMarkdown('*bold*'), '\\*bold\\*');
        assert.strictEqual(escapeMarkdown('_italic_'), '\\_italic\\_');
        assert.strictEqual(escapeMarkdown('[link](url)'), '\\[link\\]\\(url\\)');
    });
});
describe('validateProviderUrl — SSRF blocklist', () => {
    it('blocks 169.254.169.254 (AWS/Azure metadata)', () => {
        assert.throws(() => validateProviderUrl('https://169.254.169.254/latest/meta-data/', 'custom_api_url'), /blocked.*link-local/);
    });
    it('blocks metadata.google.internal', () => {
        assert.throws(() => validateProviderUrl('https://metadata.google.internal/computeMetadata/v1/', 'custom_api_url'), /blocked.*metadata\.google\.internal/);
    });
    it('allows api.example.com', () => {
        assert.doesNotThrow(() => validateProviderUrl('https://api.example.com/v1', 'custom_api_url'));
    });
    it('allows standard provider URLs', () => {
        assert.doesNotThrow(() => validateProviderUrl('https://integrate.api.nvidia.com/v1', 'nim_base_url'));
        assert.doesNotThrow(() => validateProviderUrl('https://api.mistral.ai/v1', 'mistral_base_url'));
        assert.doesNotThrow(() => validateProviderUrl('https://api.groq.com/openai/v1', 'groq_base_url'));
    });
    it('blocks other 169.254.x.x link-local addresses', () => {
        assert.throws(() => validateProviderUrl('https://169.254.0.1/path', 'test'), /blocked.*link-local/);
    });
    it('allows RFC1918 addresses (self-hosted runners)', () => {
        assert.doesNotThrow(() => validateProviderUrl('https://10.0.0.1/v1', 'test'));
        assert.doesNotThrow(() => validateProviderUrl('https://192.168.1.1/v1', 'test'));
        assert.doesNotThrow(() => validateProviderUrl('https://172.16.0.1/v1', 'test'));
    });
});
describe('loadConfig — max_files validation', () => {
    const ENV_KEYS = [
        'INPUT_MAX_FILES', 'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL',
        'INPUT_NIM_MODELS', 'INPUT_EXCLUDE_PATTERNS', 'INPUT_NIM_SYSTEM_PROMPT',
        'INPUT_NIM_PROMPT_MODE',
    ];
    const saved = {};
    function setup(maxFiles) {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_MAX_FILES'] = maxFiles;
        process.env['INPUT_NIM_API_KEY'] = 'test-key';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = 'model-a';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = 'append';
    }
    function teardown() {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    }
    it('rejects -5 (negative)', () => {
        setup('-5');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 100);
        }
        finally {
            teardown();
        }
    });
    it('rejects 0', () => {
        setup('0');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 100);
        }
        finally {
            teardown();
        }
    });
    it('rejects 5e3 (exponential notation)', () => {
        setup('5e3');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 100);
        }
        finally {
            teardown();
        }
    });
    it('rejects 501 (over max)', () => {
        setup('501');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 100);
        }
        finally {
            teardown();
        }
    });
    it('accepts 1 (minimum valid)', () => {
        setup('1');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 1);
        }
        finally {
            teardown();
        }
    });
    it('accepts 100 (default)', () => {
        setup('100');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 100);
        }
        finally {
            teardown();
        }
    });
    it('accepts 500 (maximum valid)', () => {
        setup('500');
        try {
            const config = loadConfig();
            assert.strictEqual(config.maxFiles, 500);
        }
        finally {
            teardown();
        }
    });
});
