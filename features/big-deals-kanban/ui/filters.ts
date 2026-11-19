// Фильтры «Канбана больших чеков»: BigFilters ⇄ query GET /api/big-deals-kanban (и аналитики),
// варианты для полей. Общие для панели «Фильтры», своих колонок и массового закрытия.
import { BIG_COLUMNS, type BigColumnKey } from '../engine/config';
import type { BigFilters, BigSort, BigTaskState } from '../engine/types';
import { STATE_META } from './format';

export const SORTS: readonly BigSort[] = ['default', 'sum', 'days', 'created', 'idle'];
export const SORT_OPTIONS: { value: BigSort; label: string }[] = [
  { value: 'default', label: 'По умолчанию' },
  { value: 'sum', label: 'Сумма — сначала крупные' },
  { value: 'days', label: 'Дольше в колонке' },
  { value: 'created', label: 'Сначала новые' },
  { value: 'idle', label: 'Дольше без изменений' },
];
export const STATE_OPTIONS = (Object.keys(STATE_META) as BigTaskState[]).map(k => ({ value: k, label: STATE_META[k].label }));
export const DEAL_OPTIONS = [
  { value: '', label: 'Любая' }, { value: 'open', label: 'В работе' },
  { value: 'won', label: 'Выиграна' }, { value: 'lost', label: 'Проиграна' },
];
export const COLUMN_OPTIONS = BIG_COLUMNS.map(c => ({ value: c.key, label: c.title }));

const num = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? String(Math.round(v)) : null);

/** BigFilters (+ сортировка) → query, ровно имена, которые читает API. */
export function filtersToParams(f: BigFilters, sort?: BigSort, p = new URLSearchParams()): URLSearchParams {
  const put = (k: string, v: string | null | undefined) => { if (v) p.set(k, v); };
  put('group', f.groups?.length ? f.groups.join(',') : null);
  put('manager', f.manager || null);
  put('product', f.products?.length ? f.products.join('|') : null);
  put('q', f.q?.trim() || null);
  put('smin', num(f.sumMin)); put('smax', num(f.sumMax));
  put('cfrom', f.createdFrom || null); put('cto', f.createdTo || null);
  put('states', f.states?.length ? f.states.join(',') : null);
  put('cols', f.columns?.length ? f.columns.join(',') : null);
  put('dmin', num(f.daysMin)); put('idle', num(f.idleDaysMin));
  put('stuck', f.stuck ? '1' : null); put('nocalls', f.noCalls ? '1' : null); put('nolost', f.hideLost ? '1' : null); put('unas', f.unassigned ? '1' : null);
  put('deal', f.deal || null);
  if (sort && sort !== 'default') p.set('sort', sort);
  return p;
}

/** Убрать пустые поля (для сохранения своей колонки и сравнения). */
export function cleanFilters(f: BigFilters): BigFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '' || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'number' && !(v > 0)) continue;
    out[k] = v;
  }
  return out as BigFilters;
}

/** Условия своей колонки поверх текущих фильтров доски (массовое закрытие «по правилу»): массивы — пересечение по смыслу
 *  делает движок, здесь правило колонки просто важнее. */
export function mergeFilters(base: BigFilters, rule: BigFilters): BigFilters {
  return cleanFilters({ ...base, ...cleanFilters(rule) });
}

/** Какой набор фильтров соответствует стандартной секции «Сегодня» (для массового закрытия по правилу). */
export function todayRule(key: string): BigFilters | null {
  switch (key) {
    case 'control': return { states: ['control'] };
    case 'almost_sold': return { columns: ['reserve_confirmed', 'reserve', 'invoice'] as BigColumnKey[] };
    case 'new': return { columns: ['new'] };
    case 'stuck': return { stuck: true };
    case 'lost_check': return { columns: ['lost_check'] };
    default: return null; // related_answered — по фильтрам не выразить
  }
}

/** Человеческое описание условий (подсказка у своей колонки). */
export function describeFilters(f: BigFilters, groups: { id: number; short: string }[] = []): string {
  const parts: string[] = [];
  const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  if (f.groups?.length) parts.push(`проекты: ${f.groups.map(id => groups.find(g => g.id === id)?.short ?? id).join(', ')}`);
  if (f.columns?.length) parts.push(`колонки: ${f.columns.map(k => BIG_COLUMNS.find(c => c.key === k)?.title ?? k).join(', ')}`);
  if (f.products?.length) parts.push(`группы: ${f.products.join(', ')}`);
  if (f.sumMin) parts.push(`от ${rub.format(f.sumMin)} ₽`);
  if (f.sumMax) parts.push(`до ${rub.format(f.sumMax)} ₽`);
  if (f.states?.length) parts.push(`статус: ${f.states.map(s => STATE_META[s]?.label ?? s).join(', ')}`);
  if (f.daysMin) parts.push(`в колонке ≥ ${f.daysMin} дн.`);
  if (f.idleDaysMin) parts.push(`без изменений ≥ ${f.idleDaysMin} дн.`);
  if (f.stuck) parts.push('застряли');
  if (f.noCalls) parts.push('звонков не было');
  if (f.deal) parts.push(`сделка: ${DEAL_OPTIONS.find(o => o.value === f.deal)?.label.toLowerCase()}`);
  return parts.join(' · ');
}
