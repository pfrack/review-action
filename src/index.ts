import * as core from '@actions/core';
import { NimClient } from './nim-client.js';
import { loadConfig, fetchDiff, postComment } from './review.js';
import { loadEvent } from './event.js';

function globMatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(str);
}

function shouldExclude(filePath: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (globMatch(filePath, pat)) return true;
    if (globMatch(filePath.split('/').pop() || '', pat)) return true;
  }
  return false;
}

const BASE_SYSTEM_PROMPT = `You are an expert senior software engineer performing a code review.
Analyse the diff provided for bugs, security issues, performance problems, and style/readability concerns.
Respond in concise markdown with findings for each file. For each finding use:
- **File:** path
- **Severity:** Critical | Warning | Suggestion
- **Line (approx):** number or range
- **Issue:** short description
- **Suggestion:** how to fix

If the code looks fine, say "No issues found."`;

async function run(): Promise<void> {
  const config = loadConfig();
  if (!config.apiKey && !config.mistralApiKey) {
    throw new Error('At least one of nim_api_key or mistral_api_key is required');
  }

  const client = config.apiKey ? new NimClient(config.baseURL, config.apiKey) : null;

  const event = loadEvent();
  const prNumber = event.pull_request.number;

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY not set');
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN not set');
  }

  core.info(`Reviewing PR #${prNumber} in ${repo}`);

  const filesDiff = await fetchDiff(repo, prNumber, token);

  if (Object.keys(filesDiff).length === 0) {
    const msg = '### AI Code Review\n\nNo reviewable files found in this PR (all excluded).';
    await postComment(repo, prNumber, token, msg);
    return;
  }

  // Filter files
  const filenames = Object.keys(filesDiff).sort();
  const reviewableFiles: string[] = [];

  for (const filePath of filenames) {
    if (!shouldExclude(filePath, config.excludePatterns)) {
      reviewableFiles.push(filePath);
    }
  }

  if (reviewableFiles.length === 0) {
    const msg = '### AI Code Review\n\nNo reviewable files found in this PR (all excluded).';
    await postComment(repo, prNumber, token, msg);
    return;
  }

  // Truncate if too many files
  const filesToReview = reviewableFiles.slice(0, config.maxFiles);
  const truncated = reviewableFiles.length > config.maxFiles;

  core.info(`Reviewing ${filesToReview.length} files...`);

  // Build combined diff
  let diffToSend = '';
  for (const filePath of filesToReview) {
    diffToSend += `\n--- ${filePath} ---\n${filesDiff[filePath]}\n`;
  }

  const userMsg = `Review the following code changes:\n\n\`\`\`diff\n${diffToSend}\n\`\`\``;

  // Try models in order, stop at first success
  let review = '';
  let usedModel = '';
  if (client) {
    for (const model of config.models) {
      try {
        core.info(`Trying ${model}...`);
        const result = await client.chat(model, [
          { role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ], { temperature: 0.2, maxTokens: 4096 });

        if (result.content && result.content.trim()) {
          review = result.content;
          usedModel = model;
          core.info(`Done with ${model}`);
          break;
        }
        core.info(`${model} returned empty, trying next...`);
      } catch (err) {
        core.info(`${model} failed: ${err}`);
      }
    }
  }

  if (!review) {
    review = 'No review content returned from any model.';
  }

  const modelShort = usedModel.split('/').pop() || usedModel;
  const sections: string[] = [`### AI Code Review\n\n<sub>Model: ${modelShort}</sub>\n`];
  sections.push(`\n${review}`);

  if (truncated) {
    sections.push(`\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`);
  }

  await postComment(repo, prNumber, token, sections.join('\n'));
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
