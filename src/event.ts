import { readFileSync } from 'node:fs';

interface RawGitHubEvent {
  pull_request?: {
    number: number;
    head: { sha: string };
  };
}

export interface GitHubEvent {
  pull_request: {
    number: number;
    head: { sha: string };
  };
}

export function loadEvent(): GitHubEvent {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) {
    throw new Error('GITHUB_EVENT_PATH not set');
  }

  const data = readFileSync(path, 'utf8');
  let event: RawGitHubEvent;
  try {
    event = JSON.parse(data) as RawGitHubEvent;
  } catch (err) {
    throw new Error(`Failed to parse GitHub event payload at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (event.pull_request === undefined || event.pull_request === null) {
    const eventName = process.env.GITHUB_EVENT_NAME || 'unknown';
    throw new Error(
      `This action only runs on pull_request events. ` +
      `Received "${eventName}" event (no pull_request payload) — check your workflow triggers.`,
    );
  }

  if (!event.pull_request.number || !event.pull_request.head?.sha) {
    throw new Error('No PR number or head SHA in event payload');
  }

  return event as GitHubEvent;
}
