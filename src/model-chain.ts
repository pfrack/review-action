import { getSweBenchScore } from './bench-reorder.js';

export type Provider = 'nim' | 'mistral' | 'custom';

export interface TaggedModel {
  id: string;
  provider: Provider;
}

/**
 * Build a combined fallback chain from NIM and Mistral model lists,
 * sorted by SWE-bench score descending. Only includes models whose
 * provider key is available.
 *
 * Stable sort — preserves original order within same score.
 */
export function buildCombinedChain(
  nimModels: string[],
  mistralModels: string[],
  hasNimKey: boolean,
  hasMistralKey: boolean,
  customModel?: string,
  hasCustomKey?: boolean,
): TaggedModel[] {
  const chain: TaggedModel[] = [];

  if (hasNimKey) {
    for (const id of nimModels) {
      chain.push({ id, provider: 'nim' });
    }
  }

  if (hasMistralKey) {
    for (const id of mistralModels) {
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
  if (customModel && hasCustomKey) {
    chain.unshift({ id: customModel, provider: 'custom' });
  }

  return chain;
}
