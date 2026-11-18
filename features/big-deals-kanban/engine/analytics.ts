// Аналитика канбана больших чеков по менеджерам (встреча 11.11: «сколько больших задач, продано, проебано, конверсия —
// подсветить низкую»). Менеджер = ответственный задачи. Период — по дате создания задачи (МСК), по умолчанию 90 дней.
// Снимок доски держит закрытые только за 30 дней, поэтому закрытые раньше догружаются отдельно и лениво (load.ts,
// loadArchivedCards, кэш 30 мин) — только для аналитики, холодная загрузка доски не растёт.
import type { SessionUser } from '@/lib/auth/session';
import type { BigAnalyticsResponse, BigFilters, BigManagerStat, BigPerson, BigTaskCard } from './types';
import { loadArchivedCards, loadSnapshot, withAge } from './load';
import { bigActor } from './actor';
import { canSeeTask, type VisibilityActor } from './visibility';
import { cardAmount, matchFilters, mskDate } from './filters';

export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;
const SNAPSHOT_CLOSED_DAYS = 30;
const DAY = 86_400_000;

export const isSold = (c: BigTaskCard) => c.column === 'sold' || c.deal?.closed === 'won';
export const isLost = (c: BigTaskCard) => !isSold(c) && (c.column === 'lost_check' || c.column === 'lost_done' || c.deal?.closed === 'lost');

/** Период: from/to YYYY-MM-DD (МСК); по умолчанию последние 90 дней; не глубже 365 дней; from ≤ to. */
export function analyticsPeriod(fromQ: string | null, toQ: string | null, now = Date.now()): { from: string; to: string } {
  const ok = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
  const today = mskDate(now);
  const floor = mskDate(now - MAX_DAYS * DAY);
  let to = ok(toQ) ?? today;
  if (to > today) to = today;
  let from = ok(fromQ) ?? mskDate(now - (DEFAULT_DAYS - 1) * DAY);
  if (from < floor) from = floor;
  if (from > to) from = to;
  return { from, to };
}

const empty = (manager: BigPerson): BigManagerStat =>
  ({ manager, tasks: 0, open: 0, sold: 0, lost: 0, conversion: null, soldSum: 0, openSum: 0, callsPerTask: null });

/** Чистый расчёт по готовым карточкам (видимость + фильтры + период). */
export function analyticsFromCards(all: BigTaskCard[], o: {
  actor: VisibilityActor; filters: BigFilters; from: string; to: string; now?: number;
}): BigAnalyticsResponse {
  const now = o.now ?? Date.now();
  const f: BigFilters = { ...o.filters, createdFrom: o.from, createdTo: o.to };
  const byId = new Map<number, BigTaskCard>();
  for (const c of all) if (!byId.has(c.id)) byId.set(c.id, c);
  const cards = [...byId.values()].filter(c => canSeeTask(c, o.actor)).map(c => withAge(c, now)).filter(c => matchFilters(c, f, now));

  const per = new Map<string, BigManagerStat & { callsN: number; callsSum: number }>();
  const total = { ...empty({ id: 'all', name: 'Все' }), callsN: 0, callsSum: 0 };
  for (const c of cards) {
    const m = per.get(c.responsible.id) ?? { ...empty(c.responsible), callsN: 0, callsSum: 0 };
    per.set(c.responsible.id, m);
    for (const s of [m, total]) {
      s.tasks++;
      const amount = cardAmount(c);
      if (isSold(c)) { s.sold++; s.soldSum += amount; } else if (isLost(c)) s.lost++; else { s.open++; s.openSum += amount; }
      if (c.calls) { s.callsN++; s.callsSum += c.calls.total; }
    }
  }
  const fin = ({ callsN, callsSum, ...s }: BigManagerStat & { callsN: number; callsSum: number }): BigManagerStat => ({
    ...s,
    conversion: s.sold + s.lost ? s.sold / (s.sold + s.lost) : null,
    callsPerTask: callsN ? Math.round((callsSum / callsN) * 10) / 10 : null,
  });
  const managers = [...per.values()].map(fin).sort((a, b) => b.tasks - a.tasks || a.manager.name.localeCompare(b.manager.name, 'ru'));
  const t = fin(total);
  // Средняя конверсия — общая по всем задачам периода (sold / (sold + lost)), а не среднее процентов: у менеджера
  // с двумя задачами не тот вес, что у менеджера с двумястами.
  return { from: o.from, to: o.to, total: t, managers, avgConversion: t.conversion };
}

export async function buildBigAnalytics(session: SessionUser, filters: BigFilters, period: { from: string; to: string }): Promise<BigAnalyticsResponse> {
  const needArchive = period.from < mskDate(Date.now() - SNAPSHOT_CLOSED_DAYS * DAY);
  const [actor, snap, archived] = await Promise.all([
    bigActor(session), loadSnapshot(), needArchive ? loadArchivedCards(period.from) : Promise.resolve([] as BigTaskCard[]),
  ]);
  // Снимок первым: при дублях (задача закрылась между загрузками) берётся свежая карточка.
  return analyticsFromCards([...snap.cards, ...archived], { actor, filters, ...period });
}
