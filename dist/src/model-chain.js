import { getSweBenchScore } from './bench-reorder.js';
/**
 * Build the model fallback chain.
 *
 * Custom models (no SWE-bench score) are always first — never sorted
 * alongside provider models.
 *
 * Provider models (NIM, Mistral, Groq) are combined and sorted by
 * SWE-bench score descending as the fallback chain.
 *
 * Only includes models whose provider key is available.
 */
export function buildCombinedChain(opts) {
    const providerModels = [];
    const { groqModels = [], hasGroqKey = false } = opts;
    if (opts.hasNimKey) {
        for (const id of opts.nimModels) {
            providerModels.push({ id, provider: 'nim' });
        }
    }
    if (opts.hasMistralKey) {
        for (const id of opts.mistralModels) {
            providerModels.push({ id, provider: 'mistral' });
        }
    }
    if (hasGroqKey) {
        for (const id of groqModels) {
            providerModels.push({ id, provider: 'groq' });
        }
    }
    providerModels.sort((a, b) => {
        const scoreA = getSweBenchScore(a.id);
        const scoreB = getSweBenchScore(b.id);
        return scoreB - scoreA;
    });
    if (opts.customModel && opts.hasCustomConfig) {
        return [{ id: opts.customModel, provider: 'custom' }, ...providerModels];
    }
    return providerModels;
}
const PROBE_TIMEOUT_MS = 10_000;
export async function probeModels(chain, clients) {
    const probes = chain.map(async (tagged) => {
        const client = clients[tagged.provider];
        if (!client)
            return null;
        try {
            const start = Date.now();
            const ok = await Promise.race([
                client.probeModel(tagged.id),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)),
            ]);
            if (ok)
                return { model: tagged, latency: Date.now() - start };
            return null;
        }
        catch {
            return null;
        }
    });
    const results = await Promise.all(probes);
    const available = results.filter((r) => r !== null);
    if (available.length === 0)
        return null;
    available.sort((a, b) => a.latency - b.latency);
    return available[0].model;
}
