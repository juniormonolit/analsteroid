// Плитки доски (как в «[MLT] Канбан логиста»): новые, возобновлённые, скорость взятия/ответа/выполнения,
// сумма продаж — за период, по запросам, прошедшим фильтры. Чистая функция по журналу.
import type { RequestCard, Tiles } from './contract';
import { buildCycles, median, type CycleEvent } from './cycles';
import { mskDate } from './filters';

export interface TileRow { card: RequestCard; events: CycleEvent[] }

/** Период по умолчанию — последние 30 дней по МСК, включая сегодня. */
export function defaultPeriod(now: Date): { from: string; to: string } {
  const to = mskDate(now.toISOString());
  const from = mskDate(new Date(now.getTime() - 29 * 86_400_000).toISOString());
  return { from, to };
}

export function computeTiles(rows: readonly TileRow[], from: string, to: string): Tiles {
  const inP = (iso: string | null) => !!iso && mskDate(iso) >= from && mskDate(iso) <= to;
  let newCount = 0, reopenedCount = 0, salesSum = 0, salesCount = 0;
  const take: number[] = [], answer: number[] = [], exec: number[] = [];
  for (const { card, events } of rows) {
    for (const e of events) {
      if (!inP(e.at)) continue;
      if (e.kind === 'sent') newCount++;
      else if (e.kind === 'returned') reopenedCount++;
    }
    for (const c of buildCycles(events)) {
      // скорость взятия — по циклам, взятым в периоде; ответа и выполнения — по ответам в периоде
      if (c.takeH !== null && inP(c.take)) take.push(c.takeH);
      if (c.answerH !== null && inP(c.answer)) answer.push(c.answerH);
      if (c.execH !== null && inP(c.answer)) exec.push(c.execH);
    }
    if (card.dealOutcome === 'sold' && inP(card.sentAt ?? card.createdAt)) {
      salesSum += card.deal?.amount ?? card.amount;
      salesCount++;
    }
  }
  return {
    periodFrom: from, periodTo: to, newCount, reopenedCount,
    takeSpeedH: median(take), answerSpeedH: median(answer), execSpeedH: median(exec),
    salesSum: Math.round(salesSum), salesCount,
  };
}
