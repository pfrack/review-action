import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OpenAIClient, extractJsonFromText, stripThinkingContent, effectiveFormat, sanitizeErrorBody } from './openai-client.js';
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
    it('Chat sends json_schema response_format when format=json_schema', async () => {
        let capturedPayload = null;
        const mock = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                capturedPayload = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            await client.chat('test-model', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(capturedPayload.response_format?.type, 'json_schema');
            assert.strictEqual(capturedPayload.response_format?.json_schema?.name, 'review');
        }
        finally {
            mock.close();
        }
    });
    it('Chat sends json_object response_format when format=json_object', async () => {
        let capturedPayload = null;
        const mock = await startMockServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                capturedPayload = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            await client.chat('test-model', [{ role: 'user', content: 'hi' }], {
                format: 'json_object',
            });
            assert.deepStrictEqual(capturedPayload.response_format, { type: 'json_object' });
        }
        finally {
            mock.close();
        }
    });
    it('Chat retries with json_object when model rejects json_schema', async () => {
        // Use a model id that is NOT in the NO_JSON_SCHEMA_MODELS override
        // table — the table makes the override path start with json_object
        // directly, so a model id from the table would skip the retry.
        const modelId = 'unknown-model-that-rejects-schema';
        const calls = [];
        const mock = await startMockServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => raw += chunk);
            req.on('end', () => {
                const payload = JSON.parse(raw);
                calls.push({ body: raw, payload });
                if (payload.response_format?.type === 'json_schema') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: `Model ${modelId} does not support response format \`json_schema\`. See supported models at https://console.groq.com/docs/structured-outputs#supported-models`,
                            type: 'invalid_request_error',
                            param: 'response_format',
                        },
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'Groq');
            const result = await client.chat(modelId, [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(result.content, '{"summary":"ok","findings":[]}');
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[0].payload.response_format?.type, 'json_schema');
            assert.strictEqual(calls[1].payload.response_format?.type, 'json_object');
            assert.strictEqual(calls[1].payload.response_format?.json_schema, undefined);
        }
        finally {
            mock.close();
        }
    });
    it('Chat retries with json_object when error body says "structured_outputs is not supported" (StepFun-style)', async () => {
        // Some providers (e.g. StepFun) use the generic feature name
        // "structured_outputs" instead of the API param "json_schema" in
        // their error body. The detector must match both.
        // NOTE: use a model id NOT in NO_STRUCTURED_OUTPUT_MODELS so the
        // text-mode override doesn't kick in and the retry path is exercised.
        const modelId = 'unknown-model-structured-outputs-error';
        const calls = [];
        const mock = await startMockServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => raw += chunk);
            req.on('end', () => {
                const payload = JSON.parse(raw);
                calls.push({ payload });
                if (payload.response_format?.type === 'json_schema') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: 'structured_outputs is not supported.',
                            type: 'BadRequestError',
                            param: null,
                            code: 400,
                        },
                    }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'Custom');
            const result = await client.chat(modelId, [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(result.content, '{"summary":"ok","findings":[]}');
            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[0].payload.response_format?.type, 'json_schema');
            assert.strictEqual(calls[1].payload.response_format?.type, 'json_object');
        }
        finally {
            mock.close();
        }
    });
    it('Chat pre-selects json_object for models in NO_JSON_SCHEMA_MODELS (no json_schema round-trip)', async () => {
        const calls = [];
        const mock = await startMockServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => raw += chunk);
            req.on('end', () => {
                const payload = JSON.parse(raw);
                calls.push({ payload });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"summary":"ok","findings":[]}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'Groq');
            const result = await client.chat('llama-3.3-70b-versatile', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(result.content, '{"summary":"ok","findings":[]}');
            // Exactly one call — override skips the json_schema round-trip
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].payload.response_format?.type, 'json_object');
        }
        finally {
            mock.close();
        }
    });
    it('Chat falls through to text mode for NO_STRUCTURED_OUTPUT_MODELS and parses JSON out of the response', async () => {
        // StepFun rejects both json_schema and json_object. The action
        // should drop to plain text and parse the JSON object the model
        // emits in a ```json ... ``` fence (or bare, see next test).
        const calls = [];
        const mock = await startMockServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => raw += chunk);
            req.on('end', () => {
                const payload = JSON.parse(raw);
                calls.push({ payload });
                // No response_format on the wire (text mode)
                assert.strictEqual(payload.response_format, undefined, 'text mode must not send response_format');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '```json\n{"summary":"step-fun parsed","findings":[]}\n```' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'StepFun');
            const result = await client.chat('step-3.5-flash', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].payload.response_format, undefined);
            // Extracted JSON, not the raw fenced text
            assert.strictEqual(result.content, '{"summary":"step-fun parsed","findings":[]}');
        }
        finally {
            mock.close();
        }
    });
    it('extractJsonFromText: handles ```json fence, plain fence, bare object, and prose', () => {
        assert.strictEqual(extractJsonFromText('```json\n{"a":1}\n```'), '{"a":1}');
        assert.strictEqual(extractJsonFromText('```\n{"a":2}\n```'), '{"a":2}');
        assert.strictEqual(extractJsonFromText('Here is the result: {"a":3, "b":[1,2]} and some trailing prose.'), '{"a":3, "b":[1,2]}');
        // Nested objects — brace counter must not be fooled by inner braces
        assert.strictEqual(extractJsonFromText('noise {"a":{"b":2},"c":3} tail'), '{"a":{"b":2},"c":3}');
        // Strings containing braces must not affect the counter
        assert.strictEqual(extractJsonFromText('{"a":"has } brace","b":2}'), '{"a":"has } brace","b":2}');
        // Escaped quotes inside strings
        assert.strictEqual(extractJsonFromText('{"a":"escaped \\" quote","b":2}'), '{"a":"escaped \\" quote","b":2}');
        // No JSON found
        assert.strictEqual(extractJsonFromText('no json here'), null);
        assert.strictEqual(extractJsonFromText(''), null);
        // Unbalanced braces
        assert.strictEqual(extractJsonFromText('{"a":1'), null);
    });
    it('extractJsonFromText: strips thinking blocks before JSON extraction', () => {
        // <thinking> with a brace inside must not corrupt the JSON walk
        assert.strictEqual(extractJsonFromText('<thinking>why { not } this</thinking>{"a":1}'), '{"a":1}');
        // thinking with a bare JSON object after it
        assert.strictEqual(extractJsonFromText('[thinking]some reasoning[/thinking]\n{"summary":"ok","findings":[]}'), '{"summary":"ok","findings":[]}');
        // === thinking === ... === answer === ... JSON
        assert.strictEqual(extractJsonFromText('=== thinking ===\nreasoning\n=== answer ===\n{"a":1}'), '{"a":1}');
    });
    it('stripThinkingContent removes all supported dialects', () => {
        assert.strictEqual(stripThinkingContent('<thinking>reason</thinking>'), '');
        assert.strictEqual(stripThinkingContent('[thinking]reason[/thinking]'), '');
        assert.strictEqual(stripThinkingContent('=== thinking ===\nreason\n=== answer ===\n{"a":1}'), '{"a":1}');
        // Multiple blocks
        assert.strictEqual(stripThinkingContent('<thinking>a</thinking>content<thinking>b</thinking>'), 'content');
        // No thinking — passthrough
        assert.strictEqual(stripThinkingContent('plain text'), 'plain text');
        assert.strictEqual(stripThinkingContent(''), '');
    });
    it('Chat falls back to text mode without json_schema round-trip (no NO_JSON_SCHEMA_MODELS hit first)', async () => {
        // A model in NO_STRUCTURED_OUTPUT_MODELS but NOT in NO_JSON_SCHEMA_MODELS
        // should still go straight to text mode in one call.
        const calls = [];
        const mock = await startMockServer((req, res) => {
            let raw = '';
            req.on('data', (chunk) => raw += chunk);
            req.on('end', () => {
                const payload = JSON.parse(raw);
                calls.push({ payload });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: '{"a":1}' } }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key', 'Custom');
            await client.chat('step-3.5-flash-2603', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            });
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].payload.response_format, undefined);
        }
        finally {
            mock.close();
        }
    });
    it('Chat does not retry with json_object when 400 error is unrelated to json_schema', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Invalid model' } }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            await assert.rejects(() => client.chat('model', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'json_schema',
            }), (err) => {
                assert.ok(err.message.includes('400'));
                return true;
            });
        }
        finally {
            mock.close();
        }
    });
    it('Chat does not retry with json_object when format is not json_schema', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'tools not supported' } }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            await assert.rejects(() => client.chat('model', [{ role: 'user', content: 'hi' }], {
                schema: { type: 'object' },
                format: 'tools',
            }), (err) => {
                assert.ok(err.message.includes('400'));
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
    it('chat() defaults missing usage to zeros', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await client.chat('model', [{ role: 'user', content: 'hi' }]);
            assert.strictEqual(result.content, 'ok');
            assert.deepStrictEqual(result.usage, { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 });
            assert.strictEqual(result.finishReason, 'stop');
        }
        finally {
            mock.close();
        }
    });
    it('chat() defaults missing finish_reason to null (no false truncation)', async () => {
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
            assert.strictEqual(result.finishReason, null);
        }
        finally {
            mock.close();
        }
    });
});
describe('OpenAIClient listModels', () => {
    it('returns the model id list from /models', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const models = await client.listModels();
            assert.deepStrictEqual(models, ['a', 'b']);
        }
        finally {
            mock.close();
        }
    });
    it('throws when /models is not ok', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'boom' }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            await assert.rejects(() => client.listModels(), (err) => err.message.includes('/models returned 500'));
        }
        finally {
            mock.close();
        }
    });
});
describe('sanitizeErrorBody', () => {
    it('redacts Bearer tokens', () => {
        assert.strictEqual(sanitizeErrorBody('Bearer secret123'), 'Bearer [REDACTED]');
    });
    it('redacts api key values', () => {
        const out = sanitizeErrorBody('api_key: "abc"');
        assert.ok(!out.includes('abc'), 'api key value must be removed');
    });
});
describe('effectiveFormat', () => {
    it('downgrades json_schema to json_object for known groq llama model', () => {
        assert.strictEqual(effectiveFormat('llama-3.3-70b-versatile', 'groq', 'json_schema'), 'json_object');
    });
    it('falls through to text for no-structured-output models', () => {
        assert.strictEqual(effectiveFormat('step-3.5-flash', 'openrouter', 'json_schema'), 'text');
    });
    it('passes json_schema through for unsupported-unknown models', () => {
        assert.strictEqual(effectiveFormat('gpt-4', 'openai', 'json_schema'), 'json_schema');
    });
    it('returns text unchanged when text is requested', () => {
        assert.strictEqual(effectiveFormat('x', 'y', 'text'), 'text');
    });
});
