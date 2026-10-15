// «Когда звонить» (владелец 15.10, идея A аудита Fable): вместо голой цифры
// «цикл повторки 47 дн.» — вывод: следующая покупка ожидается тогда-то / пора
// звонить / давно не покупал (риск ухода).
//
// Покупка = отгрузки в пределах 3 дней (одна закупка часто едет несколькими
// сделками). Цикл — МЕДИАНА интервалов между покупками: одна долгая пауза
// (зима, перерыв между объектами) не растягивает прогноз, как среднее в плитке ТЗ.
// Меньше трёх покупок (двух интервалов) — прогноза нет: шум.

import type { ModuleDeal } from './types';

const DAY = 86_400_000;
const SAME_PURCHASE_DAYS = 3;

export type CallTimingState = 'soon' | 'due' | 'overdue';

export interface CallTiming {
  state: CallTimingState;
  /** Медиана интервалов между покупками, дней. */
  cycle: number;
  /** Дней с последней покупки. */
  since: number;
  /** Ожидаемая дата следующей покупки (ISO). */
  nextAt: string;
  purchases: number;
}

export function callTiming(deals: ModuleDeal[], now = Date.now()): CallTiming | null {
  const days = deals.filter(d => d.deliveredAt).map(d => new Date(d.deliveredAt!).getTime()).sort((a, b) => a - b);
  const purchases: number[] = [];
  for (const t of days) if (!purchases.length || t - purchases[purchases.length - 1] > SAME_PURCHASE_DAYS * DAY) purchases.push(t);
  if (purchases.length < 3) return null;
  const gaps = purchases.slice(1).map((t, i) => (t - purchases[i]) / DAY).sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const cycle = Math.max(1, Math.round(gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2));
  const last = purchases[purchases.length - 1];
  const since = Math.max(0, Math.floor((now - last) / DAY));
  // «Пора» — за неделю до ожидаемой даты; «давно» — пропущено больше одного цикла.
  const state: CallTimingState = since > cycle * 2 ? 'overdue' : since >= cycle - Math.min(7, Math.round(cycle / 3)) ? 'due' : 'soon';
  return { state, cycle, since, nextAt: new Date(last + cycle * DAY).toISOString(), purchases: purchases.length };
}
