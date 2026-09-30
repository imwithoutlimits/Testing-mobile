import { config } from '../config.ts';

export interface AiProvider {
  id: string;
  model: string;
  complete(system: string, user: string, opts?: { maxTokens?: number }): Promise<string>;
}

const anthropic: AiProvider = {
  id: 'anthropic',
  get model() { return config.ai.model; },
  async complete(system, user, opts = {}) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.ai.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.ai.model, max_tokens: opts.maxTokens ?? 1500, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`AI provider returned ${res.status}`);
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  },
};

/** OpenAI, Ollama (/v1), LM Studio and any other server with a chat-completions endpoint. */
const openaiCompatible: AiProvider = {
  id: 'openai-compatible',
  get model() { return config.ai.model; },
  async complete(system, user, opts = {}) {
    const res = await fetch(`${config.ai.base || 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(config.ai.key ? { Authorization: `Bearer ${config.ai.key}` } : {}) },
      body: JSON.stringify({ model: config.ai.model, max_tokens: opts.maxTokens ?? 1500, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`AI provider returned ${res.status}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  },
};

/** Returns null when no provider is configured, so AI features switch off cleanly. */
export function getAiProvider(): AiProvider | null {
  if (config.ai.provider === 'anthropic') return config.ai.key ? anthropic : null;
  if (config.ai.provider === 'openai-compatible') return config.ai.key || config.ai.base ? openaiCompatible : null;
  return null;
}

export function parseJson<T>(raw: string): T | null {
  const s = raw.replace(/```(?:json)?/gi, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)) as T; } catch { return null; }
}
