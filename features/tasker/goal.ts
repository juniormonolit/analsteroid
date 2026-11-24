// Цель задачи по умолчанию — одно правило для формы (CreateTaskDrawer) и сервера (engine/create.ts).
// Баг 24.11 (Генкал: менеджер 18,2 %, отдел 13,8 % → форма ставила цель 13,8 — «прокачать» вниз).
//
// Для «больше — лучше» (для «меньше — лучше» всё зеркально):
//   base = лучшее из (среднее отдела, своё за 6 мес);
//   текущее хуже base           → цель = base;
//   текущее уже не хуже base    → цель = текущее, улучшенное на шаг: +10 % относительных
//                                  (для процентов — не меньше 1 п.п.), округление по формату в сторону улучшения.
// Модуль чистый (без БД) — импортируется и клиентом, и сервером.
import type { Snapshot, TaskerMetric } from './types';

type Fmt = TaskerMetric['format'];
type Dir = { higherIsBetter: boolean };

export type GoalSource = 'dept' | 'own' | 'step' | 'none';

export interface DefaultGoal {
  target: number | null;
  source: GoalSource;
  /** Подпись под полем цели: откуда взялось число. */
  reason: string;
}

const REL_STEP = 0.1;
const PERCENT_MIN_STEP = 1;

/** Шаг округления по формату: деньги — рубль, остальное — десятая. */
const unitOf = (format: Fmt | undefined) => (format === 'money' ? 1 : 0.1);

/** Округлить по формату; `toward` — в какую сторону (чтобы округление не сделало цель хуже). */
export function roundGoal(v: number, format: Fmt | undefined, toward: 'up' | 'down' | 'nearest' = 'nearest'): number {
  const u = unitOf(format);
  const k = v / u;
  // 1e-9 — чтобы 13.8/0.1 = 137.99999… не уехало вверх до 13,9.
  const r = toward === 'up' ? Math.ceil(k - 1e-9) : toward === 'down' ? Math.floor(k + 1e-9) : Math.round(k);
  return Math.round(r * u * 100) / 100;
}

/** a лучше b строго. */
export const isBetter = (m: Dir, a: number, b: number) => (m.higherIsBetter ? a > b : a < b);
/** a хуже b строго. */
export const isWorse = (m: Dir, a: number, b: number) => isBetter(m, b, a);

/** Менеджер уже лучше среднего по отделу (для пометки в снимке). */
export function aboveDept(m: Dir, s: Pick<Snapshot, 'value' | 'deptAvg'> | undefined | null): boolean {
  return !!s && s.value !== null && s.deptAvg !== null && isBetter(m, s.value, s.deptAvg);
}

export function aboveDeptLabel(m: Dir): string {
  return m.higherIsBetter ? 'выше среднего по отделу' : 'лучше среднего по отделу';
}

/** Текущее, улучшенное на шаг. */
function stepFrom(m: Dir, cur: number, format: Fmt | undefined): number {
  let step = Math.abs(cur) * REL_STEP;
  if (format === 'percent') step = Math.max(step, PERCENT_MIN_STEP);
  step = Math.max(step, unitOf(format));
  if (m.higherIsBetter) return roundGoal(cur + step, format, 'up');
  return Math.max(0, roundGoal(cur - step, format, 'down'));
}

export function defaultGoal(m: Dir & { format?: Fmt }, s: Pick<Snapshot, 'value' | 'deptAvg' | 'ownAvg6m'> | undefined | null): DefaultGoal {
  const format = m.format;
  const toward = m.higherIsBetter ? 'up' : 'down';
  const cands: { v: number; source: 'dept' | 'own' }[] = [];
  if (s?.deptAvg != null && Number.isFinite(s.deptAvg)) cands.push({ v: s.deptAvg, source: 'dept' });
  if (s?.ownAvg6m != null && Number.isFinite(s.ownAvg6m)) cands.push({ v: s.ownAvg6m, source: 'own' });
  const base = cands.reduce<(typeof cands)[number] | null>((best, c) => (!best || isBetter(m, c.v, best.v) ? c : best), null);
  const cur = s?.value != null && Number.isFinite(s.value) ? s.value : null;
  const stepText = m.higherIsBetter
    ? `цель +10 % к текущему${format === 'percent' ? ' (не меньше 1 п.п.)' : ''}`
    : `цель −10 % к текущему${format === 'percent' ? ' (не меньше 1 п.п.)' : ''}`;

  if (cur !== null && (!base || !isWorse(m, cur, base.v))) {
    return {
      target: stepFrom(m, cur, format),
      source: 'step',
      reason: base
        ? `Менеджер уже ${m.higherIsBetter ? 'выше' : 'лучше'} ${base.source === 'dept' ? 'среднего по отделу' : 'своего среднего за 6 мес'} — ${stepText}`
        : `Средних для сравнения нет — ${stepText}`,
    };
  }
  if (base) {
    return {
      // До ближайшего (как в снимке), а в сторону улучшения — только если иначе цель выйдет хуже текущего.
      target: cur !== null && isWorse(m, roundGoal(base.v, format), cur) ? roundGoal(base.v, format, toward) : roundGoal(base.v, format),
      source: base.source,
      reason: (base.source === 'dept' ? 'Среднее по отделу' : 'Своё среднее за 6 мес') + (cands.length > 1 ? ' — лучшее из двух средних' : ''),
    };
  }
  return { target: null, source: 'none', reason: 'Нет цифр для цели — задайте вручную' };
}

/** Ручная цель хуже текущего значения — задача на ухудшение. «Мало данных» не проверяем. */
export function goalWorseThanCurrent(m: Dir, target: number | null | undefined, s: Pick<Snapshot, 'value' | 'enoughData'> | undefined | null): boolean {
  return target != null && !!s && s.enoughData && s.value !== null && isWorse(m, target, s.value);
}
