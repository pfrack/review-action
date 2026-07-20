import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseDiff, shouldExclude, resolveSystemPrompt, loadConfig, parseDiffHunks, getFileHunks, validateFindings, type Config } from './review.js';

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
  const tests: { name: string; filepath: string; patterns: string[]; want: boolean }[] = [
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
  const baseConfig: Config = {
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
    assert.ok(prompt.includes('findings'));
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
  const saved: Record<string, string | undefined> = {};

  it('reads mistralApiKey and mistralModels from inputs', () => {
    // Save original values
    for (const key of ENV_KEYS) saved[key] = process.env[key];

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
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults mistral fields to empty when not provided', () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

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
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
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
  const saved: Record<string, string | undefined> = {};

  it('reads customApiUrl, customModel, customApiKey from inputs', () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

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
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults custom fields to empty when not provided', () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];

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
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
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
    const filesDiff: Record<string, string> = {
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
  const filesDiff: Record<string, string> = {
    'src/main.ts': 'diff --git a/src/main.ts b/src/main.ts\n@@ -10,3 +10,5 @@\n old\n+new1\n+new2\n old2\n',
  };
  const changedFiles = new Set(['src/main.ts']);

  it('drops finding for file not in changed set', () => {
    const review = { findings: [{ file: 'unknown.ts', severity: 'Warning' as const, issue: 'bad', line_start: 11, line_end: 12 }] };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 1); // warning finding inserted
    assert.ok(result.warnings.some(w => w.includes('unknown.ts')));
  });

  it('drops finding with line outside all hunks', () => {
    const review = { findings: [{ file: 'src/main.ts', severity: 'Critical' as const, issue: 'bad', line_start: 100, line_end: 105 }] };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 1); // warning finding
    assert.ok(result.warnings.some(w => w.includes('100')));
  });

  it('keeps finding with line inside hunk', () => {
    const review = { findings: [{ file: 'src/main.ts', severity: 'Warning' as const, issue: 'ok', line_start: 11, line_end: 12 }] };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 1);
    assert.strictEqual(result.valid.findings[0].issue, 'ok');
    assert.strictEqual(result.warnings.length, 0);
  });

  it('keeps file-wide finding (no line)', () => {
    const review = { findings: [{ file: 'src/main.ts', severity: 'Suggestion' as const, issue: 'no tests' }] };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 1);
    assert.strictEqual(result.warnings.length, 0);
  });

  it('inserts warning finding when all findings dropped', () => {
    const review = { findings: [{ file: 'nope.ts', severity: 'Warning' as const, issue: 'x' }] };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 1);
    assert.strictEqual(result.valid.findings[0].file, '<global>');
    assert.ok(result.warnings.length > 0);
  });

  it('returns empty valid finding for clean review with summary', () => {
    const review = { findings: [{ file: 'nope.ts', severity: 'Warning' as const, issue: 'x' }], summary: 'All good' };
    const result = validateFindings(review, filesDiff, changedFiles);
    assert.strictEqual(result.valid.findings.length, 0);
    assert.strictEqual(result.valid.summary, 'All good');
  });
});
