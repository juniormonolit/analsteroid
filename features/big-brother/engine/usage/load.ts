// «Большой брат» → «Использование» (поток E): как пользуются отчётами Монолитики — живые/мёртвые, глубина,
// параметры, пустые/медленные загрузки, мобильный срез, внедрение фич по changelog.
// Углубляет блок «Отчёты» на «Обзоре» (app/(app)/big-brother/page.tsx): там — кто что открывал за период,
// здесь — качество захода (отскок, глубина), параметры, сироты, ошибки и скорость.
//
// ЗАХОД (visit) — подряд идущие просмотры одного отчёта одним человеком (повторные mono_view того же раздела в
// пределах 30 мин склеиваются: смена параметров может менять адрес). Конец захода — следующий просмотр другого
// раздела, но не дольше 30 мин. Действия захода — mono_action report_load/drill/export того же человека и отчёта
// от (начало − 15 с) до конца.
// ОТСКОК — заход короче минуты (total_ms от потока A, иначе — время до следующего просмотра), не больше одного набора
// параметров загрузки, без drill и выгрузки. Длительность неизвестна (ушёл и не вернулся, нет total_ms) — в долю не идёт.
//
// Устойчивость к схеме: поля потока A (duration_ms, rows, metric_ids, report_error, total_ms, changelog_open,
// changelog_entries.section) — это ключи payload / необязательная колонка; нет — нули и дата «копится с» = null.
// Все таблицы — БД system (systemDb); ФИО ушедших владельцев — sa.org_resolved_hierarchy (analyticsDb).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { SECTION_SQL } from '@/lib/activity/section';
import type {
  ChangelogFunnelRow, DepthSteps, QualityRow, ReportKind, SavedOrphanRow, SurfaceRow, UsageDataSince, UsageDto,
  UsageParams, UsageReportRow,
} from './types';

/** Отчёты продаж (страницы app/(app)/sales/*) — каталог для «мёртвых»: в списке даже без единого захода. */
export const SALES_REPORTS: Record<string, string> = {
  'by-managers': 'По менеджерам',
  'by-periods': 'По периодам',
  'by-product-groups': 'По товарным группам',
  'by-clients': 'По клиентам',
  'client-tail': 'Хвост клиентов',
  'product-matrix': 'Товарная матрица',
  'transition-matrix': 'Матрица переходов',
  repeat: 'Повторные продажи',
};
const AREA_LABEL: Record<string, string> = { marketing: 'Маркетинг', realizations: 'Реализация' };

const REPORT_RE = `'^(sales/(?!unsell-deal$|saved$)[^/]+$|sales/saved/[0-9a-zA-Z-]+$|marketing/|realizations/)'`;
const WHO = `COALESCE(bitrix_user_id, 'u:' || user_id::text)`;

function kindOf(sec: string): ReportKind {
  if (sec.startsWith('sales/saved/')) return 'saved';
  if (sec.startsWith('marketing/')) return 'marketing';
  if (sec.startsWith('realizations/')) return 'realizations';
  return 'sales';
}

function labelOf(sec: string, saved: Map<string, string>): string {
  const m = sec.match(/^sales\/saved\/(.+)$/);
  if (m) return saved.get(m[1]) ?? 'Сохранённый отчёт (удалён)';
  const [area, slug] = sec.split('/');
  if (area === 'sales') return SALES_REPORTS[slug] ?? slug;
  return `${AREA_LABEL[area] ?? area}: ${slug}`;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const n = (v: unknown) => Number(v ?? 0) || 0;

/** CTE заходов за 90 дней ($1 — граница). Даёт vstats: заход с длительностью и счётчиками действий. */
const VISITS_CTE = `
WITH views AS (
  SELECT id, ts, user_id, ${WHO} AS who, surface, ${SECTION_SQL} AS sec,
         CASE WHEN payload->>'total_ms' ~ '^[0-9]+$' THEN (payload->>'total_ms')::numeric END AS total_ms
    FROM activity_events WHERE kind = 'mono_view' AND ts >= $1),
nav AS (
  SELECT *, CASE WHEN lag(sec) OVER w IS DISTINCT FROM sec OR ts - lag(ts) OVER w > interval '30 minutes' THEN 1 ELSE 0 END AS fresh
    FROM views WINDOW w AS (PARTITION BY who ORDER BY ts, id)),
grp AS (SELECT *, sum(fresh) OVER (PARTITION BY who ORDER BY ts, id) AS g FROM nav),
vis0 AS (
  SELECT who, g, min(sec) AS sec, min(ts) AS ts, max(ts) AS last_ts, (array_agg(surface ORDER BY ts))[1] AS surface,
         CASE WHEN count(total_ms) = count(*) THEN sum(total_ms) END AS total_ms
    FROM grp GROUP BY who, g),
vis AS (
  SELECT *, lead(ts) OVER (PARTITION BY who ORDER BY ts) AS next_ts, lead(sec) OVER (PARTITION BY who ORDER BY ts) AS next_sec
    FROM vis0),
visits AS (
  SELECT *, LEAST(COALESCE(next_ts, last_ts + interval '30 minutes'), last_ts + interval '30 minutes') AS until
    FROM vis WHERE sec ~ ${REPORT_RE}),
acts AS (
  SELECT ts, ${WHO} AS who, ${SECTION_SQL} AS sec, action, payload
    FROM activity_events
   WHERE kind = 'mono_action' AND ts >= $1 AND action IN ('report_load', 'report_drill', 'report_export', 'report_error')),
vstats AS (
  SELECT v.who, v.sec, v.ts, v.surface, v.next_sec, v.next_ts, v.until,
         COALESCE(v.total_ms, CASE WHEN v.next_ts IS NOT NULL THEN extract(epoch FROM v.next_ts - v.ts) * 1000 END) AS dur_ms,
         COALESCE(a.loads, 0) AS loads, COALESCE(a.param_sets, 0) AS param_sets, COALESCE(a.periods, 0) AS periods,
         COALESCE(a.drills, 0) AS drills, COALESCE(a.exports, 0) AS exports
    FROM visits v
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE action = 'report_load') AS loads,
             count(DISTINCT (payload - 'duration_ms' - 'rows')) FILTER (WHERE action = 'report_load') AS param_sets,
             count(DISTINCT payload->'period') FILTER (WHERE action = 'report_load') AS periods,
             count(*) FILTER (WHERE action = 'report_drill') AS drills,
             count(*) FILTER (WHERE action = 'report_export') AS exports
        FROM acts a WHERE a.who = v.who AND a.sec = v.sec AND a.ts >= v.ts - interval '15 seconds' AND a.ts < v.until) a ON true)
`;
const BOUNCE = `(dur_ms < 60000 AND param_sets <= 1 AND drills = 0 AND exports = 0)`;
const DEPTH_COLS = `count(*) AS visits,
  count(*) FILTER (WHERE loads > 0) AS loaded,
  count(*) FILTER (WHERE param_sets > 1) AS changed_params,
  count(*) FILTER (WHERE periods > 1) AS changed_period,
  count(*) FILTER (WHERE drills > 0) AS drilled,
  count(*) FILTER (WHERE exports > 0) AS exported,
  count(*) FILTER (WHERE next_sec = 'manager' AND next_ts < until + interval '1 minute') AS to_manager`;

function depthOf(r: Record<string, unknown>): DepthSteps {
  return {
    visits: n(r.visits), loaded: n(r.loaded), changedParams: n(r.changed_params), changedPeriod: n(r.changed_period),
    drilled: n(r.drilled), exported: n(r.exported), toManager: n(r.to_manager),
  };
}

/** Безопасный запрос: отсутствующая таблица/колонка (42P01/42703) → пусто, остальное — наверх. */
async function soft<T>(p: Promise<{ rows: T[] }>): Promise<T[]> {
  try { return (await p).rows; } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === '42P01' || code === '42703') return [];
    throw e;
  }
}

export async function loadUsage(): Promise<UsageDto> {
  const db = systemDb();
  const now = Date.now();
  const since90 = new Date(now - 90 * 86400_000);
  const since30 = new Date(now - 30 * 86400_000);

  const hasChangelogSection = (await soft(db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = 'changelog_entries' AND column_name = 'section' AND table_schema = current_schema()) AS ok`,
  )))[0]?.ok === true;

  const [sinceRows, perSec, depthAll, depthSec, surf, surfWorst, presence, minutes, metricRows, groupRows, periodRows,
    scopeRows, qualityRows, savedRows, changelogRows] = await Promise.all([
    soft(db.query(
      `SELECT min(ts) AS journal,
              min(ts) FILTER (WHERE kind = 'mono_view' AND payload ? 'total_ms') AS view_duration,
              min(ts) FILTER (WHERE action = 'report_load' AND payload ? 'duration_ms') AS load_timing,
              min(ts) FILTER (WHERE action = 'report_load' AND payload ? 'rows') AS load_rows,
              min(ts) FILTER (WHERE action = 'report_load' AND payload ? 'metric_ids') AS metric_ids,
              min(ts) FILTER (WHERE action = 'report_error') AS errors,
              min(ts) FILTER (WHERE action = 'changelog_open') AS changelog_open
         FROM activity_events`)),
    soft(db.query(`${VISITS_CTE}
      SELECT sec, count(*) AS visits, count(dur_ms) AS bounce_known, count(*) FILTER (WHERE ${BOUNCE}) AS bounces
        FROM vstats GROUP BY sec`, [since90])),
    soft(db.query(`${VISITS_CTE} SELECT ${DEPTH_COLS} FROM vstats`, [since90])),
    soft(db.query(`${VISITS_CTE} SELECT sec, ${DEPTH_COLS} FROM vstats GROUP BY sec ORDER BY count(*) DESC LIMIT 15`, [since90])),
    soft(db.query(`${VISITS_CTE}
      SELECT surface, count(*) AS visits, count(dur_ms) AS bounce_known, count(*) FILTER (WHERE ${BOUNCE}) AS bounces,
             count(DISTINCT who) AS people
        FROM vstats GROUP BY surface ORDER BY 2 DESC`, [since90])),
    soft(db.query(`${VISITS_CTE}
      SELECT surface, sec, count(*) AS visits, count(dur_ms) AS bounce_known, count(*) FILTER (WHERE ${BOUNCE}) AS bounces
        FROM vstats GROUP BY surface, sec HAVING count(dur_ms) >= 3`, [since90])),
    // Кто заходил: просмотры и действия (действия без просмотра — отчёт открыт до начала журнала).
    soft(db.query(
      `SELECT sec, count(DISTINCT who) FILTER (WHERE ts >= $2) AS p30, count(DISTINCT who) AS p90,
              min(who) AS any_who, max(ts) AS last
         FROM (SELECT ${SECTION_SQL} AS sec, ${WHO} AS who, ts FROM activity_events
                WHERE ts >= $1 AND kind IN ('mono_view', 'mono_action')) x
        WHERE sec ~ ${REPORT_RE} GROUP BY sec`, [since90, since30])),
    soft(db.query(
      `SELECT section AS sec, count(*) FILTER (WHERE bucket >= $2) * 5 AS m30, count(*) * 5 AS m90,
              count(DISTINCT bitrix_user_id) AS people, max(bucket) AS last, min(bitrix_user_id) AS any_who
         FROM activity_minutes WHERE source = 'mono' AND bucket >= $1 AND section ~ ${REPORT_RE} GROUP BY section`,
      [since90, since30])),
    soft(db.query(
      `SELECT m AS id, count(*) AS loads, count(DISTINCT ${WHO}) AS people
         FROM activity_events,
              jsonb_array_elements_text(CASE WHEN jsonb_typeof(payload->'metric_ids') = 'array' THEN payload->'metric_ids' ELSE '[]'::jsonb END) m
        WHERE ts >= $1 AND kind = 'mono_action' AND action = 'report_load'
        GROUP BY m ORDER BY 2 DESC LIMIT 25`, [since90])),
    soft(db.query(
      `SELECT COALESCE(NULLIF(payload->>'grouping', ''), '—') AS key, count(*) AS loads
         FROM activity_events WHERE ts >= $1 AND kind = 'mono_action' AND action = 'report_load'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [since90])),
    soft(db.query(
      `SELECT CASE WHEN d IS NULL THEN 'не указан' WHEN d <= 1 THEN 'день' WHEN d <= 7 THEN 'до недели'
                   WHEN d <= 31 THEN 'до месяца' WHEN d <= 92 THEN 'до квартала' WHEN d <= 366 THEN 'до года' ELSE 'больше года' END AS bucket,
              count(*) AS loads
         FROM (SELECT CASE WHEN payload#>>'{period,from}' ~ '^\\d{4}-\\d{2}-\\d{2}' AND payload#>>'{period,to}' ~ '^\\d{4}-\\d{2}-\\d{2}'
                           THEN (substr(payload#>>'{period,to}', 1, 10)::date - substr(payload#>>'{period,from}', 1, 10)::date) + 1 END AS d
                 FROM activity_events WHERE ts >= $1 AND kind = 'mono_action' AND action = 'report_load') x
        GROUP BY 1 ORDER BY 2 DESC`, [since90])),
    soft(db.query(
      `SELECT COALESCE(NULLIF(payload->>'deal_scope', ''), '—') || ' · ' || COALESCE(NULLIF(payload->>'client_type', ''), '—') AS key,
              count(*) AS loads
         FROM activity_events WHERE ts >= $1 AND kind = 'mono_action' AND action = 'report_load'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [since90])),
    soft(db.query(
      `SELECT sec, count(*) FILTER (WHERE action <> 'report_error') AS loads,
              count(*) FILTER (WHERE action <> 'report_error' AND dms IS NOT NULL) AS with_timing,
              count(*) FILTER (WHERE action <> 'report_error' AND dms > 10000) AS slow,
              count(*) FILTER (WHERE action <> 'report_error' AND rws IS NOT NULL) AS with_rows,
              count(*) FILTER (WHERE action <> 'report_error' AND rws = 0) AS empty,
              count(*) FILTER (WHERE action = 'report_error') AS errors,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY dms) FILTER (WHERE action <> 'report_error' AND dms IS NOT NULL) AS p50
         FROM (SELECT ${SECTION_SQL} AS sec, action,
                      CASE WHEN payload->>'duration_ms' ~ '^[0-9]+$' THEN (payload->>'duration_ms')::numeric END AS dms,
                      CASE WHEN payload->>'rows' ~ '^[0-9]+$' THEN (payload->>'rows')::numeric END AS rws
                 FROM activity_events
                WHERE ts >= $1 AND kind = 'mono_action' AND action IN ('report_load', 'report_drill', 'report_error')) x
        WHERE sec ~ ${REPORT_RE} GROUP BY sec`, [since90])),
    soft(db.query(
      `SELECT s.id::text AS id, s.name, s.report_slug, s.user_login, s.shared_section, s.created_at,
              u.bitrix_user_id AS owner_bx, COALESCE(NULLIF(u.display_name, ''), s.user_login) AS owner
         FROM saved_reports s LEFT JOIN users u ON u.login = s.user_login`)),
    soft(db.query(
      `SELECT e.id::text AS id, e.title, e.published_at, ${hasChangelogSection ? 'e.section' : 'NULL::text'} AS section
         FROM changelog_entries e WHERE e.published_at >= $1 AND e.published_at <= now()
        ORDER BY e.published_at DESC LIMIT 30`, [since90])),
  ]);

  // ── имена: сохранённые отчёты, люди ──
  const savedName = new Map<string, string>(savedRows.map((r) => [String(r.id), String(r.name)]));
  const whoIds = new Set<string>();
  for (const r of [...presence, ...minutes]) if (r.any_who) whoIds.add(String(r.any_who));
  const bx = [...whoIds].filter((w) => !w.startsWith('u:'));
  const uid = [...whoIds].filter((w) => w.startsWith('u:')).map((w) => w.slice(2));
  const people = new Map<string, string>();
  if (bx.length || uid.length) {
    for (const p of await soft(db.query(
      `SELECT bitrix_user_id AS bx, id::text AS id, COALESCE(NULLIF(display_name, ''), login) AS name FROM users
        WHERE bitrix_user_id = ANY($1) OR id::text = ANY($2)`, [bx, uid]))) {
      if (p.bx) people.set(String(p.bx), String(p.name));
      people.set(`u:${p.id}`, String(p.name));
    }
  }

  // ── живые / мёртвые ──
  const bySec = new Map<string, UsageReportRow>();
  const row = (sec: string): UsageReportRow => {
    let r = bySec.get(sec);
    if (!r) {
      r = { section: sec, label: labelOf(sec, savedName), kind: kindOf(sec), people30: 0, people90: 0, minutes30: 0, minutes90: 0,
        visits: 0, bounceKnown: 0, bounces: 0, lastAt: null, soleViewer: null };
      bySec.set(sec, r);
    }
    return r;
  };
  for (const slug of Object.keys(SALES_REPORTS)) row(`sales/${slug}`);
  const sole = new Map<string, Set<string>>();
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  for (const p of presence) {
    const r = row(String(p.sec));
    r.people30 = Math.max(r.people30, n(p.p30)); r.people90 = Math.max(r.people90, n(p.p90));
    r.lastAt = later(r.lastAt, iso(p.last));
    if (n(p.p90) === 1) sole.set(r.section, new Set([...(sole.get(r.section) ?? []), String(p.any_who)]));
  }
  for (const m of minutes) {
    const r = row(String(m.sec));
    r.minutes30 = n(m.m30); r.minutes90 = n(m.m90);
    r.people90 = Math.max(r.people90, n(m.people));
    r.lastAt = later(r.lastAt, iso(m.last));
    if (n(m.people) === 1) sole.set(r.section, new Set([...(sole.get(r.section) ?? []), String(m.any_who)]));
  }
  for (const v of perSec) {
    const r = row(String(v.sec));
    r.visits = n(v.visits); r.bounceKnown = n(v.bounce_known); r.bounces = n(v.bounces);
  }
  for (const r of bySec.values()) {
    const s = sole.get(r.section);
    if (r.people90 === 1 && s?.size === 1) { const w = [...s][0]; r.soleViewer = people.get(w) ?? w; }
  }
  const reports = [...bySec.values()].sort((a, b) => b.people90 - a.people90 || b.minutes90 - a.minutes90 || a.label.localeCompare(b.label, 'ru'));

  // ── сохранённые-сироты: никто не открывал за окно журнала или владелец ушёл ──
  const ownerBx = [...new Set(savedRows.map((s) => s.owner_bx).filter(Boolean).map(String))];
  const activeBx = new Set<string>();
  if (ownerBx.length) {
    try {
      const r = await analyticsDb().query(
        `SELECT manager_bitrix_user_id AS id FROM sa.org_resolved_hierarchy WHERE is_active AND manager_bitrix_user_id = ANY($1)`, [ownerBx]);
      for (const x of r.rows) activeBx.add(String(x.id));
    } catch { /* оргструктура недоступна — «ушёл» не отмечаем */ for (const id of ownerBx) activeBx.add(id); }
  }
  const orphans: SavedOrphanRow[] = savedRows.map((s) => {
    const st = bySec.get(`sales/saved/${s.id}`);
    return {
      id: String(s.id), name: String(s.name), reportSlug: String(s.report_slug), owner: String(s.owner ?? s.user_login),
      ownerLeft: !!s.owner_bx && !activeBx.has(String(s.owner_bx)), shared: !!s.shared_section,
      createdAt: iso(s.created_at) ?? '', visits: st?.visits ?? 0, people: st?.people90 ?? 0, lastAt: st?.lastAt ?? null,
    };
  }).filter((o) => o.people === 0 || o.ownerLeft)
    .sort((a, b) => a.people - b.people || Number(b.ownerLeft) - Number(a.ownerLeft) || a.createdAt.localeCompare(b.createdAt));

  // ── параметры (подписи метрик — каталог; недоступен — id) ──
  const metricLabel = new Map<string, string>();
  if (metricRows.length) {
    try {
      const { loadMetrics } = await import('@/lib/metrics/catalog');
      for (const m of await loadMetrics()) metricLabel.set(m.id, m.nameShortRu || m.nameRu);
    } catch { /* без подписей */ }
  }
  const params: UsageParams = {
    loads: periodRows.reduce((s, r) => s + n(r.loads), 0),
    metrics: metricRows.map((r) => ({ id: String(r.id), label: metricLabel.get(String(r.id)) ?? String(r.id), loads: n(r.loads), people: n(r.people) })),
    groupings: groupRows.map((r) => ({ key: String(r.key), loads: n(r.loads) })),
    periodLength: periodRows.map((r) => ({ bucket: String(r.bucket), loads: n(r.loads) })),
    scopes: scopeRows.map((r) => ({ key: String(r.key), loads: n(r.loads) })),
  };

  const quality: QualityRow[] = qualityRows.map((r) => ({
    section: String(r.sec), label: labelOf(String(r.sec), savedName), loads: n(r.loads), withTiming: n(r.with_timing),
    slow: n(r.slow), empty: n(r.empty), withRows: n(r.with_rows), errors: n(r.errors), p50ms: r.p50 == null ? null : Math.round(n(r.p50)),
  })).sort((a, b) => (b.errors + b.slow + b.empty) - (a.errors + a.slow + a.empty) || b.loads - a.loads);

  const surfaces: SurfaceRow[] = surf.map((s) => ({
    surface: String(s.surface), visits: n(s.visits), bounceKnown: n(s.bounce_known), bounces: n(s.bounces), people: n(s.people),
    minutes: 0,
    worst: surfWorst.filter((w) => w.surface === s.surface)
      .map((w) => ({ section: String(w.sec), label: labelOf(String(w.sec), savedName), visits: n(w.visits), bounceKnown: n(w.bounce_known), bounces: n(w.bounces) }))
      .sort((a, b) => b.bounces / b.bounceKnown - a.bounces / a.bounceKnown || b.visits - a.visits).slice(0, 5),
  }));
  // Минуты по surface — по всем разделам (присутствие), не только отчётам.
  for (const m of await soft(db.query(
    `SELECT surface, count(*) * 5 AS minutes FROM activity_minutes WHERE source = 'mono' AND bucket >= $1 GROUP BY surface`, [since90]))) {
    const s = surfaces.find((x) => x.surface === m.surface);
    if (s) s.minutes = n(m.minutes);
    else surfaces.push({ surface: String(m.surface || '—'), visits: 0, bounceKnown: 0, bounces: 0, people: 0, minutes: n(m.minutes), worst: [] });
  }

  // ── changelog: увидели → открыли раздел за 7 дней → вернулись на второй неделе ──
  const changelog: ChangelogFunnelRow[] = [];
  for (const c of changelogRows) {
    const published = new Date(c.published_at as string);
    const section = (c.section as string | null) || null;
    const f = (await soft(db.query(
      `WITH seen AS (
         SELECT u.id FROM users u WHERE u.changelog_seen_at >= $1::timestamptz
         UNION
         SELECT user_id FROM activity_events WHERE action = 'changelog_open' AND ts >= $1::timestamptz AND user_id IS NOT NULL
           AND (payload->>'entry_id' IS NULL OR payload->>'entry_id' = $3::text)),
       v AS (
         SELECT user_id, ts FROM (
           SELECT user_id, ts, ${SECTION_SQL} AS sec FROM activity_events
            WHERE kind = 'mono_view' AND ts >= $1::timestamptz AND ts < $1::timestamptz + interval '14 days' AND user_id IS NOT NULL) x
          WHERE $2::text IS NOT NULL AND (sec = $2::text OR sec LIKE $2::text || '/%')),
       opened AS (
         SELECT DISTINCT v.user_id FROM v JOIN seen s ON s.id = v.user_id WHERE v.ts < $1::timestamptz + interval '7 days'),
       back AS (
         SELECT DISTINCT v.user_id FROM v JOIN opened o ON o.user_id = v.user_id WHERE v.ts >= $1::timestamptz + interval '7 days')
       SELECT (SELECT count(*) FROM seen) AS seen, (SELECT count(*) FROM opened) AS opened, (SELECT count(*) FROM back) AS back`,
      [published, section, String(c.id)])))[0] ?? {};
    changelog.push({
      id: String(c.id), title: String(c.title), publishedAt: published.toISOString(), section,
      seen: n(f.seen), opened7: n(f.opened), returnedW2: n(f.back), weekTwoDone: now - published.getTime() > 14 * 86400_000,
    });
  }

  const s0 = sinceRows[0] ?? {};
  const since: UsageDataSince = {
    journal: iso(s0.journal), viewDuration: iso(s0.view_duration), loadTiming: iso(s0.load_timing), loadRows: iso(s0.load_rows),
    metricIds: iso(s0.metric_ids), errors: iso(s0.errors), changelogSection: hasChangelogSection, changelogOpen: iso(s0.changelog_open),
  };

  return {
    generatedAt: new Date(now).toISOString(),
    since,
    reports,
    orphans,
    depth: depthOf(depthAll[0] ?? {}),
    depthByReport: depthSec.map((r) => ({ section: String(r.sec), label: labelOf(String(r.sec), savedName), ...depthOf(r) })),
    params,
    quality,
    surfaces,
    changelog,
  };
}
