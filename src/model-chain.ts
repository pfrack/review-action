import { getSweBenchScore } from './bench-reorder.js';
import type { OpenAIClient } from './openai-client.js';

export type Provider = 'nim' | 'mistral' | 'custom';

export interface TaggedModel {
  id: string;
  provider: Provider;
}

export interface ChainOptions {
  nimModels: string[];
  mistralModels: string[];
  hasNimKey: boolean;
  hasMistralKey: boolean;
  customModel?: string;
  hasCustomConfig?: boolean;
}

/**
 * Build a combined fallback chain from NIM and Mistral model lists,
 * sorted by SWE-bench score descending. Only includes models whose
 * provider key is available.
 *
 * Stable sort — preserves original order within same score.
 */
export function buildCombinedChain(opts: ChainOptions): TaggedModel[] {
  const chain: TaggedModel[] = [];

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

const PROBE_TIMEOUT_MS = 10_000;

export async function probeModels(
  chain: TaggedModel[],
  clients: Record<Provider, OpenAIClient | null>,
): Promise<TaggedModel | null> {
  const probes = chain.map(async (tagged) => {
    const client = clients[tagged.provider];
    if (!client) return null;
    try {
      const start = Date.now();
      const ok = await Promise.race([
        client.probeModel(tagged.id),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS)
        ),
      ]);
      if (ok) return { model: tagged, latency: Date.now() - start };
      return null;
    } catch {
      return null;
    }
  });

  const results = await Promise.all(probes);
  const available = results.filter((r): r is { model: TaggedModel; latency: number } => r !== null);
  if (available.length === 0) return null;
  available.sort((a, b) => a.latency - b.latency);
  return available[0].model;
}
