import * as core from '@actions/core';
export function splitCSV(s) {
    return s.split(',').map(item => item.trim()).filter(item => item !== '');
}
export function loadConfig() {
    const rawPromptMode = core.getInput('nim_prompt_mode') || 'append';
    if (rawPromptMode !== 'append' && rawPromptMode !== 'replace') {
        core.warning(`Invalid nim_prompt_mode "${rawPromptMode}", defaulting to "append"`);
    }
    const promptMode = rawPromptMode === 'replace' ? 'replace' : 'append';
    return {
        baseURL: core.getInput('nim_base_url') || 'https://integrate.api.nvidia.com/v1',
        apiKey: core.getInput('nim_api_key'),
        models: splitCSV(core.getInput('nim_models')),
        mistralApiKey: core.getInput('mistral_api_key') || '',
        mistralBaseUrl: core.getInput('mistral_base_url') || 'https://api.mistral.ai/v1',
        mistralModels: splitCSV(core.getInput('mistral_models') ||
            'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'),
        groqApiKey: core.getInput('groq_api_key') || '',
        groqModels: splitCSV(core.getInput('groq_models') ||
            'openai/gpt-oss-120b,moonshotai/kimi-k2-instruct,llama-3.3-70b-versatile'),
        groqBaseUrl: core.getInput('groq_base_url') || 'https://api.groq.com/openai/v1',
        customApiUrl: core.getInput('custom_api_url') || '',
        customModel: core.getInput('custom_model') || '',
        customApiKey: core.getInput('custom_api_key') || '',
        maxFiles: (() => {
            const raw = core.getInput('max_files') || '100';
            const parsed = Number.parseInt(raw, 10);
            if (!/^[+]?\d+$/.test(raw.trim()) || !Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
                core.warning(`Invalid max_files "${raw}", must be 1-500. Defaulting to 100.`);
                return 100;
            }
            return parsed;
        })(),
        excludePatterns: splitCSV(core.getInput('exclude_patterns') || '*.lock,*.md,*.txt,*.svg,*.png,*.sum,*.json,*.yaml,*.yml,*.toml,*.mod,*.sum,.mimocode/*,go.sum,go.mod'),
        systemPrompt: core.getInput('nim_system_prompt'),
        promptMode,
        customRules: core.getInput('custom_rules') || '',
        revalidateFindings: core.getInput('revalidate_findings') === 'true',
    };
}
