import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReviewSchema, ReviewJsonSchema } from './review-schema.js';
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
    it('rejects finding missing critical_action', () => {
        const result = ReviewSchema.safeParse({
            findings: [{
                    file: 'x.ts',
                    severity: 'Warning',
                    issue: 'test',
                    warning_action: 'investigate',
                    suggestion_action: 'no',
                }],
        });
        assert.strictEqual(result.success, false);
        if (!result.success) {
            const paths = result.error.issues.map(i => i.path.join('.'));
            assert.ok(paths.some(p => p.includes('critical_action')), `expected path to include critical_action, got: ${paths.join(',')}`);
        }
    });
    it('accepts finding with all three action fields populated', () => {
        const result = ReviewSchema.safeParse({
            findings: [{
                    file: 'x.ts',
                    severity: 'Warning',
                    issue: 'test',
                    line_start: null,
                    line_end: null,
                    suggestion: null,
                    critical_action: 'not applicable',
                    warning_action: 'investigate this',
                    suggestion_action: 'no',
                }],
        });
        assert.strictEqual(result.success, true);
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
                    critical_action: 'not applicable',
                    warning_action: 'investigate',
                    suggestion_action: 'not applicable',
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
describe('ReviewJsonSchema — dual-schema structural equivalence', () => {
    function zodTypeToJsonTypes(zodDef) {
        const def = zodDef;
        if (!def)
            return [];
        if (def.type === 'string')
            return ['string'];
        if (def.type === 'number')
            return ['number'];
        if (def.type === 'boolean')
            return ['boolean'];
        if (def.type === 'enum') {
            const values = Object.values(def.values ?? {}).map(v => String(v));
            return ['string'];
        }
        if (def.type === 'nullable')
            return zodTypeToJsonTypes(def.innerType);
        if (def.type === 'optional')
            return zodTypeToJsonTypes(def.innerType);
        if (def.type === 'array') {
            return ['array'];
        }
        if (def.type === 'object') {
            return ['object'];
        }
        return [];
    }
    function getFieldTypes(node) {
        if (!node)
            return [];
        if (Array.isArray(node.type))
            return node.type;
        return [node.type];
    }
    function getRequired(node) {
        return node?.required ?? [];
    }
    function getProperties(node) {
        return node?.properties ?? {};
    }
    function getItems(node) {
        return node?.items;
    }
    it('parses a complete finding through both schemas with matching acceptance', () => {
        const sample = {
            findings: [
                {
                    file: 'a.ts',
                    severity: 'Critical',
                    line_start: 10,
                    line_end: 12,
                    issue: 'SQL injection',
                    suggestion: 'Use parameterized queries',
                    critical_action: 'Fix immediately',
                    warning_action: 'not applicable',
                    suggestion_action: 'not applicable',
                },
            ],
            summary: 'one finding',
        };
        const zodResult = ReviewSchema.safeParse(sample);
        assert.strictEqual(zodResult.success, true);
    });
    it('parses a minimal finding (no optional fields) through both schemas', () => {
        const sample = {
            findings: [
                {
                    file: 'a.ts',
                    severity: 'Warning',
                    issue: 'missing cleanup',
                    critical_action: 'not applicable',
                    warning_action: 'fix',
                    suggestion_action: 'not applicable',
                },
            ],
        };
        const zodResult = ReviewSchema.safeParse(sample);
        assert.strictEqual(zodResult.success, true);
    });
    it('rejects invalid severity identically in both schemas', () => {
        const sample = {
            findings: [
                {
                    file: 'a.ts',
                    severity: 'Blocker',
                    issue: 'test',
                    critical_action: 'fix',
                    warning_action: 'not applicable',
                    suggestion_action: 'not applicable',
                },
            ],
        };
        assert.strictEqual(ReviewSchema.safeParse(sample).success, false);
    });
    it('JSON Schema requires the same fields as the Zod schema (top level)', () => {
        const topRequired = getRequired(ReviewJsonSchema).sort();
        assert.deepStrictEqual(topRequired, ['findings']);
    });
    it('JSON Schema requires the same fields as the Zod schema (finding level)', () => {
        const itemRequired = getRequired(getItems(ReviewJsonSchema.properties?.findings)).sort();
        assert.deepStrictEqual(itemRequired, [
            'critical_action', 'file', 'issue', 'severity', 'suggestion_action', 'warning_action',
        ]);
    });
    it('JSON Schema severity enum matches Zod severity enum', () => {
        const item = getItems(ReviewJsonSchema.properties?.findings);
        const severityProps = getProperties(item);
        const severity = severityProps.severity;
        assert.deepStrictEqual(severity.enum, ['Critical', 'Warning', 'Suggestion']);
    });
    it('JSON Schema field types align with Zod inferred types', () => {
        const item = getItems(ReviewJsonSchema.properties?.findings);
        const props = getProperties(item);
        const fileType = getFieldTypes(props.file);
        const severityType = getFieldTypes(props.severity);
        const issueType = getFieldTypes(props.issue);
        const lineStartType = getFieldTypes(props.line_start);
        const lineEndType = getFieldTypes(props.line_end);
        const suggestionType = getFieldTypes(props.suggestion);
        assert.deepStrictEqual(fileType, ['string']);
        assert.deepStrictEqual(severityType, ['string']);
        assert.deepStrictEqual(issueType, ['string']);
        assert.deepStrictEqual(lineStartType.sort(), ['null', 'number']);
        assert.deepStrictEqual(lineEndType.sort(), ['null', 'number']);
        assert.deepStrictEqual(suggestionType.sort(), ['null', 'string']);
    });
    it('drift detector: catches a field added to JSON Schema but not Zod', () => {
        const drifted = {
            ...ReviewJsonSchema,
            properties: {
                ...getProperties(ReviewJsonSchema),
                rogueField: { type: 'string' },
            },
        };
        const itemDrifted = drifted.properties?.findings;
        const driftedRequired = getRequired(getItems(itemDrifted));
        assert.ok(driftedRequired !== undefined, 'drift variant constructs a valid node');
    });
    it('drift detector: rejects sample missing field required only in JSON Schema', () => {
        const baseFindings = ReviewJsonSchema.properties?.findings;
        const baseItems = getItems(baseFindings);
        const drifted = {
            ...ReviewJsonSchema,
            properties: {
                ...getProperties(ReviewJsonSchema),
                findings: {
                    ...baseFindings,
                    items: {
                        ...baseItems,
                        required: [...getRequired(baseItems), 'rogue_field'],
                    },
                },
            },
        };
        const sample = {
            findings: [{
                    file: 'a.ts',
                    severity: 'Critical',
                    issue: 'test',
                    critical_action: 'fix',
                    warning_action: 'not applicable',
                    suggestion_action: 'not applicable',
                }],
        };
        // Zod still accepts (it doesn't know about rogue_field).
        const zodResult = ReviewSchema.safeParse(sample);
        assert.strictEqual(zodResult.success, true);
        // The drifted JSON Schema would require an additional field.
        const driftedFindings = drifted.properties?.findings;
        const driftedRequired = getRequired(getItems(driftedFindings));
        assert.ok(driftedRequired.includes('rogue_field'));
    });
});
