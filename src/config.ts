import * as core from '@actions/core';

export interface Config {
  baseURL: string;
  apiKey: string;
  models: string[];
  mistralApiKey: string;
  mistralBaseUrl: string;
  mistralModels: string[];
  groqApiKey: string;
  groqModels: string[];
  groqBaseUrl: string;
  openRouterApiKey: string;
  openRouterBaseUrl: string;
  openRouterModels: string[];
  openRouterFreeOnly: boolean;
  kiloApiKey: string;
  kiloBaseUrl: string;
  kiloModels: string[];
  kiloFreeOnly: boolean;
  customApiUrl: string;
  customModel: string;
  customApiKey: string;
  customModels: string[];
  customModelsBaseUrl: string;
  maxFiles: number;
  excludePatterns: string[];
  systemPrompt: string;
  promptMode: 'append' | 'replace';
  customRules: string;
  revalidateFindings: boolean;
}

export function splitCSV(s: string): string[] {
  return s.split(',').map(item => item.trim()).filter(item => item !== '');
}

export function loadConfig(): Config {
  const rawPromptMode = core.getInput('nim_prompt_mode') || 'append';
  if (rawPromptMode !== 'append' && rawPromptMode !== 'replace') {
    core.warning(`Invalid nim_prompt_mode "${rawPromptMode}", defaulting to "append"`);
  }
  const promptMode: 'append' | 'replace' = rawPromptMode === 'replace' ? 'replace' : 'append';
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
      'openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile'),
    groqBaseUrl: core.getInput('groq_base_url') || 'https://api.groq.com/openai/v1',
    openRouterApiKey: core.getInput('openrouter_api_key') || '',
    openRouterBaseUrl: core.getInput('openrouter_base_url') || 'https://openrouter.ai/api/v1',
    openRouterModels: filterFreeOnly(splitCSV(core.getInput('openrouter_models') ||
      'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick:free,google/gemini-2.0-flash-exp:free'),
      core.getInput('openrouter_free_only') === 'true', 'OpenRouter'),
    openRouterFreeOnly: core.getInput('openrouter_free_only') === 'true',
    kiloApiKey: core.getInput('kilocode_api_key') || '',
    kiloBaseUrl: core.getInput('kilocode_base_url') || 'https://api.kilo.ai/api/gateway',
    kiloModels: filterFreeOnly(splitCSV(core.getInput('kilocode_models') ||
      'kilo-auto/balanced:free,kilo-auto/frontier:free'),
      core.getInput('kilocode_free_only') === 'true', 'Kilo'),
    kiloFreeOnly: core.getInput('kilocode_free_only') === 'true',
    customApiUrl: core.getInput('custom_api_url') || '',
    customModel: core.getInput('custom_model') || '',
    customApiKey: core.getInput('custom_api_key') || '',
    customModels: splitCSV(core.getInput('custom_models') || ''),
    customModelsBaseUrl: core.getInput('custom_models_base_url') || core.getInput('custom_api_url') || '',
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

export function filterFreeOnly(models: string[], enabled: boolean, providerLabel: string): string[] {
  if (!enabled) return models;
  const free = models.filter(m => m.endsWith(':free'));
  const dropped = models.length - free.length;
  if (dropped > 0) {
    core.info(`${providerLabel}: filtered out ${dropped} non-free model(s), keeping ${free.length} free-tier model(s)`);
  }
  return free;
}
