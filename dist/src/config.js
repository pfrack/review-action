import * as core from '@actions/core';
import { OpenAIClient } from './openai-client.js';
export function splitCSV(s) {
    return s.split(',').map(item => item.trim()).filter(item => item !== '');
}
export async function loadConfig() {
    const rawPromptMode = core.getInput('nim_prompt_mode') || 'append';
    if (rawPromptMode !== 'append' && rawPromptMode !== 'replace') {
        core.warning(`Invalid nim_prompt_mode "${rawPromptMode}", defaulting to "append"`);
    }
    const promptMode = rawPromptMode === 'replace' ? 'replace' : 'append';
    const config = {
        baseURL: core.getInput('nim_base_url') || 'https://integrate.api.nvidia.com/v1',
        apiKey: core.getInput('nim_api_key'),
        models: splitCSV(core.getInput('nim_models')),
        mistralApiKey: core.getInput('mistral_api_key') || '',
        mistralBaseUrl: core.getInput('mistral_base_url') || 'https://api.mistral.ai/v1',
        mistralModels: splitCSV(core.getInput('mistral_models') ||
            'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'),
        groqApiKey: core.getInput('groq_api_key') || '',
        groqModels: splitCSV(core.getInput('groq_models') ||
            'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile'),
        groqBaseUrl: core.getInput('groq_base_url') || 'https://api.groq.com/openai/v1',
        openRouterApiKey: core.getInput('openrouter_api_key') || '',
        openRouterBaseUrl: core.getInput('openrouter_base_url') || 'https://openrouter.ai/api/v1',
        openRouterModels: [],
        openRouterFreeOnly: core.getInput('openrouter_free_only') === 'true',
        kiloApiKey: core.getInput('kilocode_api_key') || '',
        kiloBaseUrl: core.getInput('kilocode_base_url') || 'https://api.kilo.ai/api/gateway',
        kiloModels: [],
        kiloFreeOnly: core.getInput('kilocode_free_only') === 'true',
        customApiUrl: core.getInput('custom_api_url') || '',
        customModel: core.getInput('custom_model') || '',
        customApiKey: core.getInput('custom_api_key') || '',
        customModels: splitCSV(core.getInput('custom_models') || ''),
        customModelsBaseUrl: core.getInput('custom_models_base_url') || core.getInput('custom_api_url') || '',
        customSweScore: (() => {
            const raw = core.getInput('custom_swe_score') || '0.5';
            const parsed = Number.parseFloat(raw);
            if (!/^[+]?(\d+(\.\d*)?|\.\d+)$/.test(raw.trim()) || Number.isNaN(parsed) || parsed < 0 || parsed > 1) {
                core.warning(`Invalid custom_swe_score "${raw}", must be 0-1. Defaulting to 0.5.`);
                return 0.5;
            }
            return parsed;
        })(),
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
        dropUnreferenced: core.getInput('drop_unreferenced') !== 'false',
        modelTimeout: (() => {
            const raw = core.getInput('model_timeout') || '90';
            const parsed = Number.parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 0) {
                core.warning(`Invalid model_timeout "${raw}", must be >= 0. Defaulting to 90.`);
                return 90;
            }
            return parsed;
        })(),
        chainTimeout: (() => {
            const raw = core.getInput('chain_timeout') || '0';
            const parsed = Number.parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 0) {
                core.warning(`Invalid chain_timeout "${raw}", must be >= 0. Defaulting to 0 (unlimited).`);
                return 0;
            }
            return parsed;
        })(),
        maxTokens: (() => {
            const raw = core.getInput('max_tokens') || '0';
            const parsed = Number.parseInt(raw, 10);
            if (raw.trim() === '0' || parsed === 0)
                return 0;
            if (Number.isNaN(parsed) || parsed < 256 || parsed > 16384) {
                core.warning(`Invalid max_tokens "${raw}", must be 256-16384. Defaulting to adaptive.`);
                return 0;
            }
            return parsed;
        })(),
        parallelAttempts: (() => {
            const raw = core.getInput('parallel_attempts') || '1';
            const parsed = Number.parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 1 || parsed > 5) {
                core.warning(`Invalid parallel_attempts "${raw}", must be 1-5. Defaulting to 1.`);
                return 1;
            }
            return parsed;
        })(),
        parallelThreshold: (() => {
            const raw = core.getInput('parallel_threshold') || '40';
            const parsed = Number.parseInt(raw, 10);
            if (Number.isNaN(parsed) || parsed < 5 || parsed > 120) {
                core.warning(`Invalid parallel_threshold "${raw}", must be 5-120. Defaulting to 40.`);
                return 40;
            }
            return parsed;
        })(),
    };
    const openRouterInput = splitCSV(core.getInput('openrouter_models'));
    if (openRouterInput.length > 0) {
        config.openRouterModels = filterFreeOnly(openRouterInput, config.openRouterFreeOnly, 'OpenRouter');
    }
    else if (config.openRouterApiKey) {
        config.openRouterModels = await fetchFreeModels(config.openRouterBaseUrl, config.openRouterApiKey, 'OpenRouter');
    }
    const kiloInput = splitCSV(core.getInput('kilocode_models'));
    if (kiloInput.length > 0) {
        config.kiloModels = filterFreeOnly(kiloInput, config.kiloFreeOnly, 'Kilo');
    }
    else if (config.kiloApiKey) {
        config.kiloModels = await fetchFreeModels(config.kiloBaseUrl, config.kiloApiKey, 'Kilo');
    }
    return config;
}
export function isFreeModel(model) {
    return model.toLowerCase().includes('free');
}
export function filterFreeOnly(models, enabled, providerLabel) {
    if (!enabled)
        return models;
    const free = models.filter(isFreeModel);
    const dropped = models.length - free.length;
    if (dropped > 0) {
        core.info(`${providerLabel}: filtered out ${dropped} non-free model(s), keeping ${free.length} free-tier model(s)`);
    }
    return free;
}
export async function fetchFreeModels(baseURL, apiKey, providerLabel) {
    try {
        const client = new OpenAIClient(baseURL, apiKey, providerLabel);
        const models = await client.listModels();
        const free = models.filter(isFreeModel);
        core.info(`${providerLabel}: fetched ${models.length} models, ${free.length} free-tier`);
        return free;
    }
    catch (err) {
        core.warning(`${providerLabel}: could not fetch model list: ${err}`);
        return [];
    }
}
