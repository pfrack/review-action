import * as core from '@actions/core';
import { languageForTemplate } from './prompts.js';
export const BASE_SYSTEM_PROMPT = `You are an expert senior software engineer performing a code review.
Analyse the diff provided for bugs, security issues, performance problems, and style/readability concerns.
Respond in concise markdown with findings for each file. For each finding use:
- **File:** path
- **Severity:** Critical | Warning | Suggestion
- **Line (approx):** number or range
- **Issue:** short description
- **Suggestion:** how to fix

If the code looks fine, say "No issues found."`;
function splitCSV(s) {
    return s.split(',').map(item => item.trim()).filter(item => item !== '');
}
export function loadConfig() {
    return {
        baseURL: core.getInput('nim_base_url') || 'https://integrate.api.nvidia.com/v1',
        apiKey: core.getInput('nim_api_key'),
        models: splitCSV(core.getInput('nim_models')),
        mistralApiKey: core.getInput('mistral_api_key') || '',
        mistralBaseUrl: core.getInput('mistral_base_url') || 'https://api.mistral.ai/v1',
        mistralModels: splitCSV(core.getInput('mistral_models') ||
            'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'),
        customApiUrl: core.getInput('custom_api_url') || '',
        customModel: core.getInput('custom_model') || '',
        customApiKey: core.getInput('custom_api_key') || '',
        maxFiles: parseInt(core.getInput('max_files') || '100', 10) || 100,
        excludePatterns: splitCSV(core.getInput('exclude_patterns') || '*.lock,*.md,*.txt,*.svg,*.png,*.sum,*.json,*.yaml,*.yml,*.toml,*.mod,*.sum,.mimocode/*,go.sum,go.mod'),
        systemPrompt: core.getInput('nim_system_prompt'),
        promptMode: core.getInput('nim_prompt_mode') || 'append',
    };
}
const diffHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;
export function parseDiff(raw) {
    const files = {};
    const chunks = raw.split('diff --git ');
    for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed)
            continue;
        const diffText = 'diff --git ' + trimmed;
        const firstLine = diffText.split('\n')[0];
        const m = firstLine.match(diffHeaderRe);
        if (m) {
            files[m[2]] = diffText;
        }
    }
    return files;
}
function globMatch(str, pattern) {
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return regex.test(str);
}
export function shouldExclude(filePath, patterns) {
    for (const pat of patterns) {
        if (globMatch(filePath, pat))
            return true;
        if (globMatch(filePath.split('/').pop() || '', pat))
            return true;
    }
    return false;
}
export async function fetchDiff(repo, prNumber, token) {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
    const resp = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3.diff',
        },
        signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`GitHub API returned ${resp.status}: ${body}`);
    }
    const raw = await resp.text();
    return parseDiff(raw);
}
const COMMENT_MARKER = '### AI Code Review';
export async function postComment(repo, prNumber, token, body) {
    // Try to find and update an existing review comment
    const existingId = await findExistingComment(repo, prNumber, token);
    if (existingId) {
        await updateComment(repo, existingId, token, body);
    }
    else {
        await createComment(repo, prNumber, token, body);
    }
}
async function findExistingComment(repo, prNumber, token) {
    let page = 1;
    const perPage = 100;
    const maxPages = 10;
    while (page <= maxPages) {
        const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`;
        const resp = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
            },
            signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok)
            return null;
        const comments = await resp.json();
        for (const comment of comments) {
            if (comment.body.startsWith(COMMENT_MARKER)) {
                return comment.id;
            }
        }
        if (comments.length < perPage)
            break;
        page++;
    }
    return null;
}
async function updateComment(repo, commentId, token, body) {
    const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;
    const resp = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
        const respBody = await resp.text();
        throw new Error(`GitHub API returned ${resp.status}: ${respBody}`);
    }
}
async function createComment(repo, prNumber, token, body) {
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
        const respBody = await resp.text();
        throw new Error(`GitHub API returned ${resp.status}: ${respBody}`);
    }
}
export function resolveSystemPrompt(filePath, config) {
    const langTemplate = languageForTemplate(filePath);
    if (!config.systemPrompt) {
        return langTemplate || BASE_SYSTEM_PROMPT;
    }
    if (config.promptMode === 'replace') {
        return config.systemPrompt;
    }
    // append mode
    if (langTemplate) {
        return config.systemPrompt + '\n\n' + langTemplate;
    }
    return config.systemPrompt + '\n\n' + BASE_SYSTEM_PROMPT;
}
export async function reviewFile(client, filePath, diff, model, config) {
    const userMsg = `Review the following changes to \`${filePath}\`:\n\n\`\`\`diff\n${diff}\n\`\`\``;
    const sysPrompt = resolveSystemPrompt(filePath, config);
    const result = await client.chat(model, [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userMsg },
    ], { temperature: 0.2, maxTokens: 1024 });
    return result.content;
}
export async function reviewFileWithFallback(clients, filePath, diff, chain, config) {
    let lastErr = null;
    for (const tagged of chain) {
        const client = clients[tagged.provider];
        if (!client)
            continue;
        try {
            return await reviewFile(client, filePath, diff, tagged.id, config);
        }
        catch (err) {
            lastErr = err;
            console.error(`Model ${tagged.id} (${tagged.provider}) failed for ${filePath}: ${err}, trying next...`);
        }
    }
    throw new Error(`All models failed for ${filePath}: ${lastErr?.message}`);
}
