import { getSweBenchScore } from './bench-reorder.js';
import type { OpenAIClient } from './openai-client.js';

export type Provider = 'nim' | 'mistral' | 'groq' | 'openrouter' | 'kilocode' | 'custom';

// Maximum SWE-bench score gap (head - fastest) for which a probed-fast
// model is allowed to take over the head. With head=0.806 (deepseek-v4-pro)
// and fastest=0.776 (mistral-medium-3.5) the gap is 0.030 > 0.02 → no promote.
// With head=0.806 and fastest=0.790 (deepseek-v4-flash) the gap is 0.016
// < 0.02 → still no promote (preserves the higher-SWE head). The margin
// exists only to absorb rounding/fluctuation, not real score differences.
export const PROBE_PROMOTE_MAX_HEAD_GAP = 0.02;

export interface TaggedModel {
  id: string;
  provider: Provider;
  /**
   * Optional SWE-bench score override for this model. Used by the
   * probe-based chain reorder cap. When the user has set a score for
   * their custom model via `custom_swe_score`, that value is attached
   * here so `probeModels` can apply the same cap mechanism to custom
   * heads as it does to provider heads.
   */
  scoreOverride?: number;
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
  /**
   * SWE-bench score assigned to the user's custom model(s). Default 0.5.
   * With 0.5, any non-custom model with score ≥ 0.5 can still leapfrog
   * the custom head via the probe — the cap (0.02) only protects a
   * higher-scored head. Users who want their custom head always first
   * must set this to a value above their worst provider model.
   */
  customSweScore?: number;
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

  const customSweScore = opts.customSweScore ?? 0.5;
  const customModels: TaggedModel[] = [];
  if (opts.hasCustomModels && opts.customModels) {
    for (const id of opts.customModels) {
      customModels.push({ id, provider: 'custom', scoreOverride: customSweScore });
    }
  }
  if (opts.customModel && opts.hasCustomConfig) {
    customModels.push({ id: opts.customModel, provider: 'custom', scoreOverride: customSweScore });
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

  // Cap the promotion: a lower-SWE model that happens to answer the probe
  // faster must not be allowed to leapfrog a higher-SWE chain head. The
  // head is already the best model the user has configured by score; probe
  // latency is at best a tiebreaker. If the head probed successfully it
  // already appears in `available`; if it didn't, the chain still tries
  // it first (per the runModelChainForBatch loop) and falls through on
  // failure, so a wrong promotion here can only hurt quality.
  //
  // For custom models the user-supplied `custom_swe_score` (default 0.5)
  // is the effective head score. With the default 0.5, a faster provider
  // model with score >= 0.5 will pass the cap and be promoted — set
  // `custom_swe_score` above the worst provider model to fully protect
  // the custom head.
  if (chain.length > 0) {
    const head = chain[0];
    const headScore = head.scoreOverride ?? getSweBenchScore(head.id);
    const fastest = available[0];
    const fastestScore = fastest.model.scoreOverride ?? getSweBenchScore(fastest.model.id);
    if (fastestScore < headScore - PROBE_PROMOTE_MAX_HEAD_GAP) {
      return null;
    }
  }

  return available[0].model;
}
