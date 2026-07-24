import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatFindingComment, shouldUseInlineComments, createReview, findExistingReview, deleteReview, BOT_LOGIN } from './github-review.js';
import type { ReviewFinding } from './review-schema.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: 'src/main.ts',
    severity: 'Warning',
    issue: 'Potential null dereference',
    critical_action: 'not applicable',
    warning_action: 'Add null check',
    suggestion_action: 'not applicable',
    ...overrides,
  };
}

describe('formatFindingComment', () => {
  it('formats warning finding with emoji', () => {
    const finding = makeFinding();
    const comment = formatFindingComment(finding);
    assert.ok(comment.includes('⚠️'));
    assert.ok(comment.includes('Warning'));
    assert.ok(comment.includes('Potential null dereference'));
  });

  it('formats critical finding with emoji', () => {
    const finding = makeFinding({ severity: 'Critical', critical_action: 'Fix immediately' });
    const comment = formatFindingComment(finding);
    assert.ok(comment.includes('🚨'));
    assert.ok(comment.includes('Critical'));
    assert.ok(comment.includes('Fix immediately'));
  });

  it('formats suggestion finding with emoji', () => {
    const finding = makeFinding({ severity: 'Suggestion', suggestion_action: 'Consider renaming' });
    const comment = formatFindingComment(finding);
    assert.ok(comment.includes('💡'));
    assert.ok(comment.includes('Suggestion'));
  });

  it('includes suggestion when present', () => {
    const finding = makeFinding({ suggestion: 'Use optional chaining' });
    const comment = formatFindingComment(finding);
    assert.ok(comment.includes('Use optional chaining'));
  });

  it('excludes "not applicable" action', () => {
    const finding = makeFinding();
    const comment = formatFindingComment(finding);
    assert.ok(!comment.includes('not applicable'));
  });

  it('includes non-placeholder action', () => {
    const finding = makeFinding({ warning_action: 'Investigate race condition' });
    const comment = formatFindingComment(finding);
    assert.ok(comment.includes('Investigate race condition'));
  });
});

describe('shouldUseInlineComments', () => {
  it('returns true for few line-level findings', () => {
    const findings = [
      makeFinding({ line_start: 10 }),
      makeFinding({ line_start: 20 }),
    ];
    assert.strictEqual(shouldUseInlineComments(findings), true);
  });

  it('returns false for many line-level findings', () => {
    const findings = Array.from({ length: 60 }, (_, i) =>
      makeFinding({ line_start: i + 1 })
    );
    assert.strictEqual(shouldUseInlineComments(findings), false);
  });

  it('counts only line-level findings', () => {
    const findings = [
      ...Array.from({ length: 40 }, (_, i) => makeFinding({ line_start: i + 1 })),
      ...Array.from({ length: 30 }, () => makeFinding({ line_start: undefined })),
    ];
    assert.strictEqual(shouldUseInlineComments(findings), true);
  });
});

describe('createReview', () => {
  const originalFetch = globalThis.fetch;

  it('posts review with inline comments and returns review ID', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    globalThis.fetch = (async (url: string, init?: any) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init?.body || '{}');
      return { ok: true, json: async () => ({ id: 12345 }) } as any;
    }) as any;
    try {
      const findings = [
        makeFinding({ file: 'src/main.ts', line_start: 10 }),
        makeFinding({ file: 'src/utils.ts', line_start: 20 }),
      ];
      const reviewId = await createReview('owner/repo', 42, 'abc123', findings, 'Review summary', 'test-token');
      assert.strictEqual(reviewId, 12345);
      assert.ok(capturedUrl.includes('/pulls/42/reviews'));
      assert.strictEqual(capturedBody.event, 'COMMENT');
      assert.strictEqual(capturedBody.comments.length, 2);
      assert.strictEqual(capturedBody.comments[0].path, 'src/main.ts');
      assert.strictEqual(capturedBody.comments[0].line, 10);
      assert.strictEqual(capturedBody.comments[0].side, 'RIGHT');
      assert.strictEqual(capturedBody.body, 'Review summary');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('throws when no token provided', async () => {
    await assert.rejects(
      createReview('owner/repo', 42, 'abc123', [], undefined, undefined),
      /GITHUB_TOKEN required/,
    );
  });

  it('filters findings without line_start', async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: string, init?: any) => {
      capturedBody = JSON.parse(init?.body || '{}');
      return { ok: true, json: async () => ({ id: 999 }) } as any;
    }) as any;
    try {
      const findings = [
        makeFinding({ file: 'src/main.ts', line_start: 10 }),
        makeFinding({ file: 'src/main.ts' }),
      ];
      const reviewId = await createReview('owner/repo', 42, 'abc123', findings, undefined, 'token');
      assert.strictEqual(reviewId, 999);
      assert.strictEqual(capturedBody.comments.length, 1);
      assert.strictEqual(capturedBody.comments[0].path, 'src/main.ts');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('findExistingReview', () => {
  const originalFetch = globalThis.fetch;

  it('returns review ID when found', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { id: 100, body: 'Some other review', user: { login: 'other-bot' } },
        { id: 200, body: '### AI Code Review\nFindings here', user: { login: BOT_LOGIN } },
      ],
    }) as any;
    try {
      const reviewId = await findExistingReview('owner/repo', 42, 'token');
      assert.strictEqual(reviewId, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when no matching review found', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { id: 200, body: '### AI Code Review\nFindings here', user: { login: 'other-bot' } },
      ],
    }) as any;
    try {
      const reviewId = await findExistingReview('owner/repo', 42, 'token');
      assert.strictEqual(reviewId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null when matching marker but wrong bot login', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [
        { id: 200, body: '### AI Code Review\nFindings here', user: { login: 'human-reviewer' } },
      ],
    }) as any;
    try {
      const reviewId = await findExistingReview('owner/repo', 42, 'token');
      assert.strictEqual(reviewId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns null on 404', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    }) as any;
    try {
      const reviewId = await findExistingReview('owner/repo', 42, 'token');
      assert.strictEqual(reviewId, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('deleteReview', () => {
  const originalFetch = globalThis.fetch;

  it('sends DELETE request', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    globalThis.fetch = (async (url: string, init?: any) => {
      capturedUrl = url;
      capturedMethod = init?.method || '';
      return { ok: true } as any;
    }) as any;
    try {
      await deleteReview('owner/repo', 42, 200, 'token');
      assert.ok(capturedUrl.includes('/pulls/42/reviews/200'));
      assert.strictEqual(capturedMethod, 'DELETE');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
