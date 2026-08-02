import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadEvent } from './event.js';

describe('loadEvent', () => {
  const originalEnvPath = process.env.GITHUB_EVENT_PATH;
  const originalEnvName = process.env.GITHUB_EVENT_NAME;

  function writeTempEvent(payload: unknown): string {
    const tmpDir = mkdtempSync(join(tmpdir(), 'event-test-'));
    const filePath = join(tmpDir, 'event.json');
    writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
    return tmpDir;
  }

  it('loads a valid pull_request event', () => {
    const tmpDir = writeTempEvent({
      pull_request: { number: 42, head: { sha: 'abc123' } },
    });
    process.env.GITHUB_EVENT_PATH = join(tmpDir, 'event.json');
    try {
      const event = loadEvent();
      assert.strictEqual(event.pull_request.number, 42);
      assert.strictEqual(event.pull_request.head.sha, 'abc123');
    } finally {
      process.env.GITHUB_EVENT_PATH = originalEnvPath;
      process.env.GITHUB_EVENT_NAME = originalEnvName;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws event-type error when payload lacks pull_request (push event)', () => {
    const tmpDir = writeTempEvent({ ref: 'refs/heads/main', repository: { name: 'repo' } });
    process.env.GITHUB_EVENT_PATH = join(tmpDir, 'event.json');
    process.env.GITHUB_EVENT_NAME = 'push';
    try {
      assert.throws(
        () => loadEvent(),
        /This action only runs on pull_request events/,
      );
    } finally {
      process.env.GITHUB_EVENT_PATH = originalEnvPath;
      process.env.GITHUB_EVENT_NAME = originalEnvName;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws event-type error with event name in message', () => {
    const tmpDir = writeTempEvent({ action: 'created' });
    process.env.GITHUB_EVENT_PATH = join(tmpDir, 'event.json');
    process.env.GITHUB_EVENT_NAME = 'issues';
    try {
      assert.throws(
        () => loadEvent(),
        /This action only runs on pull_request events.*Received "issues" event/,
      );
    } finally {
      process.env.GITHUB_EVENT_PATH = originalEnvPath;
      process.env.GITHUB_EVENT_NAME = originalEnvName;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws "No PR number" error when pull_request exists but fields are missing', () => {
    const tmpDir = writeTempEvent({ pull_request: {} });
    process.env.GITHUB_EVENT_PATH = join(tmpDir, 'event.json');
    try {
      assert.throws(
        () => loadEvent(),
        /No PR number or head SHA/,
      );
    } finally {
      process.env.GITHUB_EVENT_PATH = originalEnvPath;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws GITHUB_EVENT_PATH not set error', () => {
    delete process.env.GITHUB_EVENT_PATH;
    try {
      assert.throws(
        () => loadEvent(),
        /GITHUB_EVENT_PATH not set/,
      );
    } finally {
      process.env.GITHUB_EVENT_PATH = originalEnvPath;
    }
  });
});
