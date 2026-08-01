import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OpenAIClient } from './openai-client.js';
import { ReviewJsonSchema } from './review-schema.js';
import { validateFindings } from './review.js';
import { severityTally } from './render.js';
import { buildSystemMessage, BASE_SYSTEM_PROMPT, SEVERITY_GUIDANCE } from './prompts.js';
import { JSON_SCHEMA_DEFINITION } from './review-schema.js';
import { startMockServer } from './test-utils.js';
import { computeMaxTokens, runModelChainForBatch, buildClients, withAggregateTimeout } from './index.js';
describe('buildSystemMessage', () => {
    it('returns BASE_SYSTEM_PROMPT when no custom prompt', () => {
        const msg = buildSystemMessage('append', '');
        assert.strictEqual(msg, BASE_SYSTEM_PROMPT);
    });
    it('appends custom prompt in append mode', () => {
        const msg = buildSystemMessage('append', 'custom rules');
        assert.strictEqual(msg, `${BASE_SYSTEM_PROMPT}\n\ncustom rules`);
    });
    it('replaces base with custom prompt in replace mode', () => {
        const msg = buildSystemMessage('replace', 'override text');
        assert.strictEqual(msg, `override text\n\n## Framework guidance\n${JSON_SCHEMA_DEFINITION}\n${SEVERITY_GUIDANCE}`);
    });
    it('falls back to BASE_SYSTEM_PROMPT in replace mode with empty custom prompt', () => {
        const msg = buildSystemMessage('replace', '');
        assert.strictEqual(msg, BASE_SYSTEM_PROMPT);
    });
});
describe('OpenAIClient integration', () => {
    it('returns parsed content on successful chat', async () => {
        const mock = await startMockServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: 'test response' } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await client.chat('model', [{ role: 'user', content: 'hello' }], {
                schema: ReviewJsonSchema,
                format: 'json_schema',
            });
            assert.ok(result.content.length > 0);
        }
        finally {
            mock.close();
        }
    });
});
describe('severityTally', () => {
    it('counts mixed severities', () => {
        const review = {
            findings: [
                { file: 'a.ts', severity: 'Critical', issue: '', critical_action: '', warning_action: 'not applicable', suggestion_action: 'not applicable' },
                { file: 'b.ts', severity: 'Warning', issue: '', critical_action: 'not applicable', warning_action: '', suggestion_action: 'not applicable' },
                { file: 'c.ts', severity: 'Suggestion', issue: '', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: '' },
            ],
            summary: '',
        };
        const { critical, warning, suggestion } = severityTally(review);
        assert.strictEqual(critical, 1);
        assert.strictEqual(warning, 1);
        assert.strictEqual(suggestion, 1);
    });
    it('returns zeros for empty findings', () => {
        const review = { findings: [], summary: '' };
        const { critical, warning, suggestion } = severityTally(review);
        assert.strictEqual(critical, 0);
        assert.strictEqual(warning, 0);
        assert.strictEqual(suggestion, 0);
    });
});
describe('validateFindings edge cases', () => {
    it('returns summary when all findings dropped', async () => {
        const result = await validateFindings({ findings: [], summary: '' }, {}, new Set());
        assert.strictEqual(result.valid.findings.length, 0);
        assert.ok(result.valid.summary && result.valid.summary.includes('invalid'));
    });
    it('preserves summary from review when valid findings exist', async () => {
        const diffText = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,5 +1,6 @@\n line1\n+added line\n';
        const review = {
            findings: [
                { file: 'a.ts', line_start: 2, severity: 'Warning', issue: 'test', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' },
            ],
            summary: 'my summary',
        };
        const result = await validateFindings(review, { 'a.ts': diffText }, new Set(['a.ts']));
        assert.strictEqual(result.valid.findings.length, 1);
        assert.strictEqual(result.valid.summary, 'my summary');
    });
});
describe('withAggregateTimeout', () => {
    it('returns null when timer fires before operation completes', async () => {
        const result = await withAggregateTimeout(() => new Promise(resolve => setTimeout(() => resolve('late'), 500)), 50);
        assert.strictEqual(result, null);
    });
    it('returns result when operation completes before timer', async () => {
        const result = await withAggregateTimeout(() => new Promise(resolve => setTimeout(() => resolve('fast'), 10)), 5000);
        assert.strictEqual(result, 'fast');
    });
});
const VALID_REVIEW_JSON = JSON.stringify({
    findings: [
        {
            file: 'src/a.ts',
            severity: 'Warning',
            issue: 'unused variable',
            critical_action: 'not applicable',
            warning_action: 'remove unused variable',
            suggestion_action: 'not applicable',
        },
    ],
    summary: 'review summary',
});
const VALID_CHAT_RESULT = {
    content: VALID_REVIEW_JSON,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    latency: 100,
    finishReason: 'stop',
};
const TRUNCATED_CHAT_RESULT = {
    content: '{ "findings": [ { "file": "src/a.ts", "severity": "Warni',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    latency: 100,
    finishReason: 'length',
};
function makeConfig(overrides = {}) {
    return {
        baseURL: 'http://localhost',
        apiKey: '',
        models: ['test-model'],
        mistralApiKey: '',
        mistralBaseUrl: '',
        mistralModels: [],
        groqApiKey: '',
        groqModels: [],
        groqBaseUrl: '',
        openRouterApiKey: '',
        openRouterModels: [],
        openRouterBaseUrl: '',
        openRouterFreeOnly: false,
        kiloApiKey: '',
        kiloModels: [],
        kiloBaseUrl: '',
        kiloFreeOnly: false,
        customApiUrl: '',
        customModel: '',
        customApiKey: '',
        customModels: [],
        customModelsBaseUrl: '',
        customSweScore: 0.5,
        maxFiles: 100,
        excludePatterns: [],
        systemPrompt: '',
        promptMode: 'append',
        customRules: '',
        revalidateFindings: false,
        dropUnreferenced: false,
        modelTimeout: 90,
        chainTimeout: 0,
        maxTokens: 0,
        parallelAttempts: 1,
        parallelThreshold: 40,
        ...overrides,
    };
}
function makeMockClient(behaviorForModel, callCounts = {}) {
    const client = Object.create(OpenAIClient.prototype);
    client.chat = async (model, _messages, opts) => {
        callCounts[model] = (callCounts[model] || 0) + 1;
        if (opts?.signal?.aborted) {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            throw err;
        }
        const { response, delayMs = 0, shouldThrow = false } = behaviorForModel(model);
        if (delayMs > 0) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve(), delayMs);
                opts?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    const err = new Error('The operation was aborted due to timeout');
                    err.name = 'AbortError';
                    reject(err);
                }, { once: true });
            }).catch((err) => {
                throw err;
            });
        }
        if (shouldThrow) {
            throw new Error('mock failure');
        }
        return response ?? VALID_CHAT_RESULT;
    };
    return client;
}
const TEST_BATCH = {
    files: ['src/a.ts'],
    diffs: { 'src/a.ts': 'diff --git a/src/a.ts b/src/a.ts\n+added line\n' },
};
const TEST_CHAIN = [
    { id: 'model-a', provider: 'nim' },
    { id: 'model-b', provider: 'nim' },
    { id: 'model-c', provider: 'nim' },
];
describe('computeMaxTokens', () => {
    it('uses explicit maxTokens when provided', () => {
        assert.strictEqual(computeMaxTokens('a'.repeat(1000), 2048), 2048);
    });
    it('caps explicit maxTokens at 16384', () => {
        assert.strictEqual(computeMaxTokens('a'.repeat(1000), 32768), 16384);
    });
    it('scales output budget up with larger diffs', () => {
        const smallDiff = 'a'.repeat(100);
        const largeDiff = 'a'.repeat(12000);
        const smallTokens = computeMaxTokens(smallDiff, 0);
        const largeTokens = computeMaxTokens(largeDiff, 0);
        assert.ok(smallTokens > 4096);
        assert.ok(largeTokens > smallTokens);
    });
    it('caps adaptive maxTokens at 16384 for huge diffs', () => {
        const hugeDiff = 'a'.repeat(200000);
        assert.strictEqual(computeMaxTokens(hugeDiff, 0), 16384);
    });
    it('returns more than 4096 for tiny diffs', () => {
        const tinyDiff = 'a'.repeat(3);
        const tokens = computeMaxTokens(tinyDiff, 0);
        assert.ok(tokens > 4096);
    });
});
describe('runModelChainForBatch sequential fallback', () => {
    it('returns first model that succeeds', async () => {
        const config = makeConfig();
        const callCounts = {};
        const clients = {
            nim: makeMockClient(() => ({}), callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        assert.strictEqual(result.usedModel, 'model-a');
        assert.strictEqual(result.findings.length, 1);
        assert.strictEqual(callCounts['model-a'], 1);
    });
    it('falls through to next model on failure', async () => {
        const config = makeConfig();
        const callCounts = {};
        const clients = {
            nim: makeMockClient((model) => {
                if (model === 'model-a')
                    return { shouldThrow: true };
                return {};
            }, callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        assert.strictEqual(result.usedModel, 'model-b');
        assert.strictEqual(result.findings.length, 1);
        assert.strictEqual(callCounts['model-a'], 1);
        assert.strictEqual(callCounts['model-b'], 1);
    });
    it('returns empty result when all models fail', async () => {
        const config = makeConfig();
        const clients = {
            nim: makeMockClient(() => ({ shouldThrow: true })),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        assert.strictEqual(result.findings.length, 0);
        assert.strictEqual(result.usedModel, '');
    });
    it('handles truncated response by trying next model', async () => {
        const config = makeConfig();
        const callCounts = {};
        let retryAttempted = false;
        const clients = {
            nim: makeMockClient((model) => {
                if (model === 'model-a')
                    return { response: TRUNCATED_CHAT_RESULT };
                return {};
            }, callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        // model-a: truncated → safeParseJson fails → returns null, no retry
        // model-b: succeeds
        assert.strictEqual(result.usedModel, 'model-b');
        assert.strictEqual(result.findings.length, 1);
    });
    it('retries once on schema validation failure, then falls through', async () => {
        const config = makeConfig();
        const callCounts = {};
        const clients = {
            nim: makeMockClient((model) => {
                const call = callCounts[model] || 0;
                if (model === 'model-a' && call <= 2) {
                    // First attempt returns invalid JSON (not truncated, just wrong schema)
                    return { response: {
                            content: '{"wrong": "schema"}',
                            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
                            latency: 100,
                            finishReason: 'stop',
                        } };
                }
                return {};
            }, callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        // model-a: invalid schema → retry → still invalid → fall through
        // model-b: succeeds
        assert.strictEqual(result.usedModel, 'model-b');
        assert.strictEqual(callCounts['model-a'], 2);
    });
});
describe('runModelChainForBatch parallel fallback', () => {
    it('picks winner when parallel mode enabled and head model succeeds', async () => {
        const config = makeConfig({ parallelAttempts: 3, parallelThreshold: 0 });
        const callCounts = {};
        const clients = {
            nim: makeMockClient(() => ({}), callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        assert.strictEqual(result.findings.length, 1);
        assert.strictEqual(result.usedModel, 'model-a');
    });
    it('returns result from fast model when slow model is tried first', async () => {
        const config = makeConfig({ parallelAttempts: 2, parallelThreshold: 0 });
        const callCounts = {};
        const chain = [
            { id: 'slow-model', provider: 'nim' },
            { id: 'fast-model', provider: 'nim' },
        ];
        const clients = {
            nim: makeMockClient((model) => {
                if (model === 'slow-model')
                    return { delayMs: 2000 };
                return {};
            }, callCounts),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(chain, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
        assert.strictEqual(result.usedModel, 'fast-model');
        assert.strictEqual(result.findings.length, 1);
    });
    it('parallel mode with all failures falls back to remaining chain', async () => {
        const config = makeConfig({ parallelAttempts: 2, parallelThreshold: 0 });
        const chain = [
            { id: 'fail-a', provider: 'nim' },
            { id: 'fail-b', provider: 'nim' },
            { id: 'success-c', provider: 'nim' },
        ];
        const clients = {
            nim: makeMockClient((model) => {
                if (model === 'fail-a' || model === 'fail-b')
                    return { shouldThrow: true };
                return {};
            }),
            mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
        };
        const result = await runModelChainForBatch(chain, clients, TEST_BATCH, 'system', 'json_schema', config, 500);
        assert.strictEqual(result.usedModel, 'success-c');
        assert.strictEqual(result.findings.length, 1);
    });
});
describe('buildClients — custom models plural without singular', () => {
    it('creates custom client when custom_models is set without custom_model', () => {
        const config = makeConfig({
            customApiUrl: 'https://custom.example.com/v1',
            customApiKey: 'test-key',
            customModels: ['custom-model-1', 'custom-model-2'],
            customModel: '',
        });
        const clients = buildClients(config);
        assert.ok(clients.custom, 'custom client should be created');
    });
    it('creates custom client when both custom_model and custom_models are set', () => {
        const config = makeConfig({
            customApiUrl: 'https://custom.example.com/v1',
            customApiKey: 'test-key',
            customModels: ['custom-model-1'],
            customModel: 'primary-model',
        });
        const clients = buildClients(config);
        assert.ok(clients.custom);
    });
    it('does not create custom client when no custom URL is set', () => {
        const config = makeConfig({
            customApiUrl: '',
            customModels: ['custom-model-1'],
            customModel: '',
        });
        const clients = buildClients(config);
        assert.strictEqual(clients.custom, null);
    });
});
