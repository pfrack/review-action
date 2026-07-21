import { appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

export function getRemovedModelsPath(): string {
  return process.env.REMOVED_MODELS_PATH || 'removed-models.txt';
}

export function readRemovedModels(path?: string): string[] {
  const p = path || getRemovedModelsPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '');
}

export function writeRemovedModels(models: string[], path?: string): void {
  const p = path || getRemovedModelsPath();
  writeFileSync(p, models.join('\n') + (models.length > 0 ? '\n' : ''), 'utf-8');
}

export function appendRemovedModels(newModels: string[], path?: string): void {
  const existing = new Set(readRemovedModels(path));
  const toAdd = newModels.filter(m => !existing.has(m));
  if (toAdd.length > 0) {
    appendFileSync(path || getRemovedModelsPath(), toAdd.join('\n') + '\n', 'utf-8');
  }
}

export function cleanupRemovedModels(availableModels: Set<string>, path?: string): void {
  const p = path || getRemovedModelsPath();
  if (!existsSync(p)) return;
  const current = readRemovedModels(p);
  const cleaned = current.filter(m => availableModels.has(m));
  if (cleaned.length !== current.length) {
    process.stderr.write(`Cleaned ${current.length - cleaned.length} permanently removed model(s) from ${p}\n`);
    writeRemovedModels(cleaned, p);
  }
}
