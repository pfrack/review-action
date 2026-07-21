import { readFileSync, writeFileSync, existsSync } from 'node:fs';
export function getRemovedModelsPath() {
    return process.env.REMOVED_MODELS_PATH || 'removed-models.txt';
}
export function readRemovedModels(path) {
    const p = path || getRemovedModelsPath();
    if (!existsSync(p))
        return [];
    return readFileSync(p, 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l !== '');
}
export function writeRemovedModels(models, path) {
    const p = path || getRemovedModelsPath();
    writeFileSync(p, models.join('\n') + (models.length > 0 ? '\n' : ''), 'utf-8');
}
export function appendRemovedModels(newModels, path) {
    const p = path || getRemovedModelsPath();
    const existing = new Set(readRemovedModels(p));
    const toAdd = newModels.filter(m => !existing.has(m));
    if (toAdd.length > 0) {
        const merged = [...existing, ...toAdd];
        writeRemovedModels(merged, p);
    }
}
export function cleanupRemovedModels(availableModels, path) {
    const p = path || getRemovedModelsPath();
    if (!existsSync(p))
        return;
    const current = readRemovedModels(p);
    const cleaned = current.filter(m => availableModels.has(m));
    if (cleaned.length !== current.length) {
        process.stderr.write(`Cleaned ${current.length - cleaned.length} permanently removed model(s) from ${p}\n`);
        writeRemovedModels(cleaned, p);
    }
}
