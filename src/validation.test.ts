import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCodeContext } from './validation.js';
import type { ReviewFinding } from './review-schema.js';

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    file: 'src/main.ts',
    severity: 'Warning',
    issue: 'test issue',
    critical_action: 'not applicable',
    warning_action: 'investigate',
    suggestion_action: 'not applicable',
    ...overrides,
  };
}

describe('validateCodeContext', () => {
  const diff = `diff --git a/src/main.ts b/src/main.ts
@@ -10,5 +10,7 @@
 import { fetchData } from './api';
+import { processData } from './utils';
+import type { HTTPRequest, RequestConfig } from './types';
 
 function handleRequest() {
   const data = fetchData();
+  const result = processData(data);
 }`;

  it('passes finding with no code references', () => {
    const finding = makeFinding({ issue: 'This function is too complex' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('passes finding referencing function that exists in diff', () => {
    const finding = makeFinding({ issue: 'The call to `fetchData` may fail without error handling' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('fails finding referencing function not in diff', () => {
    const finding = makeFinding({ issue: 'The call to `nonexistentFunc` may fail' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes('nonexistentFunc'));
  });

  it('passes finding referencing variable that exists in diff', () => {
    const finding = makeFinding({ issue: 'The variable `data` is not validated' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('fails finding referencing variable not in diff', () => {
    const finding = makeFinding({ issue: 'The variable `unknownVar` is not validated' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes('unknownVar'));
  });

  it('passes finding referencing class that exists in diff', () => {
    const finding = makeFinding({ issue: 'The class `HTTPRequest` should implement timeout' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('passes finding referencing type that exists in diff', () => {
    const finding = makeFinding({ issue: 'The type `RequestConfig` is missing retry fields' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('ignores short names (<=2 chars) to avoid false positives', () => {
    const finding = makeFinding({ issue: 'The function `ab` is not used' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });

  it('passes finding with empty diff', () => {
    const finding = makeFinding({ issue: 'The call to `processData` may fail' });
    const result = validateCodeContext(finding, '');
    assert.strictEqual(result.valid, false);
  });

  it('passes finding when issue has no identifiable references', () => {
    const finding = makeFinding({ issue: 'This code could be more readable' });
    const result = validateCodeContext(finding, diff);
    assert.strictEqual(result.valid, true);
  });
});
