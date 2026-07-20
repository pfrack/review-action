import { getSweBenchScore } from './bench-reorder.js';
/**
 * Build a combined fallback chain from NIM and Mistral model lists,
 * sorted by SWE-bench score descending. Only includes models whose
 * provider key is available.
 *
 * Stable sort — preserves original order within same score.
 */
export function buildCombinedChain(opts) {
    const chain = [];
    if (opts.hasNimKey) {
        for (const id of opts.nimModels) {
            chain.push({ id, provider: 'nim' });
        }
    }
    if (opts.hasMistralKey) {
        for (const id of opts.mistralModels) {
            chain.push({ id, provider: 'mistral' });
        }
    }
    // Stable sort by SWE-bench score descending
    chain.sort((a, b) => {
        const scoreA = getSweBenchScore(a.id);
        const scoreB = getSweBenchScore(b.id);
        return scoreB - scoreA;
    });
    // Prepend custom model — always tried first regardless of score
    if (opts.customModel && opts.hasCustomConfig) {
        chain.unshift({ id: opts.customModel, provider: 'custom' });
    }
    return chain;
}
