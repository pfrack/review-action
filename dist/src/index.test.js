import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { OpenAIClient } from './openai-client.js';
import { ReviewJsonSchema } from './review-schema.js';
import { severityTally, validateFindings } from './review.js';
import { buildSystemMessage, BASE_SYSTEM_PROMPT } from './prompts.js';
function startMockServer(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.unref();
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'string' ? 0 : addr.port;
            resolve({ url: `http://localhost:${port}`, close: () => server.close() });
        });
    });
}
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
        assert.strictEqual(msg, 'override text');
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
