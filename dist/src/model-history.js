import { readFileSync, writeFileSync, existsSync } from 'node:fs';
export function loadHistory(path = 'model-history.json') {
    if (!existsSync(path))
        return {};
    const content = readFileSync(path, 'utf-8').trim();
    if (!content)
        return {};
    try {
        return JSON.parse(content);
    }
    catch {
        process.stderr.write(`Warning: could not parse history file ${path}, starting fresh\n`);
        return {};
    }
}
export function saveHistory(history, path = 'model-history.json') {
    writeFileSync(path, JSON.stringify(history, null, 2) + '\n', 'utf-8');
}
export function detectNewModels(history, provider, currentModels) {
    const known = new Set(history[provider]?.models ?? []);
    return currentModels.filter(m => !known.has(m));
}
export function detectRemovedModels(history, provider, currentModels) {
    const current = new Set(currentModels);
    const known = history[provider]?.models ?? [];
    return known.filter(m => !current.has(m));
}
export function updateHistory(history, provider, activeModels) {
    return {
        ...history,
        [provider]: { models: [...activeModels] },
    };
}
