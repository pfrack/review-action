import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { OpenAIClient } from './openai-client.js';
import { runBenchmark, median, countErrors, formatDuration, formatMarkdownTable } from './bench.js';
function startMockServer(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'string' ? 0 : addr.port;
            resolve({ url: `http://localhost:${port}`, close: () => server.close() });
        });
    });
}
describe('runBenchmark', () => {
    it('runs iterations and collects metrics', async () => {
        let callCount = 0;
        const mock = await startMockServer((req, res) => {
            callCount++;
            let body = '';
            req.on('data', (chunk) => body += chunk);
            req.on('end', () => {
                const payload = JSON.parse(body);
                // Streaming request
                if (payload.stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    const chunk = JSON.stringify({ choices: [{ delta: { content: 'test' } }] });
                    res.write(`data: ${chunk}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                // Non-streaming request
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { content: 'test response' } }],
                    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
                }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            const result = await runBenchmark(client, 'test-model', {
                prompt: 'review this code',
                iterations: 3,
                temperature: 0.2,
                maxTokens: 1024,
            });
            assert.strictEqual(result.model, 'test-model');
            assert.strictEqual(result.iterations.length, 3);
            // 1 warmup + 3 non-streaming + 3 streaming = 7 calls
            assert.strictEqual(callCount, 7);
            for (let i = 0; i < result.iterations.length; i++) {
                const it = result.iterations[i];
                assert.strictEqual(it.error, null, `iteration ${i}: unexpected error`);
                assert.ok(it.latency > 0, `iteration ${i}: latency should be positive`);
                assert.strictEqual(it.completionTokens, 20, `iteration ${i}: completion tokens`);
                assert.ok(it.tokensPerSec > 0, `iteration ${i}: tokens/sec should be positive`);
            }
        }
        finally {
            mock.close();
        }
    });
    it('handles errors gracefully', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(500);
            res.end('error');
        });
        try {
            const client = new OpenAIClient(mock.url, 'test-key');
            const result = await runBenchmark(client, 'test-model', {
                prompt: 'test',
                iterations: 2,
                temperature: 0.2,
                maxTokens: 1024,
            });
            for (const it of result.iterations) {
                assert.ok(it.error !== null, 'expected error');
            }
        }
        finally {
            mock.close();
        }
    });
});
describe('median', () => {
    const tests = [
        [[100, 200, 300], 200],
        [[300, 100, 200], 200],
        [[100], 100],
        [[], 0],
    ];
    for (const [input, want] of tests) {
        it(`median([${input}]) = ${want}`, () => {
            assert.strictEqual(median(input), want);
        });
    }
});
describe('countErrors', () => {
    it('counts errors correctly', () => {
        const iters = [
            { error: null },
            { error: new Error('fail') },
            { error: null },
            { error: new Error('fail2') },
        ];
        assert.strictEqual(countErrors(iters), 2);
    });
});
describe('formatDuration', () => {
    it('formats 0 as N/A', () => {
        assert.strictEqual(formatDuration(0), 'N/A');
    });
    it('formats microseconds', () => {
        assert.strictEqual(formatDuration(0.5), '500μs');
    });
    it('formats milliseconds', () => {
        assert.strictEqual(formatDuration(150), '150ms');
    });
    it('formats seconds', () => {
        assert.strictEqual(formatDuration(2500), '2.50s');
    });
});
describe('formatMarkdownTable', () => {
    it('formats results as markdown table', () => {
        const results = [{
                model: 'test-model',
                iterations: [
                    { ttft: 50, latency: 1000, completionTokens: 100, tokensPerSec: 100, error: null },
                    { ttft: 60, latency: 1200, completionTokens: 120, tokensPerSec: 100, error: null },
                ],
            }];
        const table = formatMarkdownTable(results);
        assert.ok(table.includes('test-model'));
        assert.ok(table.includes('Tokens/sec'));
        assert.ok(table.includes('|'));
    });
});
