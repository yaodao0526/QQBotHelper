import { getSettings } from './config.js';
import { visionEndpointInfo } from './vision.js';

export function llmReady() {
  const s = getSettings();
  return Boolean(String(s.api_key).trim() && String(s.api_base).trim() && String(s.model).trim());
}

function endpoint(base) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (/\/(chat\/completions)$/.test(b)) return b;
  return `${b}/chat/completions`;
}

/**
 * 调用 OpenAI 兼容的 /chat/completions 接口（DeepSeek / 各类中转站均适用）。
 * @returns {Promise<{content: string, usage: object|null, model: string}>}
 */
export async function chat(messages, opts = {}) {
  const s = getSettings();
  const v = opts.vision ? visionEndpointInfo() : null;
  const useVision = Boolean(v && v.model && v.key && v.base);
  if (!useVision && !llmReady()) throw new Error('尚未配置模型 API（请在「设置」里填写 API Key / Base URL / 模型名）');

  const body = {
    model: opts.model || (useVision ? v.model : s.model),
    messages,
    temperature: opts.temperature ?? s.temperature,
    max_tokens: opts.maxTokens ?? s.max_tokens,
    stream: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? s.request_timeout_ms);

  let res;
  try {
    res = await fetch(endpoint(s.api_base), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${useVision ? v.key : s.api_key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') throw new Error(`模型请求超时（${body.max_tokens} tokens 上限 / ${s.request_timeout_ms}ms）`);
    throw new Error(`模型请求失败：${err?.cause?.message || err?.message || err}`);
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || detail;
    } catch {
      /* keep raw */
    }
    throw new Error(`模型接口 ${res.status}：${detail}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`模型返回了非 JSON 内容：${text.slice(0, 200)}`);
  }

  const content = data?.choices?.[0]?.message?.content ?? '';
  if (!String(content).trim()) throw new Error('模型返回了空内容');
  return { content: String(content), usage: data.usage ?? null, model: data.model || body.model };
}

/** 面板里的「测试连接」用，返回一段短回复 */
export async function testLLM() {
  const started = Date.now();
  const out = await chat(
    [
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '只回复四个字：连接成功' },
    ],
    { maxTokens: 32, temperature: 0 }
  );
  return { reply: out.content.trim(), ms: Date.now() - started, model: out.model };
}
