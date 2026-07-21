/**
 * Single-process CLI helpers for tracking models that should be retried on
 * the next benchmark run.
 *
 * NOTE: This module uses synchronous file I/O and reads the on-disk file
 * every time the contents are inspected. It is safe for the bench-entry /
 * bench-reorder scripts (one process per workflow run), but it is NOT
 * safe to share the same file path across concurrent processes — there is
 * no locking. If you need concurrent access, add an external lock file
 * (mkdir-based mutex is enough) and switch the read-modify-write callers
 * to take that lock first.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
  const p = path || getRemovedModelsPath();
  const existing = new Set(readRemovedModels(p));
  const toAdd = newModels.filter(m => !existing.has(m));
  if (toAdd.length > 0) {
    const merged = [...existing, ...toAdd];
    writeRemovedModels(merged, p);
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
