// Стадии проектов больших сделок (task.stages.get) → колонки общей сетки (config.ts).
// Кэш в памяти процесса на 10 мин: стадии меняют руками раз в месяцы.
import { bx } from '@/lib/bitrix/notify';
import { taskWebhook } from '@/features/repeat-kanban/engine/createDeal';
import { STAGE_TITLE_TO_COLUMN, normStageTitle, type BigColumnKey } from './config';

export interface BigStage { id: number; title: string; column: BigColumnKey | null; sort: number }

const TTL_MS = 10 * 60_000;
const cache = new Map<number, { at: number; p: Promise<BigStage[]> }>();
const warned = new Set<string>();

export function columnOfTitle(title: string): BigColumnKey | null {
  const k = normStageTitle(title);
  if (k in STAGE_TITLE_TO_COLUMN) return STAGE_TITLE_TO_COLUMN[k];
  if (!warned.has(k)) { warned.add(k); console.warn(`[big-deals] неизвестная стадия «${title}» → «Проверить» (добавь в STAGE_TITLE_TO_COLUMN)`); }
  return 'check';
}

async function fetchStages(groupId: number): Promise<BigStage[]> {
  const body = await bx(taskWebhook(), 'task.stages.get', { entityId: groupId }) as { result: Record<string, { ID: string; TITLE: string; SORT: string }> | unknown[] };
  const raw = Array.isArray(body.result) ? [] : Object.values(body.result ?? {});
  return raw
    .map(s => ({ id: Number(s.ID), title: String(s.TITLE ?? ''), column: columnOfTitle(String(s.TITLE ?? '')), sort: Number(s.SORT) || 0 }))
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
}

export async function stagesOfGroup(groupId: number): Promise<BigStage[]> {
  const hit = cache.get(groupId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = fetchStages(groupId);
  cache.set(groupId, { at: Date.now(), p });
  p.catch(() => cache.delete(groupId));
  return p;
}

/** Первая по SORT стадия проекта, сведённая в эту колонку. */
export async function stageIdForColumn(groupId: number, column: BigColumnKey): Promise<number | null> {
  const st = await stagesOfGroup(groupId);
  return st.find(s => s.column === column)?.id ?? null;
}

/** Колонка стадии задачи. STAGE_ID 0 — системная первая стадия («Новые»). null — стадия не показывается. */
export function columnOfStage(stages: BigStage[], stageId: number | string | null | undefined): { column: BigColumnKey | null; title: string; stageId: number } {
  const id = Number(stageId) || 0;
  if (id === 0) {
    const first = stages[0];
    return { column: 'new', title: first?.title ?? 'Новые', stageId: first?.id ?? 0 };
  }
  const s = stages.find(x => x.id === id);
  if (!s) return { column: 'check', title: `Стадия ${id}`, stageId: id };
  return { column: s.column, title: s.title, stageId: id };
}
