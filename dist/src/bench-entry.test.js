import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { OpenAIClient } from './openai-client.js';
import { deterministicMatch, normalizeModelId, readmitCatalogModels, mapWithConcurrency, classifyFailedModels } from './bench-entry.js';
const LEADERBOARD = [
    { modelId: 'deepseek-ai/deepseek-v4-pro', score: 0.806, org: 'deepseek' },
    { modelId: 'meta/llama-3.3-70b-instruct', score: 0.62, org: 'meta' },
    { modelId: 'mistralai/mistral-large-3-675b-instruct-2512', score: 0.72, org: 'mistralai' },
    { modelId: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', score: 0.66, org: 'nvidia' },
    { modelId: 'nvidia/nemotron-3-super-120b-a12b', score: 0.68, org: 'nvidia' },
];
describe('mapWithConcurrency', () => {
    it('processes all items and preserves input order', async () => {
        const input = ['a', 'b', 'c', 'd', 'e'];
        const seen = [];
        const results = await mapWithConcurrency(input, 2, async (item) => {
            // Completion order is deliberately reversed from input order
            const delay = input.length - input.indexOf(item);
            await new Promise((r) => setTimeout(r, delay * 5));
            seen.push(item);
            return item.toUpperCase();
        });
        assert.deepStrictEqual(results, ['A', 'B', 'C', 'D', 'E']);
        assert.deepStrictEqual(new Set(seen), new Set(input));
        assert.strictEqual(seen.length, input.length);
    });
    it('bounds the number of concurrent in-flight calls', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight -= 1;
            return n;
        });
        assert.ok(maxInFlight <= 3, `max in-flight was ${maxInFlight}`);
        assert.ok(maxInFlight >= 2, `expected batching, max in-flight was ${maxInFlight}`);
    });
});
describe('deterministicMatch', () => {
    it('matches exact model id', () => {
        const r = deterministicMatch('deepseek-ai/deepseek-v4-pro', LEADERBOARD);
        assert.ok(r);
        assert.strictEqual(r.strategy, 'exact');
        assert.strictEqual(r.matchedId, 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(r.score, 0.806);
    });
    it('matches case-insensitively', () => {
        const r = deterministicMatch('DeepSeek-AI/DeepSeek-V4-Pro', LEADERBOARD);
        assert.ok(r);
        assert.strictEqual(r.strategy, 'case-insensitive');
        assert.strictEqual(r.matchedId, 'deepseek-ai/deepseek-v4-pro');
    });
    it('matches by normalized id (strip org + instruct suffix)', () => {
        const r = deterministicMatch('meta/llama-3.3-70b', LEADERBOARD);
        assert.ok(r);
        assert.strictEqual(r.strategy, 'normalized');
        assert.strictEqual(r.matchedId, 'meta/llama-3.3-70b-instruct');
        assert.strictEqual(r.score, 0.62);
    });
    it('does not match ambiguous short names', () => {
        const r = deterministicMatch('deepseek-v4', LEADERBOARD);
        assert.strictEqual(r, null);
    });
    it('returns null when no match is plausible', () => {
        const r = deterministicMatch('totally-unrelated/x', LEADERBOARD);
        assert.strictEqual(r, null);
    });
    it('returns null when substring match is ambiguous', () => {
        // "nemotron" appears in two leaderboard entries
        const r = deterministicMatch('nemotron', LEADERBOARD);
        assert.strictEqual(r, null);
    });
    it('strips trailing -it suffix', () => {
        const r = deterministicMatch('meta/llama-3.3-70b-it', LEADERBOARD);
        assert.ok(r);
        assert.strictEqual(r.matchedId, 'meta/llama-3.3-70b-instruct');
    });
});
describe('normalizeModelId — free-tier variants', () => {
    it('strips :free suffix', () => {
        assert.strictEqual(normalizeModelId('nvidia/nemotron-3-super-120b-a12b:free'), 'nemotron3super120ba12b');
    });
    it('strips -free suffix', () => {
        assert.strictEqual(normalizeModelId('some/model-free'), 'model');
    });
    it('strips org prefix and :free together', () => {
        assert.strictEqual(normalizeModelId('poolside/laguna-s-2.1:free'), 'lagunas21');
    });
    it('matches free-tier model to leaderboard entry', () => {
        const r = deterministicMatch('nvidia/nemotron-3-super-120b-a12b:free', LEADERBOARD);
        assert.ok(r);
        assert.strictEqual(r.strategy, 'normalized');
        assert.strictEqual(r.matchedId, 'nvidia/nemotron-3-super-120b-a12b');
        assert.strictEqual(r.score, 0.68);
    });
    it('does not match models not on leaderboard', () => {
        const r = deterministicMatch('inclusionai/ling-3.0-flash:free', LEADERBOARD);
        assert.strictEqual(r, null);
    });
});
describe('BENCH_SCORES_FILE IPC (producer/consumer)', () => {
    // Simulate the producer side of bench-entry.ts:
    //   writeFileSync(scoresFile, JSON.stringify(scores) + '\n')
    // And the consumer side of bench-reorder.ts:
    //   readFileSync(scoresFile, 'utf-8').trim() -> JSON.parse
    it('round-trips scores through a file', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'bench-scores-ipc-'));
        try {
            const scoresFile = join(tmpDir, 'scores.json');
            const scores = { 'new-vendor/new-model': 0.75, 'another/vendor': 0.8 };
            writeFileSync(scoresFile, JSON.stringify(scores) + '\n', 'utf-8');
            const raw = readFileSync(scoresFile, 'utf-8').trim();
            const parsed = JSON.parse(raw);
            assert.deepStrictEqual(parsed, scores);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('handles empty scores object', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'bench-scores-ipc-'));
        try {
            const scoresFile = join(tmpDir, 'scores.json');
            writeFileSync(scoresFile, JSON.stringify({}) + '\n', 'utf-8');
            const parsed = JSON.parse(readFileSync(scoresFile, 'utf-8').trim());
            assert.deepStrictEqual(parsed, {});
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
function startMockServer(handler) {
    const probedModels = [];
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'string' ? 0 : addr.port;
            resolve({ url: `http://localhost:${port}`, close: () => server.close(), probedModels });
        });
    });
}
function makeActionYml(tmpDir, models) {
    const path = join(tmpDir, 'action.yml');
    const csv = models.join(',');
    writeFileSync(path, `nim_models:\n  description: NIM models\n  default: '${csv}'\n`, 'utf-8');
    return path;
}
const BENCH_PROMPT = 'review this code';
describe('classifyFailedModels', () => {
    it('classifies probe-pass + catalog-listed as demoted with probe latency', async () => {
        const { demoted, transient, permanent } = await classifyFailedModels(['nvidia/llama-3.1-nemotron-ultra-253b-v1'], async () => true, new Set(['nvidia/llama-3.1-nemotron-ultra-253b-v1']));
        assert.strictEqual(demoted.length, 1);
        assert.strictEqual(demoted[0].model, 'nvidia/llama-3.1-nemotron-ultra-253b-v1');
        assert.strictEqual(typeof demoted[0].probeLatency, 'number');
        assert.deepStrictEqual(transient, []);
        assert.deepStrictEqual(permanent, []);
    });
    it('classifies probe-pass as demoted even when not in catalog', async () => {
        const { demoted, transient, permanent } = await classifyFailedModels(['custom/off-catalog'], async () => true, new Set(['nvidia/llama-3.1-nemotron-ultra-253b-v1']));
        assert.strictEqual(demoted.length, 1);
        assert.strictEqual(demoted[0].model, 'custom/off-catalog');
        assert.deepStrictEqual(transient, []);
        assert.deepStrictEqual(permanent, []);
    });
    it('classifies probe-fail + catalog-listed as transient', async () => {
        const { demoted, transient, permanent } = await classifyFailedModels(['nvidia/llama-3.1-nemotron-ultra-253b-v1'], async () => false, new Set(['nvidia/llama-3.1-nemotron-ultra-253b-v1']));
        assert.deepStrictEqual(demoted, []);
        assert.deepStrictEqual(transient, ['nvidia/llama-3.1-nemotron-ultra-253b-v1']);
        assert.deepStrictEqual(permanent, []);
    });
    it('classifies probe-fail + not-in-catalog as permanently unavailable', async () => {
        const { demoted, transient, permanent } = await classifyFailedModels(['custom/off-catalog'], async () => false, new Set(['nvidia/llama-3.1-nemotron-ultra-253b-v1']));
        assert.deepStrictEqual(demoted, []);
        assert.deepStrictEqual(transient, []);
        assert.deepStrictEqual(permanent, ['custom/off-catalog']);
    });
    it('classifies probe-fail as permanently unavailable when no catalog is available', async () => {
        const { demoted, transient, permanent } = await classifyFailedModels(['mistralai/mistral-large'], async () => false);
        assert.deepStrictEqual(demoted, []);
        assert.deepStrictEqual(transient, []);
        assert.deepStrictEqual(permanent, ['mistralai/mistral-large']);
    });
    it('handles mixed failures and preserves classification per model', async () => {
        const probeResults = new Map([
            ['healthy-model', true],
            ['transient-model', false],
            ['gone-model', false],
        ]);
        const { demoted, transient, permanent } = await classifyFailedModels(['healthy-model', 'transient-model', 'gone-model'], async (m) => probeResults.get(m) ?? false, new Set(['healthy-model', 'transient-model']));
        assert.deepStrictEqual(demoted, [{ model: 'healthy-model', probeLatency: demoted[0].probeLatency }]);
        assert.deepStrictEqual(transient, ['transient-model']);
        assert.deepStrictEqual(permanent, ['gone-model']);
    });
});
describe('readmitCatalogModels', () => {
    let testDir;
    let actionPath;
    let handle;
    beforeEach(async () => {
        testDir = mkdtempSync(join(tmpdir(), 'readmit-test-'));
    });
    afterEach(() => {
        if (handle)
            handle.close();
        rmSync(testDir, { recursive: true, force: true });
    });
    it('probes catalog models not in action.yml and re-admits passing ones', async () => {
        actionPath = makeActionYml(testDir, ['nvidia/llama-3.1-nemotron-ultra-253b-v1']);
        const availableModels = new Set([
            'deepseek-ai/deepseek-v4-pro',
            'nvidia/llama-3.1-nemotron-ultra-253b-v1',
        ]);
        handle = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                if (payload.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        choices: [{ message: { content: 'ok' } }],
                        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
                    }));
                }
            });
        });
        // Track probed models
        const originalProbes = [];
        const client = new OpenAIClient(handle.url, 'test-key');
        const probeSpy = client.probeModel.bind(client);
        const proxy = {
            probeModel: async (m) => { originalProbes.push(m); return probeSpy(m); },
            chat: client.chat.bind(client),
            chatStream: client.chatStream.bind(client),
        };
        const { results, reAdmitted } = await readmitCatalogModels({
            availableModels,
            actionPath,
            client: proxy,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 5,
        });
        assert.deepStrictEqual(reAdmitted, ['deepseek-ai/deepseek-v4-pro']);
        assert.ok(results.some(r => r.model === 'deepseek-ai/deepseek-v4-pro'));
        assert.ok(!reAdmitted.includes('nvidia/llama-3.1-nemotron-ultra-253b-v1'));
    });
    it('respects the limit parameter', async () => {
        actionPath = makeActionYml(testDir, []);
        const availableModels = new Set([
            'deepseek-ai/deepseek-v4-pro',
            'deepseek-ai/deepseek-v4-flash',
            'mistralai/mistral-large',
        ]);
        handle = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                if (payload.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        choices: [{ message: { content: 'ok' } }],
                        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
                    }));
                }
            });
        });
        const client = new OpenAIClient(handle.url, 'test-key');
        const probeCalls = [];
        const proxy = {
            probeModel: async (m) => { probeCalls.push(m); return client.probeModel(m); },
            chat: client.chat.bind(client),
            chatStream: client.chatStream.bind(client),
        };
        await readmitCatalogModels({
            availableModels,
            actionPath,
            client: proxy,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 2,
        });
        assert.strictEqual(probeCalls.length, 2);
        assert.strictEqual(probeCalls[0], 'deepseek-ai/deepseek-v4-pro');
        assert.strictEqual(probeCalls[1], 'deepseek-ai/deepseek-v4-flash');
    });
    it('skips models already in action.yml', async () => {
        const inAction = 'deepseek-ai/deepseek-v4-pro';
        actionPath = makeActionYml(testDir, [inAction, 'mistralai/mistral-large']);
        const availableModels = new Set([
            inAction,
            'deepseek-ai/deepseek-v4-flash',
            'mistralai/mistral-large',
        ]);
        handle = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                if (payload.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        choices: [{ message: { content: 'ok' } }],
                        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
                    }));
                }
            });
        });
        const client = new OpenAIClient(handle.url, 'test-key');
        const probeCalls = [];
        const proxy = {
            probeModel: async (m) => { probeCalls.push(m); return client.probeModel(m); },
            chat: client.chat.bind(client),
            chatStream: client.chatStream.bind(client),
        };
        const { reAdmitted } = await readmitCatalogModels({
            availableModels,
            actionPath,
            client: proxy,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 10,
        });
        assert.ok(!probeCalls.includes(inAction));
        assert.ok(!probeCalls.includes('mistralai/mistral-large'));
        assert.deepStrictEqual(reAdmitted, ['deepseek-ai/deepseek-v4-flash']);
    });
    it('does not re-admit models that fail the probe', async () => {
        actionPath = makeActionYml(testDir, []);
        const availableModels = new Set([
            'deepseek-ai/deepseek-v4-pro',
            'deepseek-ai/deepseek-v4-flash',
        ]);
        handle = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                // Fail all chat completions → probeModel returns false
                res.writeHead(500);
                res.end('Internal Server Error');
            });
        });
        const client = new OpenAIClient(handle.url, 'test-key');
        const { results, reAdmitted } = await readmitCatalogModels({
            availableModels,
            actionPath,
            client,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 10,
        });
        assert.deepStrictEqual(reAdmitted, []);
        assert.deepStrictEqual(results, []);
    });
    it('re-admits models sorted by SWE-bench score descending', async () => {
        actionPath = makeActionYml(testDir, []);
        const availableModels = new Set([
            'mistralai/mistral-large', // score 0.700
            'nvidia/nemotron-3-super-120b-a12b', // score 0.680
        ]);
        const probeOrder = [];
        handle = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                if (payload.messages[0].content === 'Say hi') {
                    probeOrder.push(payload.model);
                }
                if (payload.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                }
                else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        choices: [{ message: { content: 'ok' } }],
                        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
                    }));
                }
            });
        });
        const client = new OpenAIClient(handle.url, 'test-key');
        await readmitCatalogModels({
            availableModels,
            actionPath,
            client,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 10,
        });
        assert.strictEqual(probeOrder[0], 'mistralai/mistral-large');
        assert.strictEqual(probeOrder[1], 'nvidia/nemotron-3-super-120b-a12b');
    });
    it('respects the concurrency option by bounding in-flight calls', async () => {
        actionPath = makeActionYml(testDir, []);
        const availableModels = new Set([
            'deepseek-ai/deepseek-v4-pro',
            'nvidia/nemotron-3-super-120b-a12b',
            'mistralai/mistral-large',
            'deepseek-ai/deepseek-v4-flash',
        ]);
        let inFlight = 0;
        let maxInFlight = 0;
        const track = async (fn) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                return await fn();
            }
            finally {
                inFlight -= 1;
            }
        };
        const client = {
            probeModel: () => track(async () => {
                await new Promise((r) => setTimeout(r, 10));
                return true;
            }),
            chat: () => track(async () => {
                await new Promise((r) => setTimeout(r, 10));
                return {
                    content: 'ok',
                    latency: 10,
                    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
                };
            }),
            chatStream: async function* () {
                yield { delta: 'x' };
            },
        };
        const { results, reAdmitted } = await readmitCatalogModels({
            availableModels,
            actionPath,
            client: client,
            benchPrompt: BENCH_PROMPT,
            iterations: 1,
            limit: 10,
            concurrency: 2,
        });
        assert.deepStrictEqual(reAdmitted, [
            'deepseek-ai/deepseek-v4-pro',
            'deepseek-ai/deepseek-v4-flash',
            'mistralai/mistral-large',
            'nvidia/nemotron-3-super-120b-a12b',
        ]);
        assert.strictEqual(results.length, 4);
        assert.ok(maxInFlight <= 2, `max in-flight was ${maxInFlight}`);
        assert.ok(maxInFlight >= 2, `expected batching, max in-flight was ${maxInFlight}`);
    });
});
