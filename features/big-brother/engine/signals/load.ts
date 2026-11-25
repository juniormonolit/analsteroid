// «Большой брат», поток G — дневные ряды людей из activity_daily (+ ночная активность из подробной ленты) и лента
// сигналов риска на дату.
import { systemDb } from '@/lib/db/clients';
import type { MonitoredPerson } from '../daily/people';
import { addDays, mskDate } from '../daily/time';
import { detectSignals } from './detect';
import type { SeriesPoint, SignalFeedItem } from './types';

/** Сколько дней истории нужно детекторам (норма 20 рабочих дней + 5 тишины + запас; new_surface смотрит 67 дней). */
export const HISTORY_DAYS = 75;

const isMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';

/** Первая дата с данными Монолитики (журнал потока A пишется с 25.11). null — данных ещё нет. */
export async function loadMonoSince(): Promise<string | null> {
  const r = await systemDb().query<{ d: string | null }>(
    `SELECT to_char(min(snap_date), 'YYYY-MM-DD') AS d FROM activity_daily WHERE mono_minutes > 0`,
  ).catch(e => { if (isMissing(e)) return { rows: [{ d: null }] }; throw e; });
  return r.rows[0]?.d ?? null;
}

/**
 * Ряды людей ids за [from, to]. Ночь (22:00–06:00 МСК) — из activity_minutes / activity_events (хранятся 90 дней),
 * относится к дате МСК самого события.
 */
export async function loadSeries(ids: string[], from: string, to: string): Promise<Map<string, SeriesPoint[]>> {
  const out = new Map<string, SeriesPoint[]>();
  if (!ids.length) return out;
  const db = systemDb();
  const [daily, night] = await Promise.all([
    db.query<{
      id: string; d: string; is_workday: boolean | null; in_work: boolean; mono_minutes: number; counts: Record<string, number>;
      surfaces: Record<string, number>;
    }>(
      `SELECT bitrix_user_id AS id, to_char(snap_date, 'YYYY-MM-DD') AS d, is_workday, in_work, mono_minutes, counts, surfaces
         FROM activity_daily WHERE bitrix_user_id = ANY($1) AND snap_date BETWEEN $2::date AND $3::date
        ORDER BY snap_date`, [ids, from, to],
    ).catch(e => { if (isMissing(e)) return { rows: [] }; throw e; }),
    db.query<{ id: string; d: string; n: number }>(
      `SELECT id, d, count(*)::int AS n FROM (
         SELECT bitrix_user_id AS id, bucket AS t FROM activity_minutes
          WHERE source = 'mono' AND bitrix_user_id = ANY($1) AND bucket >= $2::date - interval '1 day'
         UNION ALL
         SELECT bitrix_user_id, ts FROM activity_events
          WHERE bitrix_user_id = ANY($1) AND ts >= $2::date - interval '1 day' AND kind IN ('mono_view', 'mono_action', 'session')
       ) x
       CROSS JOIN LATERAL (SELECT (t AT TIME ZONE 'Europe/Moscow') AS l) m
       CROSS JOIN LATERAL (SELECT to_char(m.l, 'YYYY-MM-DD') AS d) dd
       WHERE extract(hour FROM m.l) >= 22 OR extract(hour FROM m.l) < 6
       GROUP BY 1, 2`, [ids, from],
    ).catch(e => { if (isMissing(e)) return { rows: [] }; throw e; }),
  ]);
  const nightBy = new Map(night.rows.map(r => [`${r.id}|${r.d}`, r.n]));
  for (const r of daily.rows) {
    const c = r.counts ?? {};
    const mono = r.mono_minutes + (c.mono_view ?? 0) + (c.mono_action ?? 0) + (c.session ?? 0);
    const p: SeriesPoint = {
      date: r.d, isWorkday: !!r.is_workday, inWork: r.in_work, buckets: Number(c.buckets ?? 0), mono,
      surfaces: Object.keys(r.surfaces ?? {}),
      exports: (c['mono_action.report_export'] ?? 0) + (c['mono_action.report_drill'] ?? 0),
      night: nightBy.get(`${r.id}|${r.d}`) ?? 0,
    };
    const l = out.get(r.id);
    if (l) l.push(p); else out.set(r.id, [p]);
  }
  return out;
}

/** Лента сигналов на asOf (по умолчанию сегодня МСК) по людям. Свежие и серьёзные — первыми. */
export async function buildSignalFeed(people: MonitoredPerson[], asOf = mskDate()): Promise<{ signals: SignalFeedItem[]; monoSince: string | null }> {
  const [monoSince, series] = await Promise.all([
    loadMonoSince(),
    loadSeries(people.map(p => p.id), addDays(asOf, -HISTORY_DAYS), asOf),
  ]);
  const signals: SignalFeedItem[] = [];
  for (const p of people) {
    for (const s of detectSignals(p.id, series.get(p.id) ?? [], asOf, monoSince)) {
      signals.push({ ...s, name: p.name, role: p.role, departmentName: p.departmentName, ropName: p.ropName });
    }
  }
  signals.sort((a, b) => b.since.localeCompare(a.since) || b.weight - a.weight || a.name.localeCompare(b.name, 'ru'));
  return { signals, monoSince };
}
