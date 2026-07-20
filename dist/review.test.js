import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { parseDiff, shouldExclude, resolveSystemPrompt, loadConfig, reviewFileWithFallback } from './review.js';
import { NimClient } from './nim-client.js';
describe('parseDiff', () => {
    it('splits multi-file diffs', () => {
        const raw = `diff --git a/main.go b/main.go
index 1234567..abcdefg 100644
--- a/main.go
+++ b/main.go
@@ -1,3 +1,4 @@
 package main

+// Added comment
 func main() {}
diff --git a/config.yaml b/config.yaml
new file mode 100644
--- /dev/null
+++ b/config.yaml
@@ -0,0 +1,2 @@
+key: value
`;
        const files = parseDiff(raw);
        assert.strictEqual(Object.keys(files).length, 2);
        assert.ok('main.go' in files);
        assert.ok('config.yaml' in files);
    });
    it('returns empty for empty input', () => {
        const files = parseDiff('');
        assert.strictEqual(Object.keys(files).length, 0);
    });
});
describe('shouldExclude', () => {
    const tests = [
        { name: 'exact match', filepath: 'go.sum', patterns: ['go.sum', '*.lock'], want: true },
        { name: 'wildcard match via basename', filepath: 'vendor/github.com/foo/bar.go', patterns: ['*.go'], want: true },
        { name: 'basename match', filepath: 'deep/nested/path/go.sum', patterns: ['*.sum'], want: true },
        { name: 'no match', filepath: 'main.go', patterns: ['*.lock', '*.md'], want: false },
        { name: 'empty patterns', filepath: 'anything.go', patterns: [], want: false },
        { name: 'image file', filepath: 'assets/logo.png', patterns: ['*.png', '*.svg'], want: true },
        { name: 'markdown file', filepath: 'README.md', patterns: ['*.md'], want: true },
    ];
    for (const tt of tests) {
        it(tt.name, () => {
            assert.strictEqual(shouldExclude(tt.filepath, tt.patterns), tt.want);
        });
    }
});
describe('resolveSystemPrompt', () => {
    const baseConfig = {
        baseURL: '',
        apiKey: '',
        models: [],
        mistralApiKey: '',
        mistralBaseUrl: '',
        mistralModels: [],
        customApiUrl: '',
        customModel: '',
        customApiKey: '',
        maxFiles: 15,
        excludePatterns: [],
        systemPrompt: '',
        promptMode: 'append',
    };
    it('returns base prompt when no env and no lang match', () => {
        const prompt = resolveSystemPrompt('config.yaml', baseConfig);
        assert.ok(prompt.includes('code review'));
        assert.ok(prompt.includes('Severity'));
    });
    it('returns lang prompt when no env and lang matches', () => {
        const prompt = resolveSystemPrompt('main.go', baseConfig);
        assert.ok(prompt.includes('Go code'));
        assert.ok(prompt.includes('Goroutine'));
    });
    it('returns env prompt in replace mode', () => {
        const prompt = resolveSystemPrompt('main.go', {
            ...baseConfig,
            systemPrompt: 'You are a security auditor.',
            promptMode: 'replace',
        });
        assert.strictEqual(prompt, 'You are a security auditor.');
    });
    it('appends env prompt to lang template in append mode', () => {
        const prompt = resolveSystemPrompt('app.py', {
            ...baseConfig,
            systemPrompt: 'Focus on security.',
            promptMode: 'append',
        });
        assert.ok(prompt.includes('Focus on security.'));
        assert.ok(prompt.includes('Python code'));
        assert.ok(prompt.includes('Mutable default'));
    });
    it('appends env prompt to base when no lang match', () => {
        const prompt = resolveSystemPrompt('config.yaml', {
            ...baseConfig,
            systemPrompt: 'Focus on security.',
            promptMode: 'append',
        });
        assert.ok(prompt.includes('Focus on security.'));
        assert.ok(prompt.includes('code review'));
    });
});
describe('loadConfig — mistral fields', () => {
    const ENV_KEYS = [
        'INPUT_MISTRAL_API_KEY', 'INPUT_MISTRAL_MODELS',
        'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
        'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
        'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
    ];
    const saved = {};
    it('reads mistralApiKey and mistralModels from inputs', () => {
        // Save original values
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_MISTRAL_API_KEY'] = 'test-mistral-key';
        process.env['INPUT_MISTRAL_MODELS'] = 'mistral-medium-3.5,codestral-2508';
        process.env['INPUT_NIM_API_KEY'] = 'test-nim-key';
        process.env['INPUT_NIM_BASE_URL'] = 'https://integrate.api.nvidia.com/v1';
        process.env['INPUT_NIM_MODELS'] = 'deepseek-ai/deepseek-v4-pro';
        process.env['INPUT_MAX_FILES'] = '50';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '*.lock';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = 'append';
        const config = loadConfig();
        assert.strictEqual(config.mistralApiKey, 'test-mistral-key');
        assert.deepStrictEqual(config.mistralModels, ['mistral-medium-3.5', 'codestral-2508']);
        assert.strictEqual(config.apiKey, 'test-nim-key');
        assert.deepStrictEqual(config.models, ['deepseek-ai/deepseek-v4-pro']);
        // Restore original values
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
    it('defaults mistral fields to empty when not provided', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_MISTRAL_API_KEY'] = '';
        process.env['INPUT_MISTRAL_MODELS'] = '';
        process.env['INPUT_NIM_API_KEY'] = 'nim-key';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.mistralApiKey, '');
        assert.deepStrictEqual(config.mistralModels, ['mistral-medium-3.5', 'mistral-large-2512', 'mistral-small-2603', 'codestral-2508']);
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
});
describe('loadConfig — custom fields', () => {
    const ENV_KEYS = [
        'INPUT_CUSTOM_API_URL', 'INPUT_CUSTOM_MODEL', 'INPUT_CUSTOM_API_KEY',
        'INPUT_NIM_API_KEY', 'INPUT_NIM_BASE_URL', 'INPUT_NIM_MODELS',
        'INPUT_MAX_FILES', 'INPUT_EXCLUDE_PATTERNS',
        'INPUT_NIM_SYSTEM_PROMPT', 'INPUT_NIM_PROMPT_MODE',
    ];
    const saved = {};
    it('reads customApiUrl, customModel, customApiKey from inputs', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_CUSTOM_API_URL'] = 'https://openrouter.ai/api/v1';
        process.env['INPUT_CUSTOM_MODEL'] = 'openai/gpt-4o';
        process.env['INPUT_CUSTOM_API_KEY'] = 'sk-or-v1-abc';
        process.env['INPUT_NIM_API_KEY'] = '';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.customApiUrl, 'https://openrouter.ai/api/v1');
        assert.strictEqual(config.customModel, 'openai/gpt-4o');
        assert.strictEqual(config.customApiKey, 'sk-or-v1-abc');
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
    it('defaults custom fields to empty when not provided', () => {
        for (const key of ENV_KEYS)
            saved[key] = process.env[key];
        process.env['INPUT_CUSTOM_API_URL'] = '';
        process.env['INPUT_CUSTOM_MODEL'] = '';
        process.env['INPUT_CUSTOM_API_KEY'] = '';
        process.env['INPUT_NIM_API_KEY'] = 'nim-key';
        process.env['INPUT_NIM_BASE_URL'] = '';
        process.env['INPUT_NIM_MODELS'] = '';
        process.env['INPUT_MAX_FILES'] = '';
        process.env['INPUT_EXCLUDE_PATTERNS'] = '';
        process.env['INPUT_NIM_SYSTEM_PROMPT'] = '';
        process.env['INPUT_NIM_PROMPT_MODE'] = '';
        const config = loadConfig();
        assert.strictEqual(config.customApiUrl, '');
        assert.strictEqual(config.customModel, '');
        assert.strictEqual(config.customApiKey, '');
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = saved[key];
        }
    });
});
describe('reviewFileWithFallback — routing', () => {
    const testConfig = {
        baseURL: 'http://nim.test',
        apiKey: 'nim-key',
        models: ['nim-model'],
        mistralApiKey: 'mistral-key',
        mistralBaseUrl: 'https://api.mistral.ai/v1',
        mistralModels: ['mistral-model'],
        customApiUrl: '',
        customModel: '',
        customApiKey: '',
        maxFiles: 10,
        excludePatterns: [],
        systemPrompt: '',
        promptMode: 'append',
    };
    it('routes to correct client based on provider tag', async () => {
        let nimCalled = false;
        let mistralCalled = false;
        const server = createServer((req, res) => {
            const url = new URL(req.url, `http://localhost`);
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const parsed = JSON.parse(body);
                if (parsed.model === 'nim-model')
                    nimCalled = true;
                if (parsed.model === 'mistral-model')
                    mistralCalled = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: `Review from ${parsed.model}` } }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }));
            });
        });
        await new Promise(resolve => server.listen(0, resolve));
        try {
            const port = server.address().port;
            const baseUrl = `http://localhost:${port}`;
            const nimClient = new NimClient(baseUrl, 'nim-key');
            const mistralClient = new NimClient(baseUrl, 'mistral-key');
            const clients = {
                nim: nimClient,
                mistral: mistralClient,
                custom: null,
            };
            // Mistral first in chain
            const chain = [
                { id: 'mistral-model', provider: 'mistral' },
                { id: 'nim-model', provider: 'nim' },
            ];
            const result = await reviewFileWithFallback(clients, 'test.ts', '+ line', chain, testConfig);
            assert.ok(result.includes('mistral-model'));
            assert.strictEqual(mistralCalled, true);
            assert.strictEqual(nimCalled, false); // shouldn't reach NIM since Mistral succeeds
        }
        finally {
            server.close();
        }
    });
    it('falls through to next provider on failure', async () => {
        let callCount = 0;
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                callCount++;
                const parsed = JSON.parse(body);
                if (parsed.model === 'fail-model') {
                    res.writeHead(500);
                    res.end('Internal Error');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: `Review from ${parsed.model}` } }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }));
            });
        });
        await new Promise(resolve => server.listen(0, resolve));
        try {
            const port = server.address().port;
            const baseUrl = `http://localhost:${port}`;
            const nimClient = new NimClient(baseUrl, 'nim-key');
            const mistralClient = new NimClient(baseUrl, 'mistral-key');
            const clients = {
                nim: nimClient,
                mistral: mistralClient,
                custom: null,
            };
            const chain = [
                { id: 'fail-model', provider: 'mistral' },
                { id: 'nim-model', provider: 'nim' },
            ];
            const result = await reviewFileWithFallback(clients, 'test.ts', '+ line', chain, testConfig);
            assert.ok(result.includes('nim-model'));
            assert.strictEqual(callCount, 2);
        }
        finally {
            server.close();
        }
    });
    it('skips models whose client is null', async () => {
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const parsed = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: `Review from ${parsed.model}` } }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }));
            });
        });
        await new Promise(resolve => server.listen(0, resolve));
        try {
            const port = server.address().port;
            const baseUrl = `http://localhost:${port}`;
            const nimClient = new NimClient(baseUrl, 'nim-key');
            const clients = {
                nim: nimClient,
                mistral: null, // No Mistral client
                custom: null,
            };
            const chain = [
                { id: 'mistral-model', provider: 'mistral' },
                { id: 'nim-model', provider: 'nim' },
            ];
            const result = await reviewFileWithFallback(clients, 'test.ts', '+ line', chain, testConfig);
            assert.ok(result.includes('nim-model'));
        }
        finally {
            server.close();
        }
    });
    it('throws when all models fail', async () => {
        const server = createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                res.writeHead(500);
                res.end('Error');
            });
        });
        await new Promise(resolve => server.listen(0, resolve));
        try {
            const port = server.address().port;
            const baseUrl = `http://localhost:${port}`;
            const nimClient = new NimClient(baseUrl, 'nim-key');
            const clients = {
                nim: nimClient,
                mistral: null,
                custom: null,
            };
            const chain = [
                { id: 'nim-model', provider: 'nim' },
            ];
            await assert.rejects(() => reviewFileWithFallback(clients, 'test.ts', '+ line', chain, testConfig), /All models failed for test.ts/);
        }
        finally {
            server.close();
        }
    });
});
