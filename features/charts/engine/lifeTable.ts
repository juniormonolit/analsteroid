import type { CalledToSaleCohortPoint, CalledToSaleCohortResult } from './types';

// Таблица дожития (life table) — общий алгоритм для двух графиков-когорт:
//  * «Созвонился → продажа по дням» (calledToSaleCohort.ts, задача 2533) —
//    день = календарные дни от входа в стадию до продажи.
//  * «В работе → продажа по дням» (workDaysCohort.ts, задача 2553, владелец:
//    «вот этот график [«вероятность продажи от дней в работе»] по аналогии с
//    третьим добавь») — день = накопленные дни в WORK-стадиях (та же величина,
//    что ось X у SurvivalChart пресета 'work'), НЕ календарные дни.
//
// Разный источник «дня», один и тот же алгоритм раскладки по life-table:
// вход — построчно {eventDay, observedDays}, выход — точки day=0..maxDay +
// один агрегированный «maxDay+1»+, с cohortAtLeastN (право-цензурированная
// «дожили минимум N дней») и soldOnDayN. Вынесено сюда, чтобы не дублировать
// цикл под разные источники дней (владелец 2553: «не копируй логику дважды,
// если можно вынести общее»).

export const LIFE_TABLE_MAX_DAY = 30;

export interface LifeTableRow {
  dealId: number;
  eventDay: number | null;  // floor(день продажи), null — если не продана
  observedDays: number;     // floor(наблюдаемых дней): = eventDay, если продана, иначе «по сейчас»
  // Сумма сделки d.amount (задача 30.07 — суммы «до/в/после дня» в тултипе).
  // Используется только у ПРОДАННЫХ (eventDay !== null); NULL в БД → 0.
  amount?: number;
}

export function buildLifeTablePoints(rows: LifeTableRow[], maxDay: number = LIFE_TABLE_MAX_DAY): CalledToSaleCohortResult {
  const points: CalledToSaleCohortPoint[] = [
    ...Array.from({ length: maxDay + 1 }, (_, day) => ({ day, label: String(day), cohort: 0, sold: 0, pct: null as number | null })),
    { day: maxDay + 1, label: `${maxDay + 1}+`, cohort: 0, sold: 0, pct: null },
  ];
  // Σ amount проданных ровно на день idx (задача 30.07 — суммы в тултипе);
  // индексация тем же idx, что и points[idx].sold, хвост «(maxDay+1)+» — одна
  // агрегированная точка, поэтому двойного счёта нет по построению.
  const soldAmountAtDay = new Array<number>(points.length).fill(0);

  for (const r of rows) {
    // cohortAtLeastN: сколько сделок «дожили» минимум N дней, не продав раньше.
    // Право-цензурировано — сделка без продажи учитывается только пока
    // наблюдалась минимум N дней (observedDays>=N), иначе про её судьбу на день N
    // мы ещё ничего не знаем.
    for (let day = 0; day <= maxDay; day++) {
      if (r.observedDays >= day) points[day].cohort += 1;
    }
    if (r.observedDays >= maxDay + 1) points[maxDay + 1].cohort += 1;

    if (r.eventDay !== null) {
      const idx = r.eventDay <= maxDay ? r.eventDay : maxDay + 1;
      points[idx].sold += 1;
      soldAmountAtDay[idx] += r.amount ?? 0;
    }
  }

  for (const p of points) {
    p.pct = p.cohort > 0 ? Math.round((p.sold / p.cohort) * 1000) / 10 : null;
  }

  // Суммы «до/в/после дня» (задача 30.07): префиксные суммы по soldAmountAtDay —
  // before(N) + day(N) + after(N) = total НА КАЖДОЙ точке по построению.
  // Заполняем, только если строки вообще несли amount (все 3 lifeTable-графика
  // несут; если появится вызывающий без amount — тултип просто не покажет блок).
  if (rows.some(r => r.amount !== undefined)) {
    const total = soldAmountAtDay.reduce((s, v) => s + v, 0);
    let before = 0;
    for (let i = 0; i < points.length; i++) {
      const day = soldAmountAtDay[i];
      points[i].amounts = { before, day, after: total - before - day, total };
      before += day;
    }
  }

  const soldTotal = points.reduce((s, p) => s + p.sold, 0);
  const cohortTotal = points[0]?.cohort ?? 0;

  return {
    points,
    cohortTotal,
    soldTotal,
    overallPct: cohortTotal > 0 ? Math.round((soldTotal / cohortTotal) * 1000) / 10 : null,
  };
}

// Дрилл-даун (задача 2546/2553): те же условия, что buildLifeTablePoints кладёт
// в points[day].cohort/sold — число сделок в списке гарантированно совпадает с
// числом на графике (общий код с агрегацией, не копия).
export function selectLifeTableDealIds(
  rows: LifeTableRow[], day: number, filter: 'all' | 'sold', maxDay: number = LIFE_TABLE_MAX_DAY,
): number[] {
  if (day < 0 || day > maxDay + 1) return [];
  if (filter === 'sold') {
    return rows
      .filter(r => r.eventDay !== null && (day <= maxDay ? r.eventDay === day : r.eventDay > maxDay))
      .map(r => r.dealId);
  }
  // filter === 'all' — та же «at risk» логика, что в основном цикле выше.
  return rows.filter(r => r.observedDays >= day).map(r => r.dealId);
}
