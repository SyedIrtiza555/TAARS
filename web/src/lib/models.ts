export type ModelCategory = 'Chat' | 'Reasoning' | 'Coding' | 'Vision' | 'Fast' | 'Local';
export type Provider = 'OpenRouter / OpenAI' | 'OpenRouter / Anthropic' | 'OpenRouter / Google' | 'OpenRouter / Groq' | 'OpenRouter / Meta' | 'OpenRouter / Mistral' | 'OpenRouter / NVIDIA' | 'OpenRouter / Qwen' | 'Local';

export interface ModelOption {
  id: string;
  name: string;
  provider: Provider;
  categories: ModelCategory[];
  bestFor: string;
  free: boolean;
  contextLength?: number;
  tags: string[];
}

export const MODEL_OPTIONS: ModelOption[] = [
  // OpenAI
  { id: 'openrouter/openai/gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'OpenRouter / OpenAI', categories: ['Chat', 'Fast'], bestFor: 'Fast chat and simple tasks', free: false, contextLength: 1047576, tags: ['chat', 'fast'] },
  { id: 'openrouter/openai/gpt-4.1', name: 'GPT-4.1', provider: 'OpenRouter / OpenAI', categories: ['Chat', 'Reasoning'], bestFor: 'Balanced reasoning', free: false, contextLength: 1047576, tags: ['chat', 'reasoning'] },
  { id: 'openrouter/openai/o3-mini', name: 'o3 Mini', provider: 'OpenRouter / OpenAI', categories: ['Reasoning', 'Coding'], bestFor: 'Deep reasoning', free: false, contextLength: 200000, tags: ['reasoning', 'coding'] },

  // Anthropic
  { id: 'openrouter/anthropic/claude-3-haiku', name: 'Claude 3 Haiku', provider: 'OpenRouter / Anthropic', categories: ['Chat', 'Fast'], bestFor: 'Quick responses', free: false, contextLength: 200000, tags: ['chat', 'fast'] },
  { id: 'openrouter/anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'OpenRouter / Anthropic', categories: ['Chat', 'Reasoning'], bestFor: 'Strong reasoning', free: false, contextLength: 200000, tags: ['chat', 'reasoning'] },
  { id: 'openrouter/anthropic/claude-opus-4', name: 'Claude Opus 4', provider: 'OpenRouter / Anthropic', categories: ['Reasoning', 'Coding'], bestFor: 'Complex analysis', free: false, contextLength: 200000, tags: ['reasoning', 'coding'] },

  // Google
  { id: 'openrouter/google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'OpenRouter / Google', categories: ['Chat', 'Fast', 'Vision'], bestFor: 'Multimodal speed', free: false, contextLength: 1000000, tags: ['multimodal', 'vision', 'fast'] },
  { id: 'openrouter/google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'OpenRouter / Google', categories: ['Reasoning', 'Vision'], bestFor: 'Deep reasoning with vision', free: false, contextLength: 1000000, tags: ['vision', 'reasoning'] },

  // Groq
  { id: 'openrouter/groq/llama-3.3-70b-versatile', name: 'Llama 3.3 70B (Groq)', provider: 'OpenRouter / Groq', categories: ['Chat', 'Reasoning'], bestFor: 'Fast large model', free: true, contextLength: 128000, tags: ['free', 'chat', 'fast'] },
  { id: 'openrouter/groq/mixtral-8x7b-32768', name: 'Mixtral 8x7B (Groq)', provider: 'OpenRouter / Groq', categories: ['Chat'], bestFor: 'Balanced chat', free: true, contextLength: 32768, tags: ['free', 'chat'] },
  { id: 'openrouter/groq/gemma2-9b-it', name: 'Gemma 2 9B (Groq)', provider: 'OpenRouter / Groq', categories: ['Chat', 'Fast'], bestFor: 'Lightweight', free: true, contextLength: 8192, tags: ['free', 'chat', 'fast'] },

  // Meta
  { id: 'openrouter/meta-llama/llama-3.1-8b-instruct:free', name: 'Llama 3.1 8B (Free)', provider: 'OpenRouter / Meta', categories: ['Chat', 'Local'], bestFor: 'Local-friendly small chat', free: true, contextLength: 128000, tags: ['free', 'local', 'chat'] },

  // NVIDIA
  { id: 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano (Free)', provider: 'OpenRouter / NVIDIA', categories: ['Reasoning', 'Vision'], bestFor: 'Reasoning with vision', free: true, contextLength: 128000, tags: ['free', 'reasoning', 'vision'] },

  // Qwen (local / free)
  { id: 'openrouter/qwen/qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B', provider: 'OpenRouter / Qwen', categories: ['Coding', 'Local'], bestFor: 'Local code assistant', free: true, contextLength: 32768, tags: ['free', 'coding', 'local'] },
];

export function getFreeModels(): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.free);
}

export function getModelsByCategory(category: ModelCategory): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.categories.includes(category));
}

export function getModelsByProvider(provider: Provider): ModelOption[] {
  return MODEL_OPTIONS.filter((m) => m.provider === provider);
}
