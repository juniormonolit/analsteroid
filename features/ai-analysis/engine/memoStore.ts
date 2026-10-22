// Памятка ИИ в задаче менеджера (этап 1.5): свежий отчёт заказчика → блок в описании новой задачи
// канбана повторных; открытая задача заказчика → кнопка «В открытую задачу» во вкладке.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';
import { memberKeysOf } from '@/features/customers/engine/merge';
import { fetchTasksForDeals, type RepeatTask } from '@/features/repeat-kanban/engine/tasks';
import type { ClientRef } from '@/features/client-module/engine/types';
import { clientKeys } from './collect';
import { MEMO_FRESH_DAYS, memoBbcode } from './memo';

/** Ключ канбана (c/x/k + склейка) → ClientRef карточки клиента (x — юр без компании — это контакт). */
async function refsOfClientKey(clientKey: string): Promise<string[]> {
  const keys = await memberKeysOf(clientKey).catch(() => [clientKey]);
  return [...new Set(keys.map(k => (k.startsWith('x') ? `c${k.slice(1)}` : k)))];
}

/** Свежий готовый отчёт по заказчику канбана — для описания задачи. null — нет или упало. */
export async function freshMemoForClientKey(clientKey: string): Promise<{ analysisId: number; bbcode: string } | null> {
  try {
    const refs = await refsOfClientKey(clientKey);
    const r = await systemDb().query<{ id: string; report_md: string; created_at: Date }>(
      `SELECT id, report_md, created_at FROM ai_analyses
        WHERE client_ref = ANY($1::text[]) AND status = 'done' AND report_md IS NOT NULL
          AND created_at >= now() - make_interval(days => $2)
        ORDER BY created_at DESC LIMIT 1`,
      [refs, MEMO_FRESH_DAYS],
    );
    const row = r.rows[0];
    if (!row) return null;
    return { analysisId: Number(row.id), bbcode: memoBbcode(row.report_md, new Date(row.created_at).toISOString()) };
  } catch (e) {
    console.warn('[aiAnalysis] памятка для задачи не собралась:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function markMemoInserted(analysisId: number, taskId: number): Promise<void> {
  await systemDb().query(`UPDATE ai_analyses SET task_id = $2, memo_inserted_at = now() WHERE id = $1`, [analysisId, taskId]).catch(e =>
    console.warn('[aiAnalysis] отметка памятки:', e instanceof Error ? e.message : e));
}

/** Какие анализы уже вставлены в эту задачу (описание при постановке или комментарий). */
export async function memoAlreadyInTask(taskId: number): Promise<number[]> {
  const r = await systemDb().query<{ id: string }>(`SELECT id FROM ai_analyses WHERE task_id = $1 AND memo_inserted_at IS NOT NULL`, [taskId]).catch(() => ({ rows: [] as { id: string }[] }));
  return r.rows.map(x => Number(x.id));
}

const OPEN_STATES = new Set<RepeatTask['state']>(['unread', 'pending', 'in_progress', 'control']);

/** Открытая (не завершённая, не отложенная) задача канбана по любой сделке заказчика — самая свежая. */
export async function openRepeatTask(ref: ClientRef): Promise<RepeatTask | null> {
  const keys = await clientKeys(ref);
  const deals = await analyticsDb().query<{ deal_id: number }>(
    `SELECT d.deal_id FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_CASE_SQL}) = ANY($1::text[])`,
    [keys],
  );
  const tasks = await fetchTasksForDeals(deals.rows.map(d => Number(d.deal_id)));
  return [...tasks.values()].filter(t => OPEN_STATES.has(t.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
