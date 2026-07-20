import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewSchema } from './review-schema.js';
import { safeParseJson } from './utils.js';
const fixturesDir = join(import.meta.dirname, '__fixtures__');
function loadFixture(name) {
    const raw = readFileSync(join(fixturesDir, name), 'utf-8');
    return JSON.parse(raw);
}
describe('ReviewSchema', () => {
    it('parses valid complete response', () => {
        const fixture = loadFixture('fixture-valid-complete.json');
        const result = ReviewSchema.safeParse(JSON.parse(fixture.rawResponse));
        assert.strictEqual(result.success, true);
        if (result.success) {
            assert.strictEqual(result.data.findings.length, 3);
            assert.strictEqual(result.data.findings[0].severity, 'Critical');
            assert.strictEqual(result.data.summary, 'Found 3 issues across 2 files.');
        }
    });
    it('parses minimal valid response', () => {
        const fixture = loadFixture('fixture-valid-minimal.json');
        const result = ReviewSchema.safeParse(JSON.parse(fixture.rawResponse));
        assert.strictEqual(result.success, true);
        if (result.success) {
            assert.strictEqual(result.data.findings.length, 1);
            assert.strictEqual(result.data.findings[0].file, 'app.py');
        }
    });
    it('parses empty findings as valid', () => {
        const fixture = loadFixture('fixture-valid-empty.json');
        const result = ReviewSchema.safeParse(JSON.parse(fixture.rawResponse));
        assert.strictEqual(result.success, true);
        if (result.success) {
            assert.strictEqual(result.data.findings.length, 0);
        }
    });
    it('rejects non-JSON string', () => {
        const fixture = loadFixture('fixture-malformed-not-json.json');
        const parsed = safeParseJson(fixture.rawResponse);
        const result = ReviewSchema.safeParse(parsed);
        assert.strictEqual(result.success, false);
    });
    it('rejects wrong schema structure', () => {
        const fixture = loadFixture('fixture-malformed-wrong-schema.json');
        const parsed = safeParseJson(fixture.rawResponse);
        const result = ReviewSchema.safeParse(parsed);
        assert.strictEqual(result.success, false);
    });
    it('rejects invalid severity values', () => {
        const result = ReviewSchema.safeParse({
            findings: [{ file: 'x.ts', severity: 'Blocker', issue: 'bad' }],
        });
        assert.strictEqual(result.success, false);
    });
    it('rejects missing required fields', () => {
        const result = ReviewSchema.safeParse({});
        assert.strictEqual(result.success, false);
    });
    it('accepts null optional fields', () => {
        const result = ReviewSchema.safeParse({
            findings: [{
                    file: 'x.ts',
                    severity: 'Warning',
                    issue: 'test',
                    line_start: null,
                    line_end: null,
                    suggestion: null,
                }],
        });
        assert.strictEqual(result.success, true);
    });
    it('rejects truncated JSON via safeParseJson wrapper', () => {
        const fixture = loadFixture('fixture-truncated-json.json');
        const parsed = safeParseJson(fixture.rawResponse);
        // truncated JSON fails JSON.parse, so parsed is undefined
        const result = ReviewSchema.safeParse(parsed);
        assert.strictEqual(result.success, false);
    });
    it('handles empty string input', () => {
        const result = ReviewSchema.safeParse(safeParseJson(''));
        assert.strictEqual(result.success, false);
    });
    it('handles whitespace-only input', () => {
        const result = ReviewSchema.safeParse(safeParseJson('   '));
        assert.strictEqual(result.success, false);
    });
});
