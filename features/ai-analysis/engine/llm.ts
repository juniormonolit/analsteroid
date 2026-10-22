// Клиент Cloud.ru Evolution Foundation Models (OpenAI-совместимый chat/completions, данные в РФ).
// Ключ — CLOUDRU_FM_API_KEY (на проде — в start.sh: прод не читает .env.local).
//
// Только потоковый режим: модель «думает» 4–13 минут до первого слова ответа, а без стрима
// встроенный fetch Node рвёт соединение на 5-минутном таймауте заголовков («fetch failed», 22.10).
// Повторы — на 429/5xx/обрыв сети, с паузой; 4xx (кроме 429) — сразу ошибка.

export const CLOUDRU_BASE_URL = process.env.CLOUDRU_FM_BASE_URL ?? 'https://foundation-models.api.cloud.ru/v1';
export const DEFAULT_MODEL = 'zai-org/GLM-5.3';
export const DEFAULT_REASONING_EFFORT = 'low' as const;

/** Тариф, ₽ за 1 млн токенов. Оценка 22.10 по списанию: 106 ₽ за 5 заказчиков ≈ 21 ₽/заказчик.
 *  API цену не отдаёт — обновлять вручную при смене тарифа. */
export const PRICE_RUB_PER_M = { input: 75, cachedInput: 7.5, output: 720 };

export interface LlmUsage { promptTokens: number; cachedTokens: number; completionTokens: number; reasoningTokens: number }
export interface LlmResult { content: string; usage: LlmUsage; finishReason: string | null; model: string; costRub: number; seconds: number }
export interface LlmProgress { phase: 'thinking' | 'writing'; reasoningChars: number; contentChars: number }

export class LlmError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) { super(message); this.status = status; this.retryable = retryable; }
}

export function costRub(u: LlmUsage): number {
  const fresh = Math.max(0, u.promptTokens - u.cachedTokens);
  return Math.round(((fresh * PRICE_RUB_PER_M.input + u.cachedTokens * PRICE_RUB_PER_M.cachedInput + u.completionTokens * PRICE_RUB_PER_M.output) / 1e6) * 100) / 100;
}

interface ChatInput {
  model?: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** GLM-5.3 принимает только low | high | max (medium — 400). low — почти без «размышлений»: замер 22.10 на
   *  «Алтае» — 51 с и ~4 ₽ против 4+ мин и ~15 ₽ по умолчанию, качество отчёта то же. */
  reasoningEffort?: 'low' | 'high' | 'max';
  onProgress?: (p: LlmProgress) => void;
  signal?: AbortSignal;
}

async function once(input: ChatInput): Promise<LlmResult> {
  const key = process.env.CLOUDRU_FM_API_KEY;
  if (!key) throw new LlmError('CLOUDRU_FM_API_KEY не задан', null, false);
  const model = input.model ?? DEFAULT_MODEL;
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${CLOUDRU_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: input.signal ?? AbortSignal.timeout(30 * 60_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, stream: true, stream_options: { include_usage: true },
        max_tokens: input.maxTokens ?? 32_000, temperature: input.temperature ?? 0.2,
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
      }),
    });
  } catch (e) {
    throw new LlmError(`Сеть: ${e instanceof Error ? e.message : String(e)}`, null, true);
  }
  if (!res.ok || !res.body) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    // «Not enough money» Cloud.ru отдаёт текстом — повторять бессмысленно.
    throw new LlmError(`Cloud.ru ${res.status}: ${body}`, res.status, res.status === 429 || res.status >= 500);
  }

  let content = '', reasoningChars = 0, finishReason: string | null = null, buf = '';
  let usage: LlmUsage = { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 };
  let lastTick = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: {
          choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };
        };
        try { ev = JSON.parse(payload); } catch { continue; }
        const ch = ev.choices?.[0];
        if (ch?.delta?.content) content += ch.delta.content;
        if (ch?.delta?.reasoning_content) reasoningChars += ch.delta.reasoning_content.length;
        if (ch?.finish_reason) finishReason = ch.finish_reason;
        if (ev.usage) usage = {
          promptTokens: ev.usage.prompt_tokens ?? 0,
          cachedTokens: ev.usage.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: ev.usage.completion_tokens ?? 0,
          reasoningTokens: ev.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        };
        if (input.onProgress && Date.now() - lastTick > 2000) {
          lastTick = Date.now();
          input.onProgress({ phase: content ? 'writing' : 'thinking', reasoningChars, contentChars: content.length });
        }
      }
    }
  } catch (e) {
    throw new LlmError(`Обрыв потока: ${e instanceof Error ? e.message : String(e)}`, null, true);
  }
  if (!content.trim()) throw new LlmError(`Пустой ответ модели (finish_reason=${finishReason ?? '—'})`, null, true);
  return { content, usage, finishReason, model, costRub: costRub(usage), seconds: Math.round((Date.now() - t0) / 1000) };
}

/** Запрос с повторами: до 3 попыток, паузы 20 с / 60 с. */
export async function chat(input: ChatInput): Promise<LlmResult> {
  const pauses = [20_000, 60_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await once(input);
    } catch (e) {
      if (!(e instanceof LlmError) || !e.retryable || attempt >= pauses.length) throw e;
      await new Promise(r => setTimeout(r, pauses[attempt]));
    }
  }
}
