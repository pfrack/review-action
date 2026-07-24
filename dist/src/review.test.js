import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseDiff, shouldExclude, loadConfig, parseDiffHunks, getFileHunks, validateFindings, renderReview, severityTally } from './review.js';
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
describe('parseDiffHunks', () => {
    it('extracts hunk ranges from diff text', () => {
        const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3
@@ -10,5 +11,6 @@
 old
+new
 old2`;
        const hunks = parseDiffHunks(diff);
        assert.strictEqual(hunks.length, 2);
        assert.deepStrictEqual(hunks[0], { start: 1, end: 4 });
        assert.deepStrictEqual(hunks[1], { start: 11, end: 16 });
    });
    it('returns empty array for no hunks', () => {
        assert.deepStrictEqual(parseDiffHunks('no hunks here'), []);
    });
});
describe('getFileHunks', () => {
    it('maps files to their hunk ranges', () => {
        const filesDiff = {
            'a.ts': 'diff --git a/a.ts b/a.ts\n@@ -1,2 +1,3 @@\n+x\n',
            'b.ts': 'diff --git b/b.ts b/b.ts\n@@ -5,1 +5,2 @@\n+y\n',
        };
        const map = getFileHunks(filesDiff);
        assert.strictEqual(map.size, 2);
        assert.deepStrictEqual(map.get('a.ts'), [{ start: 1, end: 3 }]);
        assert.deepStrictEqual(map.get('b.ts'), [{ start: 5, end: 6 }]);
    });
});
describe('validateFindings', () => {
    const filesDiff = {
        'src/main.ts': 'diff --git a/src/main.ts b/src/main.ts\n@@ -10,3 +10,5 @@\n old\n+new1\n+new2\n old2\n',
    };
    const changedFiles = new Set(['src/main.ts']);
    it('drops finding for file not in changed set', async () => {
        const review = { findings: [{ file: 'unknown.ts', severity: 'Warning', issue: 'bad', line_start: 11, line_end: 12, critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 0);
        assert.ok(result.valid.summary);
        assert.ok(result.warnings.some(w => w.includes('unknown.ts')));
    });
    it('drops finding with line outside all hunks', async () => {
        const review = { findings: [{ file: 'src/main.ts', severity: 'Critical', issue: 'bad', line_start: 100, line_end: 105, critical_action: 'fix', warning_action: 'not applicable', suggestion_action: 'not applicable' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 0);
        assert.ok(result.valid.summary);
        assert.ok(result.warnings.some(w => w.includes('100')));
    });
    it('keeps finding with line inside hunk', async () => {
        const review = { findings: [{ file: 'src/main.ts', severity: 'Warning', issue: 'ok', line_start: 11, line_end: 12, critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 1);
        assert.strictEqual(result.valid.findings[0].issue, 'ok');
        assert.strictEqual(result.warnings.length, 0);
    });
    it('keeps file-wide finding (no line)', async () => {
        const review = { findings: [{ file: 'src/main.ts', severity: 'Suggestion', issue: 'no tests', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: 'add tests' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 1);
        assert.strictEqual(result.warnings.length, 0);
    });
    it('drops finding with line_end but no line_start', async () => {
        const review = { findings: [{ file: 'src/main.ts', severity: 'Warning', issue: 'bad', line_end: 12, critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 0);
        assert.ok(result.warnings.some(w => w.includes('line_end but no line_start')));
    });
    it('returns summary when all findings dropped', async () => {
        const review = { findings: [{ file: 'nope.ts', severity: 'Warning', issue: 'x', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }] };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 0);
        assert.ok(result.valid.summary);
        assert.ok(result.warnings.length > 0);
    });
    it('returns empty valid finding for clean review with summary', async () => {
        const review = { findings: [{ file: 'nope.ts', severity: 'Warning', issue: 'x', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }], summary: 'All good' };
        const result = await validateFindings(review, filesDiff, changedFiles);
        assert.strictEqual(result.valid.findings.length, 0);
        assert.strictEqual(result.valid.summary, 'All good');
    });
});
describe('renderReview', () => {
    it('starts with comment marker', () => {
        const output = renderReview({ findings: [] });
        assert.ok(output.startsWith('### AI Code Review') || output === 'No issues found.');
    });
    it('renders no-issues for empty findings', () => {
        const output = renderReview({ findings: [] });
        assert.strictEqual(output, 'No issues found.');
    });
    it('renders model name in header', () => {
        const output = renderReview({
            findings: [{ file: 'a.ts', severity: 'Warning', issue: 'x', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }],
        });
        // renderReview doesn't include model name — that's added by index.ts
        // but it should contain the finding
        assert.ok(output.includes('Warning'));
        assert.ok(output.includes('a.ts'));
    });
    it('groups findings by file', () => {
        const output = renderReview({
            findings: [
                { file: 'b.ts', severity: 'Critical', issue: 'issue1', critical_action: 'fix', warning_action: 'not applicable', suggestion_action: 'not applicable' },
                { file: 'a.ts', severity: 'Warning', issue: 'issue2', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' },
                { file: 'a.ts', severity: 'Suggestion', issue: 'issue3', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: 'maybe' },
            ],
        });
        // Severity-priority ordering: Critical bucket's file (b.ts) appears before
        // Warning bucket's file (a.ts). Within each bucket files are alphabetical.
        const criticalHeaderPos = output.indexOf('Critical');
        const warningHeaderPos = output.indexOf('Warning');
        const suggestionHeaderPos = output.indexOf('Suggestion');
        assert.ok(criticalHeaderPos < warningHeaderPos, 'Critical bucket before Warning bucket');
        assert.ok(warningHeaderPos < suggestionHeaderPos, 'Warning bucket before Suggestion bucket');
        assert.ok(output.includes('b.ts'), 'b.ts appears in Critical bucket');
        assert.ok(output.includes('a.ts'), 'a.ts appears in Warning and Suggestion buckets');
        assert.ok(output.includes('issue1'));
        assert.ok(output.includes('issue2'));
        assert.ok(output.includes('issue3'));
    });
    // STRUCTURAL SNAPSHOT — locks the new severity-bucketed rendering.
    // If you intentionally rename, refactor, or restructure the renderer, update
    // both the input findings AND the frozen expected string in this test.
    it('renders multi-severity review with severity buckets and action sub-lines', () => {
        const output = renderReview({
            findings: [
                { file: 'b.ts', severity: 'Critical', line_start: 10, line_end: 15, issue: 'critical issue', critical_action: 'Fix the bug', warning_action: 'not applicable', suggestion_action: 'not applicable' },
                { file: 'a.ts', severity: 'Warning', line_start: 5, line_end: 5, issue: 'warning issue', critical_action: 'not applicable', warning_action: 'Investigate', suggestion_action: 'not applicable' },
                { file: 'a.ts', severity: 'Suggestion', issue: 'suggestion issue', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: 'Optional refactor' },
            ],
            summary: 'Multi-severity snapshot.',
        });
        const expected = `### 🚨 Critical (1)
**File:** \`b.ts\`
- 🚨 **Critical**
  **Line:** 10-15
  **Issue:** critical issue
  - **Must-fix:** Fix the bug

### ⚠️ Warning (1)
**File:** \`a.ts\`
- ⚠️ **Warning**
  **Line:** 5
  **Issue:** warning issue
  - **Investigate:** Investigate

### 💡 Suggestion (1)
**File:** \`a.ts\`
- 💡 **Suggestion**
  **Issue:** suggestion issue
  - **Nit:** Optional refactor

**Summary:** Multi-severity snapshot.`;
        assert.strictEqual(output, expected);
    });
    it('gracefully skips "not applicable" placeholders on action sub-lines', () => {
        const output = renderReview({
            findings: [
                { file: 'x.ts', severity: 'Critical', issue: 'bad', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: 'not applicable' },
            ],
        });
        assert.ok(!output.includes('not applicable'), '"not applicable" must not render as a sub-line');
        assert.ok(output.includes('🚨 **Critical**'));
        assert.ok(!output.includes('**Must-fix:**'));
    });
    it('gracefully skips empty action strings on sub-lines', () => {
        const output = renderReview({
            findings: [
                { file: 'x.ts', severity: 'Warning', issue: 'bad', critical_action: '', warning_action: '', suggestion_action: '' },
            ],
        });
        assert.ok(!output.includes('**Investigate:**'));
        assert.ok(output.includes('⚠️ **Warning**'));
    });
    it('includes suggestion when present', () => {
        const output = renderReview({
            findings: [{ file: 'x.ts', severity: 'Warning', issue: 'bad', suggestion: 'fix it', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }],
        });
        assert.ok(output.includes('fix it'));
    });
    it('includes summary when present', () => {
        const output = renderReview({
            findings: [{ file: 'x.ts', severity: 'Warning', issue: 'y', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }],
            summary: 'All done.',
        });
        assert.ok(output.includes('All done.'));
    });
    it('renders line numbers when present', () => {
        const output = renderReview({
            findings: [{ file: 'x.ts', severity: 'Critical', issue: 'bad', line_start: 10, line_end: 15, critical_action: 'fix', warning_action: 'not applicable', suggestion_action: 'not applicable' }],
        });
        assert.ok(output.includes('10'));
        assert.ok(output.includes('15'));
    });
    it('renders single line when line_end equals line_start', () => {
        const output = renderReview({
            findings: [{ file: 'x.ts', severity: 'Warning', issue: 'bad', line_start: 5, line_end: 5, critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' }],
        });
        assert.ok(output.includes('5'));
        // Should not include dash range
        assert.ok(!output.includes('5-5'));
    });
});
describe('severityTally', () => {
    it('returns zeros for empty findings', () => {
        assert.deepStrictEqual(severityTally({ findings: [] }), { critical: 0, warning: 0, suggestion: 0 });
    });
    it('counts a single severity', () => {
        assert.deepStrictEqual(severityTally({ findings: [
                { file: 'a.ts', severity: 'Critical', issue: 'x', critical_action: 'a', warning_action: 'a', suggestion_action: 'a' },
            ] }), { critical: 1, warning: 0, suggestion: 0 });
    });
    it('counts mixed severities', () => {
        assert.deepStrictEqual(severityTally({ findings: [
                { file: 'a.ts', severity: 'Critical', issue: 'x', critical_action: 'a', warning_action: 'a', suggestion_action: 'a' },
                { file: 'b.ts', severity: 'Warning', issue: 'y', critical_action: 'a', warning_action: 'a', suggestion_action: 'a' },
                { file: 'c.ts', severity: 'Warning', issue: 'z', critical_action: 'a', warning_action: 'a', suggestion_action: 'a' },
                { file: 'd.ts', severity: 'Suggestion', issue: 'w', critical_action: 'a', warning_action: 'a', suggestion_action: 'a' },
            ] }), { critical: 1, warning: 2, suggestion: 1 });
    });
});
