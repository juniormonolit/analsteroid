/**
 * Общее для API и движка отчёта «Ответы на запросы»: снимок, границы периода, фильтры.
 * Период UI — сутки МСК включительно; панель считает по полуоткрытому [d0, d1) в наивном МСК.
 */
import { loadSnapshot, type Snapshot } from './snapshot';
import type { Dt, Filter } from './metrics';
import { mskYmd } from '@/lib/realizations/period';

export const NO_SNAPSHOT_MSG = 'Данные Панели снабжения ещё не загружены — синхронизация идёт раз в 15 минут, попробуйте позже';

export class NoSnapshotError extends Error {
  constructor() { super(NO_SNAPSHOT_MSG); }
}

export async function requireSnapshot(): Promise<Snapshot> {
  const s = await loadSnapshot();
  if (!s) throw new NoSnapshotError();
  return s;
}

const nextDay = (ymd: string): string => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);

/** [from 00:00 МСК, (to + 1 день) 00:00 МСК) — по календарным датам МСК границ. */
export function periodBounds(from: Date, to: Date): [Dt, Dt] {
  return [`${mskYmd(from)} 00:00:00`, `${nextDay(mskYmd(to))} 00:00:00`];
}

const ints = (s: string | null): number[] => (s ?? '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x)).map(Number);

/** Фильтры query-строки: region=СПБ,МСК · dept=ОС · group=105 · user=12,34 · person=ФИО (как _args панели). */
export function parseFilter(sp: URLSearchParams): Filter {
  const f: Filter = {};
  const region = (sp.get('region') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (region.length) f.region = region;
  const dept = sp.get('dept');
  if (dept) f.dept = dept;
  const group = ints(sp.get('group'));
  if (group.length) f.group = group[0]!;
  const user = ints(sp.get('user'));
  if (user.length) f.user = user;
  const person = sp.get('person');
  if (person) f.person = person;
  return f;
}

/** from/to query: ISO-время или ГГГГ-ММ-ДД; null — неверный период. */
export function parsePeriod(sp: URLSearchParams): [Dt, Dt] | null {
  const from = new Date(sp.get('from') ?? ''), to = new Date(sp.get('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return null;
  return periodBounds(from, to);
}
