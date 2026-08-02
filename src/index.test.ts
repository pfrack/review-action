import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIClient } from './openai-client.js';
import { ReviewJsonSchema } from './review-schema.js';
import { validateFindings } from './review.js';
import { severityTally } from './render.js';
import { buildSystemPrompt, buildSystemMessage, BASE_SYSTEM_PROMPT, SEVERITY_GUIDANCE } from './prompts.js';
import { JSON_SCHEMA_DEFINITION } from './review-schema.js';
import { startMockServer } from './test-utils.js';
import { computeMaxTokens, runModelChainForBatch, buildClients, buildRawOutputBody, type BatchResult, withAggregateTimeout, executeReview, prioritizeChain, run } from './index.js';
import { type TaggedModel, type Provider } from './model-chain.js';
import { type FileBatch } from './batching.js';
import { type Config } from './config.js';
import { type ChatResult, type ChatMessage, type ChatOptions } from './openai-client.js';

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

describe('buildRawOutputBody — XSS escaping', () => {
  it('escapes <script> tags in lastRawContent', () => {
    const body = buildRawOutputBody('<!-- header -->', 'output <script>alert(1)</script>');
    assert.ok(!body.includes('<script>'), 'literal <script> tag must not appear in body');
    assert.ok(body.includes('\\<script\\>alert\\(1\\)\\</script\\>'), 'escaped form must be present');
  });

  it('escapes img onerror payloads', () => {
    const body = buildRawOutputBody('summary', '<img src=x onerror=alert(1)>');
    assert.ok(body.includes('\\<img'), 'escaped form must be present (leading backslash before <img)');
    assert.ok(!/[^\\]<img /.test(body), 'un-escaped `<img ` (without leading backslash) must not appear');
  });

  it('still keeps the inner text readable after escaping', () => {
    const body = buildRawOutputBody('summary', 'function foo() { return x < y; }');
    assert.ok(body.includes('function foo'));
    assert.ok(body.includes('\\<'), '< must be escaped');
  });

  it('passes summary body through unchanged', () => {
    const body = buildRawOutputBody('### AI Code Review', 'content');
    assert.ok(body.startsWith('### AI Code Review'));
  });
});

describe('OpenAIClient integration', () => {
  it('returns parsed ReviewJsonSchema-shaped content on successful chat', async () => {
    const mock = await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              findings: [{ file: 'src/a.ts', severity: 'Warning', issue: 'unused var', critical_action: 'not applicable', warning_action: 'remove it', suggestion_action: 'not applicable' }],
              summary: 'review summary',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });

    try {
      const client = new OpenAIClient(mock.url, 'key');
      const result = await client.chat('model', [{ role: 'user', content: 'hello' }], {
        schema: ReviewJsonSchema,
        format: 'json_schema',
      });
      const parsed = JSON.parse(result.content);
      assert.ok(Array.isArray(parsed.findings), 'content must parse to an object with a findings array');
      assert.strictEqual(typeof parsed.summary, 'string', 'content must include a summary string');
    } finally {
      mock.close();
    }
  });
});

describe('severityTally', () => {
  it('counts mixed severities', () => {
    const review = {
      findings: [
        { file: 'a.ts', severity: 'Critical' as const, issue: '', critical_action: '', warning_action: 'not applicable', suggestion_action: 'not applicable' },
        { file: 'b.ts', severity: 'Warning' as const, issue: '', critical_action: 'not applicable', warning_action: '', suggestion_action: 'not applicable' },
        { file: 'c.ts', severity: 'Suggestion' as const, issue: '', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: '' },
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
        { file: 'a.ts', line_start: 2, severity: 'Warning' as const, issue: 'test', critical_action: 'not applicable', warning_action: 'investigate', suggestion_action: 'not applicable' },
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
    const result = await withAggregateTimeout(
      () => new Promise(resolve => setTimeout(() => resolve('late'), 500)),
      50,
    );
    assert.strictEqual(result, null);
  });

  it('returns result when operation completes before timer', async () => {
    const result = await withAggregateTimeout(
      () => new Promise(resolve => setTimeout(() => resolve('fast'), 10)),
      5000,
    );
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

const VALID_CHAT_RESULT: ChatResult = {
  content: VALID_REVIEW_JSON,
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  latency: 100,
  finishReason: 'stop',
};

const TRUNCATED_CHAT_RESULT: ChatResult = {
  content: '{ "findings": [ { "file": "src/a.ts", "severity": "Warni',
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  latency: 100,
  finishReason: 'length',
};

type MockBehavior = { response?: ChatResult; delayMs?: number; shouldThrow?: boolean };

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    strictRevalidation: false,
    dropUnreferenced: false,
    modelTimeout: 90,
    chainTimeout: 0,
    maxTokens: 0,
    parallelAttempts: 1,
    parallelThreshold: 40,
    ...overrides,
  };
}

function makeMockClient(
  behaviorForModel: (model: string) => MockBehavior,
  callCounts: Record<string, number> = {},
): OpenAIClient {
  const client = Object.create(OpenAIClient.prototype) as OpenAIClient;

  (client as any).chat = async (model: string, _messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult> => {
    callCounts[model] = (callCounts[model] || 0) + 1;

    if (opts?.signal?.aborted) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }

    const { response, delayMs = 0, shouldThrow = false } = behaviorForModel(model);

    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => resolve(), delayMs);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }).catch((err: Error) => {
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

const TEST_BATCH: FileBatch = {
  files: ['src/a.ts'],
  diffs: { 'src/a.ts': 'diff --git a/src/a.ts b/src/a.ts\n+added line\n' },
};

const TEST_CHAIN: TaggedModel[] = [
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
    const callCounts: Record<string, number> = {};
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({}), callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    assert.strictEqual(result.usedModel, 'model-a');
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(callCounts['model-a'], 1);
  });

  it('falls through to next model on failure', async () => {
    const config = makeConfig();
    const callCounts: Record<string, number> = {};
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient((model) => {
        if (model === 'model-a') return { shouldThrow: true };
        return {};
      }, callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    assert.strictEqual(result.usedModel, 'model-b');
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(callCounts['model-a'], 1);
    assert.strictEqual(callCounts['model-b'], 1);
  });

  it('returns empty result when all models fail', async () => {
    const config = makeConfig();
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({ shouldThrow: true })),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    assert.strictEqual(result.findings.length, 0);
    assert.strictEqual(result.usedModel, '');
  });

  it('handles truncated response by trying next model', async () => {
    const config = makeConfig();
    const callCounts: Record<string, number> = {};
    let retryAttempted = false;
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient((model) => {
        if (model === 'model-a') return { response: TRUNCATED_CHAT_RESULT };
        return {};
      }, callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    // model-a: truncated → safeParseJson fails → returns null, no retry
    // model-b: succeeds
    assert.strictEqual(result.usedModel, 'model-b');
    assert.strictEqual(result.findings.length, 1);
  });

  it('retries once on schema validation failure, then falls through', async () => {
    const config = makeConfig();
    const callCounts: Record<string, number> = {};
    const clients: Record<Provider, OpenAIClient | null> = {
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
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    // model-a: invalid schema → retry → still invalid → fall through
    // model-b: succeeds
    assert.strictEqual(result.usedModel, 'model-b');
    assert.strictEqual(callCounts['model-a'], 2);
  });
});

describe('runModelChainForBatch parallel fallback', () => {
  it('picks winner when parallel mode enabled and head model succeeds', async () => {
    const config = makeConfig({ parallelAttempts: 3, parallelThreshold: 0 });
    const callCounts: Record<string, number> = {};
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({}), callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      TEST_CHAIN, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    assert.strictEqual(result.findings.length, 1);
    assert.strictEqual(result.usedModel, 'model-a');
  });

  it('returns result from fast model when slow model is tried first', async () => {
    const config = makeConfig({ parallelAttempts: 2, parallelThreshold: 0 });
    const callCounts: Record<string, number> = {};

    const chain: TaggedModel[] = [
      { id: 'slow-model', provider: 'nim' },
      { id: 'fast-model', provider: 'nim' },
    ];
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient((model) => {
        if (model === 'slow-model') return { delayMs: 2000 };
        return {};
      }, callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };

    const result = await runModelChainForBatch(
      chain, clients, TEST_BATCH, 'system', 'json_schema', config, 5000,
    );
    assert.strictEqual(result.usedModel, 'fast-model');
    assert.strictEqual(result.findings.length, 1);
  });

  it('parallel mode with all failures falls back to remaining chain', async () => {
    const config = makeConfig({ parallelAttempts: 2, parallelThreshold: 0 });
    const chain: TaggedModel[] = [
      { id: 'fail-a', provider: 'nim' },
      { id: 'fail-b', provider: 'nim' },
      { id: 'success-c', provider: 'nim' },
    ];
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient((model) => {
        if (model === 'fail-a' || model === 'fail-b') return { shouldThrow: true };
        return {};
      }),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const result = await runModelChainForBatch(
      chain, clients, TEST_BATCH, 'system', 'json_schema', config, 500,
    );
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

describe('prioritizeChain', () => {
  it('does not change chain order regardless of probe results', async () => {
    const chain: TaggedModel[] = [
      { id: 'model-slow', provider: 'nim' },
      { id: 'model-fast', provider: 'mistral' },
      { id: 'model-medium', provider: 'groq' },
    ];
    const originalOrder = chain.map(m => m.id);

    const clients: Record<Provider, OpenAIClient | null> = {
      nim: { probeModel: async () => true } as unknown as OpenAIClient,
      mistral: { probeModel: async () => { await new Promise(r => setTimeout(r, 1)); return true; } } as unknown as OpenAIClient,
      groq: { probeModel: async () => true } as unknown as OpenAIClient,
      openrouter: null, kilocode: null, custom: null,
    };

    await prioritizeChain(chain, clients);
    assert.deepStrictEqual(chain.map(m => m.id), originalOrder, 'chain order must not change after prioritizeChain');
  });

  it('logs probe results without reordering', async () => {
    const chain: TaggedModel[] = [
      { id: 'head-model', provider: 'nim' },
      { id: 'other-model', provider: 'mistral' },
    ];
    const originalOrder = chain.map(m => m.id);

    const clients: Record<Provider, OpenAIClient | null> = {
      nim: { probeModel: async () => true } as unknown as OpenAIClient,
      mistral: { probeModel: async () => true } as unknown as OpenAIClient,
      groq: null, openrouter: null, kilocode: null, custom: null,
    };

    await prioritizeChain(chain, clients);
    assert.deepStrictEqual(chain.map(m => m.id), originalOrder);
  });
});

describe('executeReview — batch loop resilience', () => {
  it('continues to next batch when one batch throws', async () => {
    // Build a diffs map where accessing 'throw.ts' throws — simulating
    // an unexpected error inside runModelChainForBatch that escapes
    // attemptModel's try/catch (e.g., a bug in chain setup).
    const throwingDiffs: Record<string, string> = {};
    Object.defineProperty(throwingDiffs, 'throw.ts', {
      get() { throw new Error('simulated unexpected error'); },
      enumerable: true,
    });
    throwingDiffs['b.ts'] = 'normal diff';
    throwingDiffs['c.ts'] = 'normal diff';

    const batch1: FileBatch = { files: ['throw.ts', 'b.ts'], diffs: throwingDiffs };
    const batch2: FileBatch = { files: ['c.ts'], diffs: { 'c.ts': 'normal diff' } };

    const config = makeConfig({ chainTimeout: 0 });
    const callCounts: Record<string, number> = {};
    const batch2Result: ChatResult = {
      content: JSON.stringify({
        findings: [{ file: 'c.ts', severity: 'Suggestion', issue: 'test finding', critical_action: 'not applicable', warning_action: 'not applicable', suggestion_action: 'fix it' }],
        summary: 'batch 2 summary',
      }),
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      latency: 100,
      finishReason: 'stop',
    };
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({ response: batch2Result }), callCounts),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const chain: TaggedModel[] = [{ id: 'model-a', provider: 'nim' }];

    const result = await executeReview(
      chain, clients, ['throw.ts', 'b.ts', 'c.ts'], throwingDiffs, [batch1, batch2], 'system', config,
    );

    // Batch 2 should still produce findings
    assert.ok(result.review.findings.length > 0, 'batch 2 findings should be present');
    assert.strictEqual(result.usedModel, 'model-a');
    assert.strictEqual(result.batchCount, 2);
    assert.strictEqual(callCounts['model-a'], 1, 'batch 2 should have called model-a');
  });

  it('with chainTimeout > 0 still catches throws from runBatch', async () => {
    const throwingDiffs: Record<string, string> = {};
    Object.defineProperty(throwingDiffs, 'throw.ts', {
      get() { throw new Error('simulated unexpected error'); },
      enumerable: true,
    });

    const batch1: FileBatch = { files: ['throw.ts'], diffs: throwingDiffs };

    const config = makeConfig({ chainTimeout: 300 });
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({ response: VALID_CHAT_RESULT })),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };
    const chain: TaggedModel[] = [{ id: 'model-a', provider: 'nim' }];

    const result = await executeReview(
      chain, clients, ['throw.ts'], throwingDiffs, [batch1], 'system', config,
    );

    assert.strictEqual(result.review.findings.length, 0);
    assert.strictEqual(result.batchCount, 1);
  });
});

describe('runModelChainForBatch parallel logging', () => {
  it('logs winner and cancelled model ids in parallel mode', async () => {
    const config = makeConfig({ parallelAttempts: 2, parallelThreshold: 0 });
    const chain: TaggedModel[] = [
      { id: 'slow-model', provider: 'nim' },
      { id: 'fast-model', provider: 'nim' },
    ];
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient((model) => {
        if (model === 'slow-model') return { delayMs: 2000 };
        return {};
      }),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };

    const messages: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: any) => {
      if (typeof data === 'string') messages.push(data);
      return true;
    };
    try {
      await runModelChainForBatch(chain, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
    } finally {
      process.stdout.write = originalWrite;
    }

    const parallelLog = messages.find(m => m.includes('Parallel:') && m.includes('fast-model') && m.includes('cancelled'));
    assert.ok(parallelLog, `expected parallel log with winner+cancelled, got: ${JSON.stringify(messages)}`);
  });

  it('does not log parallel winner when only one model in chain', async () => {
    const config = makeConfig({ parallelAttempts: 3, parallelThreshold: 0 });
    const chain: TaggedModel[] = [{ id: 'single-model', provider: 'nim' }];
    const clients: Record<Provider, OpenAIClient | null> = {
      nim: makeMockClient(() => ({})),
      mistral: null, groq: null, openrouter: null, kilocode: null, custom: null,
    };

    const messages: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data: any) => {
      if (typeof data === 'string') messages.push(data);
      return true;
    };
    try {
      await runModelChainForBatch(chain, clients, TEST_BATCH, 'system', 'json_schema', config, 5000);
    } finally {
      process.stdout.write = originalWrite;
    }

    const parallelLog = messages.find(m => m.includes('Parallel:'));
    assert.strictEqual(parallelLog, undefined, 'no parallel log when only one model in chain');
  });
});

describe('run — orchestrator', () => {
  const REPO = 'octocat/hello';
  const PR = 42;
  const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,6 @@
 line1
+added line
 line3
 line4
 line5
`;
  const REVIEW = {
    findings: [
      { file: 'src/a.ts', line_start: 2, severity: 'Warning', issue: 'unused variable', critical_action: 'not applicable', warning_action: 'remove unused variable', suggestion_action: 'not applicable' },
    ],
    summary: 'review summary',
  };

  function makeGithubFetch(captured: string[], mockUrl: string): typeof fetch {
    const realFetch = globalThis.fetch;
    return async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      if (url.includes(mockUrl)) return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = init?.headers ?? {};
      const accept = headers && (headers['Accept'] ?? headers['accept'] ?? '');
      const acceptStr = Array.isArray(accept) ? accept.join(' ') : String(accept ?? '');
      if (method === 'GET' && url === `https://api.github.com/repos/${REPO}/pulls/${PR}` && acceptStr.includes('v3.diff')) {
        return new Response(DIFF, { status: 200 });
      }
      if (method === 'GET' && url.includes(`/issues/${PR}/comments`)) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'GET' && url.includes(`/pulls/${PR}/reviews`)) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'POST' && url.endsWith(`/issues/${PR}/comments`)) {
        const body = typeof init?.body === 'string' ? init.body : '';
        captured.push(body);
        return new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }

  function withEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    const orig: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      orig[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return orig;
  }

  function restoreEnv(orig: Record<string, string | undefined>): void {
    for (const k of Object.keys(orig)) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }

  async function runWithEnv(env: Record<string, string | undefined>, captured: string[]): Promise<void> {
    process.env.NODE_TEST_CONTEXT = '1';
    const mock = await startMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(REVIEW) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = makeGithubFetch(captured, mock.url);
    const eventPath = join(tmpdir(), `event-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const orig = withEnv({
      GITHUB_REPOSITORY: REPO,
      GITHUB_TOKEN: 'fake-token',
      GITHUB_EVENT_PATH: eventPath,
      INPUT_CUSTOM_API_URL: mock.url,
      INPUT_CUSTOM_MODEL: 'mock-model',
      INPUT_CUSTOM_API_KEY: 'test-key',
      INPUT_MAX_FILES: '100',
      INPUT_REVALIDATE_FINDINGS: 'false',
      ...env,
    });
    writeFileSync(eventPath, JSON.stringify({ pull_request: { number: PR, head: { sha: 'abc123' } } }));
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
      restoreEnv(orig);
      delete process.env.NODE_TEST_CONTEXT;
      mock.close();
      try { unlinkSync(eventPath); } catch { /* ignore */ }
    }
  }

  it('posts the AI Code Review comment end-to-end', async () => {
    const captured: string[] = [];
    await runWithEnv({}, captured);
    assert.strictEqual(captured.length, 1, 'exactly one comment should be posted');
    const body = captured[0];
    assert.ok(body.includes('### AI Code Review'), 'comment must carry the AI Code Review marker');
    assert.ok(body.includes('unused variable'), 'comment must include the finding text');
  });

  it('posts a no-reviewable-files comment when all files are excluded', async () => {
    const captured: string[] = [];
    await runWithEnv({ INPUT_EXCLUDE_PATTERNS: '*.ts' }, captured);
    assert.strictEqual(captured.length, 1);
    assert.ok(captured[0].includes('No reviewable files found'), 'excluded-files path must post the no-reviewable-files comment');
  });
});
