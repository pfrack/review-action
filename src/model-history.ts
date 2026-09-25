import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export interface ProviderHistory {
  models: string[];
}

export interface ModelHistory {
  [provider: string]: ProviderHistory;
}

export function loadHistory(path = 'model-history.json'): ModelHistory {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return {};
  try {
    return JSON.parse(content) as ModelHistory;
  } catch {
    process.stderr.write(`Warning: could not parse history file ${path}, starting fresh\n`);
    return {};
  }
}

export function saveHistory(history: ModelHistory, path = 'model-history.json'): void {
  writeFileSync(path, JSON.stringify(history, null, 2) + '\n', 'utf-8');
}

export function detectNewModels(history: ModelHistory, provider: string, currentModels: string[]): string[] {
  const known = new Set(history[provider]?.models ?? []);
  return currentModels.filter(m => !known.has(m));
}

export function detectRemovedModels(history: ModelHistory, provider: string, currentModels: string[]): string[] {
  const current = new Set(currentModels);
  const known = history[provider]?.models ?? [];
  return known.filter(m => !current.has(m));
}

export function updateHistory(history: ModelHistory, provider: string, activeModels: string[]): ModelHistory {
  return {
    ...history,
    [provider]: { models: [...activeModels] },
  };
}
