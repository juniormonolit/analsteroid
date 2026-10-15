// Общее для вкладок «Ответов на запросы» (методика Панели снабжения): запрос к
// /api/realizations/supply/*, формат рабочих минут, справочник фильтров.
// Типы — только import type из lib/supplyPanel (сам модуль тянет node-модули, в клиент нельзя).
import type { TaskListOut, DomDealOut } from '@/lib/supplyPanel/queries';
import type { GoodsTree, DomTree } from '@/lib/supplyPanel/metrics';

export type { TaskListOut, DomDealOut, GoodsTree, DomTree };

export interface SupplyMeta {
  builtAt: string | null; pulledAt: string | null; catalogAt: string | null; goodsSince: string | null;
  regions: string[]; depts: string[]; projects: { id: number; name: string; region: string; dept: string }[];
}
export type WithPulled<T> = T & { pulledAt: string | null };

/** GET к API панели; 503 («снимок не загружен») и прочие ошибки — текстом из ответа. */
export async function getSupply<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) throw new Error('Недостаточно прав: раздел «Реализация» доступен только роли «Администратор»');
  if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
  return body as T;
}

/** Рабочие минуты → «ч:мм» (панель считает скорости в рабочих часах 09–18 МСК). */
export function fmtWorkMin(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—';
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

/** «данные на 14.10 18:15» — момент последней выгрузки снимка (МСК). */
export function fmtPulled(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const s = new Date(d.getTime() + 3 * 3600_000).toISOString();
  return `данные на ${s.slice(8, 10)}.${s.slice(5, 7)} ${s.slice(11, 16)}`;
}
