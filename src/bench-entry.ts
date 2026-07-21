import { appendFileSync, readFileSync } from 'node:fs';
import { OpenAIClient } from './openai-client.js';
import { runBenchmark, formatMarkdownTable, type BenchmarkResult } from './bench.js';
import { SWE_BENCH_SCORES, fetchSweBenchScores, getSweBenchScore, type SweBenchEntry } from './bench-reorder.js';
import { readRemovedModels, writeRemovedModels, appendRemovedModels, cleanupRemovedModels } from './removed-models.js';

function envOrDefault(key: string, def: string): string {
  return process.env[key] || def;
}

function splitCSV(s: string): string[] {
  return s.split(',').map(item => item.trim()).filter(item => item !== '');
}

const SYNTHETIC_REVIEW_PROMPT = `You are reviewing a code change. Analyze the following diff for bugs, security issues, and performance problems. Respond in concise markdown with findings.

\`\`\`diff
func processOrder(items []Item, discount float64) Order {
    total := 0.0
    for _, item := range items {
        total += item.Price * float64(item.Quantity)
    }
    total = total * (1 - discount)
    tax := total * 0.08
    return Order{
        Items: items,
        Subtotal: total,
        Tax: tax,
        Total: total + tax,
    }
}
\`\`\``;

const TARGET_COUNT = 7;

/**
 * Read current models from action.yml
 */
function readCurrentModels(actionPath: string): string[] {
  const content = readFileSync(actionPath, 'utf-8');
  const match = content.match(/nim_models:\n\s+description:[^\n]*\n\s+default:\s*'([^']*)'/);
  if (!match) return [];
  return splitCSV(match[1]);
}

/**
 * Get SWE-bench ranked candidates not already in the active list
 */
function getReplacements(activeModels: string[]): string[] {
  const activeSet = new Set(activeModels);
  return Object.entries(SWE_BENCH_SCORES)
    .filter(([model]) => !activeSet.has(model))
    .sort((a, b) => b[1] - a[1])
    .map(([model]) => model);
}

/**
 * Use an LLM to match a NIM model ID to a SWE-bench score.
 * Returns the matched score or null if no match found.
 */
export async function matchModelScore(
  client: OpenAIClient,
  nimModelId: string,
  leaderboard: SweBenchEntry[],
  matcherModel: string,
): Promise<number | null> {
  const topModels = leaderboard.slice(0, 30).map(e => `"${e.modelId}": ${e.score}`);
  const prompt = `Given these SWE-bench Verified scores:\n${topModels.join('\n')}\n\nWhat is the score for NIM model '${nimModelId}'? Return just the numeric score (e.g. 0.75) or "none" if no match.`;

  try {
    const result = await client.chat(matcherModel, [
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 16 });

    const text = result.content.trim().toLowerCase();
    if (text === 'none' || text === 'n/a') return null;
    const score = parseFloat(text);
    if (isNaN(score) || score < 0 || score > 1) return null;
    return score;
  } catch {
    return null;
  }
}

async function probe(baseURL: string, apiKey: string, models: string[]): Promise<void> {
  const client = new OpenAIClient(baseURL, apiKey);

  for (const model of models) {
    process.stderr.write(`  ${model} ...`);
    const ok = await client.probeModel(model);
    if (ok) {
      process.stderr.write(' ok\n');
      console.log(`${model} ok`);
    } else {
      process.stderr.write(' FAIL\n');
      console.log(`${model} FAIL`);
    }
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.NIM_API_KEY;
  if (!apiKey) {
    throw new Error('NIM_API_KEY is required');
  }

  const baseURL = envOrDefault('NIM_BASE_URL', 'https://integrate.api.nvidia.com/v1');
  const actionPath = envOrDefault('ACTION_PATH', 'action.yml');
  const client = new OpenAIClient(baseURL, apiKey);

  // Fetch provider catalog to distinguish transient vs permanent failures
  let availableModels: Set<string> | null = null;
  try {
    const models = await client.listModels();
    availableModels = new Set(models);
    process.stderr.write(`Provider has ${models.length} models available\n`);
    // Clean up permanently removed models from removed-models.txt
    cleanupRemovedModels(availableModels);
  } catch (err) {
    process.stderr.write(`Warning: could not fetch model list: ${err}\n`);
  }

  // Determine models to benchmark
  let models: string[];
  const modelsEnv = process.env.NIM_MODELS;
  if (modelsEnv) {
    models = splitCSV(modelsEnv);
  } else {
    // Read current top from action.yml
    models = readCurrentModels(actionPath);
    if (models.length === 0) {
      // First run — seed from SWE-bench top models
      models = Object.entries(SWE_BENCH_SCORES)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TARGET_COUNT)
        .map(([model]) => model);
      process.stderr.write(`First run — seeding with top ${TARGET_COUNT} SWE-bench models\n`);
    } else {
      process.stderr.write(`Benchmarking current ${models.length} models from action.yml\n`);
    }
  }

  // Discover new models and fetch SWE-bench scores
  const fetchedScores = new Map<string, number>();
  const discoveredModels: string[] = [];
  if (availableModels) {
    const knownModels = new Set([...Object.keys(SWE_BENCH_SCORES), ...models]);
    const newModels = [...availableModels].filter(m => !knownModels.has(m));

    if (newModels.length > 0) {
      process.stderr.write(`\nDiscovered ${newModels.length} new model(s) not in SWE-bench table\n`);
      const leaderboard = await fetchSweBenchScores();

      if (leaderboard.length > 0) {
        // Use the first model from the active list as the matcher
        const matcherModel = models[0];
        if (matcherModel) {
          for (const nimModel of newModels.slice(0, 5)) {
            process.stderr.write(`  Matching ${nimModel} ...`);
            const score = await matchModelScore(client, nimModel, leaderboard, matcherModel);
            if (score !== null) {
              process.stderr.write(` score=${score}\n`);
              fetchedScores.set(nimModel, score);
              discoveredModels.push(nimModel);
            } else {
              process.stderr.write(' no match\n');
            }
          }
        }
      }
    }
  }

  // Add discovered models to the benchmark list
  if (discoveredModels.length > 0) {
    models = [...models, ...discoveredModels];
  }

  // --probe mode
  if (process.argv.includes('--probe')) {
    await probe(baseURL, apiKey, models);
    return;
  }

  let iterations = 2;
  const iterEnv = process.env.NIM_BENCH_ITERATIONS;
  if (iterEnv) {
    const n = parseInt(iterEnv, 10);
    if (isNaN(n)) throw new Error('NIM_BENCH_ITERATIONS must be an integer');
    iterations = n;
  }

  const benchPrompt = envOrDefault('NIM_BENCH_PROMPT', SYNTHETIC_REVIEW_PROMPT);

  process.stderr.write(`\nBenchmarking ${models.length} models with ${iterations} iterations...\n\n`);

  // Benchmark current models
  const results: BenchmarkResult[] = [];
  const failed: string[] = [];

  for (const model of models) {
    process.stderr.write(`  ${model} ...`);
    const start = Date.now();

    const result = await runBenchmark(client, model, {
      prompt: benchPrompt,
      iterations,
      temperature: 0.2,
      maxTokens: 1024,
    });

    const elapsed = Date.now() - start;
    const errCount = result.iterations.filter(it => it.error !== null).length;
    const allFailed = errCount === iterations;

    if (allFailed) {
      process.stderr.write(` FAILED (${Math.round(elapsed / 1000)}s)\n`);
      failed.push(model);
    } else {
      process.stderr.write(` done in ${Math.round(elapsed / 1000)}s (${errCount} errors)\n`);
    }

    results.push(result);
  }

  // Replace failed models with next best from SWE-bench
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} model(s) failed. Finding replacements...\n`);
    const replacements = getReplacements(models);

    for (const deadModel of failed) {
      let replaced = false;
      for (const candidate of replacements) {
        if (models.includes(candidate)) continue;

        process.stderr.write(`  Probing ${candidate} ...`);
        const ok = await client.probeModel(candidate);
        if (!ok) {
          process.stderr.write(' FAIL, skipping\n');
          continue;
        }
        process.stderr.write(' ok, benchmarking...');

        const result = await runBenchmark(client, candidate, {
          prompt: benchPrompt,
          iterations,
          temperature: 0.2,
          maxTokens: 1024,
        });

        const errCount = result.iterations.filter(it => it.error !== null).length;
        if (errCount === iterations) {
          process.stderr.write(' FAILED\n');
          continue;
        }

        process.stderr.write(` done (replacing ${deadModel})\n`);
        results.push(result);
        // Replace in models list
        const idx = models.indexOf(deadModel);
        models[idx] = candidate;
        replaced = true;
        break;
      }

      if (!replaced) {
        process.stderr.write(`  No replacement found for ${deadModel}\n`);
      }
    }
  }

  // Classify failures and persist transient ones for retry
  const transientFailed: string[] = [];
  if (failed.length > 0) {
    for (const model of failed) {
      if (availableModels && !availableModels.has(model)) {
        process.stderr.write(`  ${model}: permanently removed from provider (not retried)\n`);
      } else {
        process.stderr.write(`  ${model}: transient failure (will retry next run)\n`);
        transientFailed.push(model);
      }
    }
    if (transientFailed.length > 0) {
      appendRemovedModels(transientFailed);
    }
  }

  // Recheck previously removed models
  const removedModels = readRemovedModels();
  if (removedModels.length > 0) {
    process.stderr.write(`\nRechecking ${removedModels.length} previously removed model(s)...\n`);
    const recovered: string[] = [];
    const stillFailed: string[] = [];

    for (const model of removedModels) {
      process.stderr.write(`  Probing ${model} ...`);
      const ok = await client.probeModel(model);
      if (!ok) {
        process.stderr.write(' still down\n');
        stillFailed.push(model);
        continue;
      }
      process.stderr.write(' back! benchmarking...');

      const result = await runBenchmark(client, model, {
        prompt: benchPrompt,
        iterations,
        temperature: 0.2,
        maxTokens: 1024,
      });

      const errCount = result.iterations.filter(it => it.error !== null).length;
      if (errCount === iterations) {
        process.stderr.write(' FAILED\n');
        stillFailed.push(model);
        continue;
      }

      process.stderr.write(' ok\n');
      recovered.push(model);
      results.push(result);
    }

    // Update removed-models.txt: keep only models that still failed,
    // plus any new transient failures from this run
    stillFailed.push(...transientFailed);
    writeRemovedModels(stillFailed);
    if (recovered.length > 0) {
      process.stderr.write(`  Recovered ${recovered.length} model(s): ${recovered.join(', ')}\n`);
    }
  }

  // Output results table
  const successResults = results.filter(r => {
    const errCount = r.iterations.filter(it => it.error !== null).length;
    return errCount < r.iterations.length;
  });

  const table = formatMarkdownTable(successResults);
  // Output fetched scores as a JSON comment for bench-reorder.ts to consume
  if (fetchedScores.size > 0) {
    const scoresObj: Record<string, number> = {};
    fetchedScores.forEach((v, k) => { scoresObj[k] = v; });
    console.log(`<!-- FETCHED_SCORES: ${JSON.stringify(scoresObj)} -->`);
  }
  console.log(table);

  // Write to GITHUB_STEP_SUMMARY if set
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      appendFileSync(summaryPath, `\n## NIM Model Benchmark\n\n${table}\n`);
    } catch (err) {
      process.stderr.write(`Warning: could not open GITHUB_STEP_SUMMARY: ${err}\n`);
    }
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
