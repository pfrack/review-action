import { getSweBenchScore } from './bench-reorder.js';
import type { OpenAIClient } from './openai-client.js';

export type Provider = 'nim' | 'mistral' | 'groq' | 'openrouter' | 'kilocode' | 'custom';

export interface TaggedModel {
  id: string;
  provider: Provider;
}

export interface ChainOptions {
  nimModels: string[];
  mistralModels: string[];
  groqModels?: string[];
  hasNimKey: boolean;
  hasMistralKey: boolean;
  hasGroqKey?: boolean;
  openrouterModels?: string[];
  hasOpenRouterKey?: boolean;
  kiloModels?: string[];
  hasKiloKey?: boolean;
  customModel?: string;
  hasCustomConfig?: boolean;
  customModels?: string[];
  hasCustomModels?: boolean;
}

/**
 * Build the model fallback chain.
 *
 * Custom models (no SWE-bench score) are always first — never sorted
 * alongside provider models.
 *
 * Provider models (NIM, Mistral, Groq, OpenRouter, Kilo) are combined
 * and sorted by SWE-bench score descending as the fallback chain.
 *
 * Free-tier models (IDs ending with :free) are forced to rank last within
 * the provider group, after all non-free models.
 *
 * Only includes models whose provider key is available.
 */
export function buildCombinedChain(opts: ChainOptions): TaggedModel[] {
  const providerModels: TaggedModel[] = [];
  const { groqModels = [], hasGroqKey = false, openrouterModels = [], hasOpenRouterKey = false, kiloModels = [], hasKiloKey = false } = opts;

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

  if (hasOpenRouterKey) {
    for (const id of openrouterModels) {
      providerModels.push({ id, provider: 'openrouter' });
    }
  }

  if (hasKiloKey) {
    for (const id of kiloModels) {
      providerModels.push({ id, provider: 'kilocode' });
    }
  }

  providerModels.sort((a, b) => {
    const scoreA = getSweBenchScore(a.id);
    const scoreB = getSweBenchScore(b.id);
    return scoreB - scoreA;
  });

  const nonFree = providerModels.filter(m => !m.id.endsWith(':free'));
  const free = providerModels.filter(m => m.id.endsWith(':free'));

  const sortedProviderModels = [...nonFree, ...free];

  const customModels: TaggedModel[] = [];
  if (opts.hasCustomModels && opts.customModels) {
    for (const id of opts.customModels) {
      customModels.push({ id, provider: 'custom' });
    }
  }
  if (opts.customModel && opts.hasCustomConfig) {
    customModels.push({ id: opts.customModel, provider: 'custom' });
  }

  return [...customModels, ...sortedProviderModels];
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CONCURRENCY = 3;

export async function probeModels(
  chain: TaggedModel[],
  clients: Record<Provider, OpenAIClient | null>,
): Promise<TaggedModel | null> {
  const available: { model: TaggedModel; latency: number }[] = [];

  for (let i = 0; i < chain.length; i += PROBE_CONCURRENCY) {
    const batch = chain.slice(i, i + PROBE_CONCURRENCY);
    const probes = batch.map(async (tagged) => {
      const client = clients[tagged.provider];
      if (!client) return null;
      let timer: NodeJS.Timeout | undefined;
      try {
        const start = Date.now();
        const ok = await Promise.race([
          client.probeModel(tagged.id),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS);
          }),
        ]);
        if (ok) return { model: tagged, latency: Date.now() - start };
        return null;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    const results = await Promise.all(probes);
    for (const r of results) {
      if (r !== null) available.push(r);
    }
  }

  if (available.length === 0) return null;
  available.sort((a, b) => a.latency - b.latency);
  return available[0].model;
}
