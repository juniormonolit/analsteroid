// Один анализ заказчика: сбор → обезличивание → модель → разбор отчёта и проверка цитат.
// Вызывается воркером очереди (этап 1) и скриптом паритета (scripts/ai-analysis-run.ts).
import { createHash } from 'node:crypto';
import type { ClientRef } from '@/features/client-module/engine/types';
import { collectClientData, type ClientCallData } from './collect';
import { chat, DEFAULT_REASONING_EFFORT, type LlmProgress, type LlmResult } from './llm';
import { PROMPT_VERSION, REPORT_SECTIONS, systemPrompt, userContent } from './prompt';
import { verifyQuotes, type QuoteCheck } from './verify';

export interface AnalysisOutput {
  promptVersion: string;
  callsHash: string;
  data: ClientCallData;
  maskHits: Record<string, number>;
  llm: LlmResult;
  sections: Record<string, string>;
  quotes: QuoteCheck[];
}

/** Отпечаток входа: те же звонки + та же версия промпта = тот же отчёт (дедуп повторных запусков). */
export function callsHashOf(data: ClientCallData): string {
  const h = createHash('sha256');
  h.update(PROMPT_VERSION);
  for (const c of data.calls) h.update(`${c.id}|`);
  for (const f of data.facts) h.update(f);
  return h.digest('hex').slice(0, 32);
}

/** Режет markdown по заголовкам «### N.» в разделы REPORT_SECTIONS. */
export function splitSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = md.split(/^#{2,4}\s*(\d)\.\s*[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const sec = REPORT_SECTIONS.find(s => s.n === Number(parts[i]));
    if (sec) out[sec.key] = parts[i + 1].trim();
  }
  return out;
}

export async function analyzeClient(ref: ClientRef, opts: {
  model?: string; reasoningEffort?: 'low' | 'high' | 'max';
  /** Уже собранные данные (воркер собирает сам, чтобы сначала проверить дубль по callsHash). */
  data?: ClientCallData;
  onProgress?: (p: LlmProgress | { phase: 'collecting' }) => void;
} = {}): Promise<AnalysisOutput> {
  opts.onProgress?.({ phase: 'collecting' });
  const data = opts.data ?? await collectClientData(ref);
  if (!data.calls.length) throw new Error('У заказчика нет расшифрованных звонков — анализировать нечего');
  const { text, maskHits } = userContent(data);
  const llm = await chat({ model: opts.model, reasoningEffort: opts.reasoningEffort ?? DEFAULT_REASONING_EFFORT, system: systemPrompt(), user: text, onProgress: opts.onProgress });
  return {
    promptVersion: PROMPT_VERSION,
    callsHash: callsHashOf(data),
    data, maskHits, llm,
    sections: splitSections(llm.content),
    quotes: verifyQuotes(llm.content, data.calls, data.deals),
  };
}
