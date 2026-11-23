// «Карта показателей» — срезы, периоды, снимки (таблица metric_map_snapshots, миграция 276).
//
// GET читает снимок; нет или устарел — считает на лету и кладёт. Снимок периода, который
// на момент расчёта уже закончился, вечен (до кнопки «Пересчитать»); снимок периода,
// захватывающего сегодня, живёт до конца суток МСК. Ночная задача (instrumentation.ts,
// ключ metricMapNightly) пересчитывает незакрытые снимки и дефолтные срезы компании.
import { addDays, addMonths, differenceInCalendarDays, format, parseISO, lastDayOfMonth } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { expandDepartmentSubtree } from '@/lib/org/sessionScope';
import { loadDepartments } from '@/lib/org/deptCategories';
import type { MapPeriod, MapScope, MapScopeType, MetricMapResponse } from '../types';
import { addAgg, clearAggCache, emptyAgg, fetchManagerAggs, type Agg } from './data';
import { computeMap } from './compute';
import { ROOT_ID } from './tree';

export const WINDOW_MONTHS = 3;
const MSK = 'Europe/Moscow';
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function mskToday(): string {
  return formatInTimeZone(new Date(), MSK, 'yyyy-MM-dd');
}

// ── Срез ─────────────────────────────────────────────────────────────────────

export interface ParsedScope { type: MapScopeType; id: string | null }

export function parseScope(raw: string | null): ParsedScope | null {
  const s = (raw ?? 'company').trim();
  if (s === 'company') return { type: 'company', id: null };
  const m = s.match(/^(department|manager|product_group):([A-Za-z0-9_-]{1,64})$/);
  if (!m) return null;
  if (m[1] === 'product_group' && !/^\d+$/.test(m[2])) return null;
  if (m[1] === 'manager' && !/^\d+$/.test(m[2])) return null;
  return { type: m[1] as MapScopeType, id: m[2] };
}

export const scopeKey = (s: ParsedScope) => (s.id === null ? s.type : `${s.type}:${s.id}`);

interface OrgRow { managerId: string; name: string; deptUuid: string | null }

let _org: { at: number; rows: OrgRow[] } | null = null;
async function loadOrg(): Promise<OrgRow[]> {
  if (_org && Date.now() - _org.at < 10 * 60 * 1000) return _org.rows;
  const res = await analyticsDb().query<{ manager_id: string; manager_name: string; department_id: string | null }>(
    `SELECT manager_bitrix_user_id::text AS manager_id, manager_name, department_id::text AS department_id
       FROM sa.org_resolved_hierarchy WHERE is_active = true`,
  );
  const rows = res.rows.map(r => ({ managerId: r.manager_id, name: r.manager_name, deptUuid: r.department_id }));
  _org = { at: Date.now(), rows };
  return rows;
}

/** Отдел по id из запроса: uuid sa.departments или bitrix_department_id → uuid. */
export async function resolveDeptUuid(id: string): Promise<string | null> {
  const { byId, byBitrixId } = await loadDepartments();
  if (byId.has(id)) return id;
  const row = byBitrixId.get(id);
  if (!row) return null;
  for (const [uuid, r] of byId) if (r === row) return uuid;
  return null;
}

interface ScopePlan {
  label: string;
  productGroupId?: number;
  /** null — все менеджеры (компания / товарная группа), иначе — набор bitrix id. */
  managers: Set<string> | null;
  /** Менеджеры «команды» для медиан. */
  team: Set<string>;
  singleManager: boolean;
}

async function planScope(s: ParsedScope): Promise<ScopePlan | { error: string }> {
  const org = await loadOrg();
  const allActive = new Set(org.map(o => o.managerId));
  if (s.type === 'company') return { label: 'Компания', managers: null, team: allActive, singleManager: false };
  if (s.type === 'product_group') {
    const pg = await analyticsDb().query<{ name: string }>('SELECT name FROM product_groups WHERE id = $1::int', [Number(s.id)]);
    return {
      label: pg.rows[0]?.name ?? `Группа #${s.id}`, productGroupId: Number(s.id),
      managers: null, team: allActive, singleManager: false,
    };
  }
  if (s.type === 'department') {
    const uuid = await resolveDeptUuid(s.id!);
    if (!uuid) return { error: 'Отдел не найден' };
    const subtree = await expandDepartmentSubtree([uuid]);
    const members = new Set(org.filter(o => o.deptUuid && subtree.has(o.deptUuid)).map(o => o.managerId));
    const { byId } = await loadDepartments();
    return { label: byId.get(uuid)?.name ?? 'Отдел', managers: members, team: members, singleManager: false };
  }
  // manager: команда — его отдел (точно), вне оргструктуры — вся компания
  const me = org.find(o => o.managerId === s.id);
  const team = me?.deptUuid ? new Set(org.filter(o => o.deptUuid === me.deptUuid).map(o => o.managerId)) : allActive;
  return { label: me?.name ?? `#${s.id}`, managers: new Set([s.id!]), team, singleManager: true };
}

function sumFor(rows: Map<string, Agg>, managers: Set<string> | null): Agg {
  const out = emptyAgg();
  for (const [id, a] of rows) if (!managers || managers.has(id)) addAgg(out, a);
  return out;
}

// ── Периоды ──────────────────────────────────────────────────────────────────

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

export function periodLabel(from: string, to: string): string {
  const f = parseISO(from), t = parseISO(to);
  if (from.slice(8) === '01' && format(lastDayOfMonth(f), 'yyyy-MM-dd') === to) return `${MONTHS[f.getMonth()]} ${f.getFullYear()}`;
  return `${format(f, 'dd.MM')}–${format(t, 'dd.MM.yyyy')}`;
}

/** Предыдущий период той же длины; целый месяц → предыдущий целый месяц. */
export function defaultCompare(from: string, to: string): [string, string] {
  const f = parseISO(from), t = parseISO(to);
  if (from.slice(8) === '01' && format(lastDayOfMonth(f), 'yyyy-MM-dd') === to) {
    const pf = addMonths(f, -1);
    return [format(pf, 'yyyy-MM-dd'), format(lastDayOfMonth(pf), 'yyyy-MM-dd')];
  }
  const len = differenceInCalendarDays(t, f) + 1;
  const ct = addDays(f, -1);
  return [format(addDays(ct, -(len - 1)), 'yyyy-MM-dd'), format(ct, 'yyyy-MM-dd')];
}

export interface MapRequest {
  scope: ParsedScope;
  from: string; to: string;
  compareFrom: string; compareTo: string;
}

export function validPeriod(from: string | null, to: string | null): boolean {
  return !!from && !!to && YMD_RE.test(from) && YMD_RE.test(to) && from <= to
    && !Number.isNaN(parseISO(from).getTime()) && !Number.isNaN(parseISO(to).getTime())
    && differenceInCalendarDays(parseISO(to), parseISO(from)) <= 366 * 2;
}

// ── Расчёт ───────────────────────────────────────────────────────────────────

export async function computeMetricMap(req: MapRequest): Promise<MetricMapResponse> {
  const plan = await planScope(req.scope);
  if ('error' in plan) throw new Error(plan.error);

  const windowFrom = format(addDays(addMonths(parseISO(req.to), -WINDOW_MONTHS), 1), 'yyyy-MM-dd');
  const pg = plan.productGroupId;
  const [cur, prev, win] = await Promise.all([
    fetchManagerAggs({ from: req.from, to: req.to, productGroupId: pg }),
    fetchManagerAggs({ from: req.compareFrom, to: req.compareTo, productGroupId: pg }),
    fetchManagerAggs({ from: windowFrom, to: req.to, productGroupId: pg }),
  ]);

  const periodDays = differenceInCalendarDays(parseISO(req.to), parseISO(req.from)) + 1;
  const windowDays = differenceInCalendarDays(parseISO(req.to), parseISO(windowFrom)) + 1;
  const teamWindow = [...plan.team].map(id => win.get(id)).filter((a): a is Agg => !!a);

  const out = computeMap({
    cur: sumFor(cur, plan.managers),
    prev: sumFor(prev, plan.managers),
    teamWindow,
    singleManager: plan.singleManager,
    periodToWindow: periodDays / windowDays,
  });

  const scope: MapScope = { type: req.scope.type, id: req.scope.id, label: plan.label };
  const period: MapPeriod = { from: req.from, to: req.to, label: periodLabel(req.from, req.to) };
  const comparePeriod: MapPeriod = { from: req.compareFrom, to: req.compareTo, label: periodLabel(req.compareFrom, req.compareTo) };
  return {
    rootId: ROOT_ID,
    nodes: out.nodes,
    values: out.values,
    scope, period, comparePeriod,
    residual: out.residual,
    computedAt: new Date().toISOString(),
    windowMonths: WINDOW_MONTHS,
  };
}

// ── Снимки ───────────────────────────────────────────────────────────────────

function snapshotFresh(periodTo: string, computedAt: Date): boolean {
  const computedDay = formatInTimeZone(computedAt, MSK, 'yyyy-MM-dd');
  return periodTo < computedDay || computedDay === mskToday();
}

async function saveSnapshot(req: MapRequest, data: MetricMapResponse): Promise<void> {
  await systemDb().query(
    `INSERT INTO metric_map_snapshots (scope_key, period_from, period_to, compare_from, compare_to, payload, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (scope_key, period_from, period_to, compare_from, compare_to)
     DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at`,
    [scopeKey(req.scope), req.from, req.to, req.compareFrom, req.compareTo, JSON.stringify(data), data.computedAt],
  );
}

export async function getMetricMap(req: MapRequest): Promise<MetricMapResponse> {
  try {
    const r = await systemDb().query<{ payload: MetricMapResponse; computed_at: Date }>(
      `SELECT payload, computed_at FROM metric_map_snapshots
        WHERE scope_key = $1 AND period_from = $2 AND period_to = $3 AND compare_from = $4 AND compare_to = $5`,
      [scopeKey(req.scope), req.from, req.to, req.compareFrom, req.compareTo],
    );
    const row = r.rows[0];
    if (row && snapshotFresh(req.to, new Date(row.computed_at))) return row.payload;
  } catch (err) {
    // Таблицы ещё нет (миграция не накатана) — считаем без снимка, раздел не роняем.
    console.warn('[metric-map] снимок недоступен:', err instanceof Error ? err.message : err);
  }
  const data = await computeMetricMap(req);
  await saveSnapshot(req, data).catch(err =>
    console.warn('[metric-map] снимок не сохранён:', err instanceof Error ? err.message : err));
  return data;
}

/** Дефолтные срезы ночного пересчёта: компания за текущий месяц (по сегодня) и прошлый месяц. */
function defaultRequests(): MapRequest[] {
  const today = mskToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const prevFrom = format(addMonths(parseISO(monthStart), -1), 'yyyy-MM-dd');
  const prevTo = format(lastDayOfMonth(parseISO(prevFrom)), 'yyyy-MM-dd');
  const company: ParsedScope = { type: 'company', id: null };
  return [
    [monthStart, format(lastDayOfMonth(parseISO(monthStart)), 'yyyy-MM-dd')],
    [monthStart, today],
    [prevFrom, prevTo],
  ].map(([from, to]) => {
    const [compareFrom, compareTo] = defaultCompare(from, to);
    return { scope: company, from, to, compareFrom, compareTo };
  });
}

let _running: Promise<{ computedAt: string; count: number }> | null = null;

/**
 * Пересчёт: дефолтные срезы + все снимки незакрытых периодов (to ≥ вчера) — их ключи
 * берутся из таблицы, т.е. ровно то, что люди открывали. full=true (кнопка) — ещё и
 * сбрасывает остальные снимки, они пересчитаются при следующем открытии.
 */
export async function recomputeMetricMaps(full: boolean): Promise<{ computedAt: string; count: number }> {
  if (_running) return _running;
  _running = (async () => {
    clearAggCache();
    _org = null;
    const yesterday = format(addDays(parseISO(mskToday()), -1), 'yyyy-MM-dd');
    const reqs = new Map<string, MapRequest>();
    const keyOf = (r: MapRequest) => [scopeKey(r.scope), r.from, r.to, r.compareFrom, r.compareTo].join('|');
    for (const r of defaultRequests()) reqs.set(keyOf(r), r);
    try {
      const rows = await systemDb().query<{ scope_key: string; f: string; t: string; cf: string; ct: string }>(
        `SELECT scope_key, period_from::text AS f, period_to::text AS t, compare_from::text AS cf, compare_to::text AS ct
           FROM metric_map_snapshots WHERE period_to >= $1::date`,
        [yesterday],
      );
      for (const row of rows.rows) {
        const scope = parseScope(row.scope_key);
        if (!scope) continue;
        const r = { scope, from: row.f, to: row.t, compareFrom: row.cf, compareTo: row.ct };
        reqs.set(keyOf(r), r);
      }
      if (full) await systemDb().query('DELETE FROM metric_map_snapshots WHERE period_to < $1::date', [yesterday]);
    } catch (err) {
      console.warn('[metric-map] таблица снимков недоступна:', err instanceof Error ? err.message : err);
    }
    let count = 0;
    for (const r of reqs.values()) {
      try {
        const data = await computeMetricMap(r);
        await saveSnapshot(r, data);
        count++;
      } catch (err) {
        console.warn(`[metric-map] срез ${scopeKey(r.scope)} ${r.from}..${r.to} не пересчитан:`, err instanceof Error ? err.message : err);
      }
    }
    return { computedAt: new Date().toISOString(), count };
  })();
  try { return await _running; } finally { _running = null; }
}
