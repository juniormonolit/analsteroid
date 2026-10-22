// Версии системного промпта (этап 2, migrations/248 ai_prompts). Активна одна; нет активной —
// встроенный промпт из кода (prompt.ts). Правят только супер-админы через /settings/ai-analysis.
import { systemDb } from '@/lib/db/clients';
import { PROMPT_VERSION, REQUIRED_SECTIONS, systemPrompt } from './prompt';

export interface ActivePrompt { version: string; body: string; builtin: boolean }
export interface PromptVersion { id: number; version: string; note: string | null; isActive: boolean; createdBy: string; createdAt: string; body: string }

const TTL_MS = 60_000;
const g = globalThis as unknown as { __aiPromptCache?: { at: number; value: ActivePrompt } };

export const builtinPrompt = (): ActivePrompt => ({ version: PROMPT_VERSION, body: systemPrompt(), builtin: true });

export async function getActivePrompt(): Promise<ActivePrompt> {
  if (g.__aiPromptCache && Date.now() - g.__aiPromptCache.at < TTL_MS) return g.__aiPromptCache.value;
  let value = builtinPrompt();
  try {
    const r = await systemDb().query<{ id: number; body: string }>(`SELECT id, body FROM ai_prompts WHERE is_active LIMIT 1`);
    if (r.rows[0]) value = { version: `db${r.rows[0].id}`, body: r.rows[0].body, builtin: false };
  } catch (e) {
    // Таблицы ещё нет (миграция 248 не накачена) — работаем на встроенном.
    console.warn('[aiAnalysis] ai_prompts:', e instanceof Error ? e.message : e);
  }
  g.__aiPromptCache = { at: Date.now(), value };
  return value;
}

const invalidate = () => { g.__aiPromptCache = undefined; };

/** Вкладка режет отчёт по «### 1.»…«### 7.» — без этих заголовков в формате промпт ломает UI. */
export function validatePrompt(body: string): string | null {
  if (body.trim().length < 200) return 'Промпт слишком короткий';
  if (body.length > 100_000) return 'Промпт слишком длинный (больше 100 тыс. символов)';
  const missing = REQUIRED_SECTIONS.filter(s => !new RegExp(`^###\\s*${s.n}\\.`, 'm').test(body));
  if (missing.length) return `В формате отчёта нет разделов: ${missing.map(s => `«### ${s.n}. ${s.title}»`).join(', ')} — по ним вкладка разбирает отчёт`;
  return null;
}

export async function listPrompts(): Promise<PromptVersion[]> {
  const r = await systemDb().query<{ id: number; body: string; note: string | null; is_active: boolean; created_by: string; created_at: Date }>(
    `SELECT id, body, note, is_active, created_by, created_at FROM ai_prompts ORDER BY id DESC LIMIT 50`,
  );
  return r.rows.map(x => ({ id: x.id, version: `db${x.id}`, body: x.body, note: x.note, isActive: x.is_active, createdBy: x.created_by, createdAt: new Date(x.created_at).toISOString() }));
}

/** Новая версия (с включением — снимает активность с прежней одной транзакцией). */
export async function savePrompt(input: { body: string; note: string | null; by: string; activate: boolean }): Promise<number> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    if (input.activate) await client.query(`UPDATE ai_prompts SET is_active = false WHERE is_active`);
    const r = await client.query<{ id: number }>(
      `INSERT INTO ai_prompts (body, note, is_active, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.body, input.note, input.activate, input.by],
    );
    await client.query('COMMIT');
    invalidate();
    return r.rows[0].id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Включить версию; id = null — вернуть встроенный промпт из кода. */
export async function activatePrompt(id: number | null): Promise<void> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE ai_prompts SET is_active = false WHERE is_active`);
    if (id !== null) await client.query(`UPDATE ai_prompts SET is_active = true WHERE id = $1`, [id]);
    await client.query('COMMIT');
    invalidate();
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
