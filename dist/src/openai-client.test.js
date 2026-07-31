import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OpenAIClient } from './openai-client.js';
import { RetryableError } from './retry.js';
import { startMockServer } from './test-utils.js';
describe('OpenAIClient provider label detection', () => {
    it('auto-detects OpenRouter label from base URL', () => {
        const client = new OpenAIClient('https://openrouter.ai/api/v1', 'key');
        assert.strictEqual(client.providerLabel, 'OpenRouter');
    });
    it('auto-detects Kilo label from base URL', () => {
        const client = new OpenAIClient('https://api.kilo.ai/api/gateway', 'key');
        assert.strictEqual(client.providerLabel, 'Kilo');
    });
    it('uses explicit label when provided', () => {
        const client = new OpenAIClient('https://openrouter.ai/api/v1', 'key', 'MyLabel');
        assert.strictEqual(client.providerLabel, 'MyLabel');
    });
});
describe('OpenAIClient', () => {
    it('Chat sends correct request and returns response', async () => {
        const mock = await startMockServer((req, res) => {
            assert.strictEqual(req.url, '/chat/completions');
            assert.strictEqual(req.method, 'POST');
            assert.ok(req.headers.authorization?.startsWith('Bearer '));
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                assert.strictEqual(payload.model, 'test-model');
                assert.ok(Array.isArray(payload.messages));
                assert.strictEqual(payload.stream, false);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: 'test response' } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            const result = await client.chat('test-model', [{ role: 'user', content: 'hello' }]);
            assert.strictEqual(result.content, 'test response');
            assert.strictEqual(result.usage.total_tokens, 15);
            assert.ok(result.latency > 0);
        }
        finally {
            mock.close();
        }
    });
    it('Chat throws on HTTP error', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(500);
            res.end('internal error');
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            await assert.rejects(() => client.chat('model', [{ role: 'user', content: 'hi' }]), (err) => {
                assert.ok(err.message.includes('500'));
                return true;
            });
        }
        finally {
            mock.close();
        }
    });
    it('ChatStream parses SSE chunks correctly', async () => {
        const mock = await startMockServer((req, res) => {
            assert.ok(req.headers.accept?.includes('text/event-stream'));
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const chunks = ['Hello', ' world', '!'];
            for (const chunk of chunks) {
                const data = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
                res.write(`data: ${data}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            const chunks = [];
            let firstTokenAtSet = false;
            for await (const chunk of client.chatStream('model', [{ role: 'user', content: 'hi' }])) {
                if (chunk.done)
                    break;
                if (chunk.delta && !firstTokenAtSet) {
                    assert.ok(chunk.firstTokenAt !== null);
                    firstTokenAtSet = true;
                }
                chunks.push(chunk.delta);
            }
            assert.strictEqual(chunks.join(''), 'Hello world!');
        }
        finally {
            mock.close();
        }
    });
    it('ChatStream throws on HTTP error', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(401);
            res.end('unauthorized');
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            await assert.rejects(() => (async () => {
                for await (const _chunk of client.chatStream('model', [{ role: 'user', content: 'hi' }])) { }
            })(), (err) => {
                assert.ok(err.message.includes('401'));
                return true;
            });
        }
        finally {
            mock.close();
        }
    });
    it('Constructor trims trailing slash from baseURL', () => {
        const client = new OpenAIClient('https://example.com/v1/', 'key');
        assert.strictEqual(client.baseURL, 'https://example.com/v1');
    });
    it('probeModel returns true on success', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: 'hi' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            assert.strictEqual(await client.probeModel('model'), true);
        }
        finally {
            mock.close();
        }
    });
    it('probeModel returns false on error', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(500);
            res.end('error');
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            assert.strictEqual(await client.probeModel('model'), false);
        }
        finally {
            mock.close();
        }
    });
});
describe('OpenAIClient response validation', () => {
    it('throws a sanitized RetryableError for non-JSON success responses', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('provider secret response fragment');
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'TestProvider');
            await assert.rejects(() => client.chat('model', [{ role: 'user', content: 'hi' }]), (err) => {
                assert.ok(err instanceof RetryableError);
                assert.strictEqual(err.status, 502);
                assert.strictEqual(err.message, 'TestProvider returned non-JSON response');
                assert.ok(!err.message.includes('provider secret'));
                return true;
            });
        }
        finally {
            mock.close();
        }
    });
});
describe('OpenAIClient signal/timeout', () => {
    it('chat() aborts when signal fires before response', async () => {
        const mock = await startMockServer((_req, res) => {
            // Delay 2 seconds before responding
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: 'late response' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            }, 2000);
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            await assert.rejects(() => client.chat('model', [{ role: 'user', content: 'hi' }], {
                signal: AbortSignal.timeout(100),
            }), (err) => {
                assert.ok(err.name === 'TimeoutError' || err.name === 'AbortError' || err.message.includes('abort'), `Expected abort/timeout error, got: ${err.name}: ${err.message}`);
                return true;
            });
        }
        finally {
            mock.close();
        }
    });
    it('chat() works normally without signal', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await client.chat('model', [{ role: 'user', content: 'hi' }]);
            assert.strictEqual(result.content, 'ok');
        }
        finally {
            mock.close();
        }
    });
    it('chat() succeeds when signal has not expired', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: 'fast' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await client.chat('model', [{ role: 'user', content: 'hi' }], {
                signal: AbortSignal.timeout(5000),
            });
            assert.strictEqual(result.content, 'fast');
        }
        finally {
            mock.close();
        }
    });
});
