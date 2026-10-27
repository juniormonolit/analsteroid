import { analyticsDb, systemDb } from '@/lib/db/clients';
import {
  UNDEFINED_LABEL, NO_SOURCE_LABEL, UNASSIGNED_LABEL, isCustomDimension, customDimensionId,
  type SourceDimension, type BuiltinSourceDimension,
} from './dimensions';
import { loadGroupings, canonicalDimension } from './groupings';

export { UNDEFINED_LABEL, NO_SOURCE_LABEL, UNASSIGNED_LABEL };
export type { SourceDimension, DrilldownDimension } from './dimensions';

export interface SourceInfo {
  source_id: string;
  name: string;
  category: string;
  contact_type: string | null;
  branch: string | null;
  platform: string | null;
  brand: string | null;
  ad_channel: string | null;
  channel_group: string | null;
}

let _cache: Map<string, SourceInfo> | null = null;

export function invalidateSourceMap(): void {
  _cache = null;
}
let _cacheAt = 0;
const TTL = 10 * 60 * 1000;

export async function loadSourceMap(): Promise<Map<string, SourceInfo>> {
  if (_cache && Date.now() - _cacheAt < TTL) return _cache;
  const res = await systemDb().query<SourceInfo>(
    `SELECT source_id, name, category, contact_type, branch, platform, brand, ad_channel, channel_group
       FROM marketing_sources`,
  );
  _cache = new Map(res.rows.map(r => [r.source_id, r]));
  _cacheAt = Date.now();
  return _cache;
}

/** Значение встроенного измерения для источника (label группы в отчёте). */
export function dimensionValue(info: SourceInfo | undefined, dim: BuiltinSourceDimension): string {
  if (!info) return UNDEFINED_LABEL; // source_id есть в deals, но нет в справочнике
  if (dim === 'source') return info.name || info.source_id;
  return info[dim] ?? UNDEFINED_LABEL;
}

/**
 * source_id → label группы для любого измерения, включая пользовательские группировки
 * (`g:<id>`). Источник, не разложенный в группировке, — «Не распределено».
 */
export async function loadDimensionResolver(rawDim: Exclude<SourceDimension, 'branch'>): Promise<(sourceId: string) => string> {
  const dim = await canonicalDimension(rawDim);
  if (isCustomDimension(dim)) {
    const g = (await loadGroupings()).get(customDimensionId(dim));
    if (!g) return () => UNASSIGNED_LABEL;
    const names = new Map(g.groups.map(x => [x.id, x.name]));
    return (sid) => {
      const gid = g.assign.get(sid);
      return gid !== undefined ? (names.get(gid) ?? UNASSIGNED_LABEL) : UNASSIGNED_LABEL;
    };
  }
  const map = await loadSourceMap();
  return (sid) => dimensionValue(map.get(sid), dim);
}

/**
 * Набор source_id значения измерения: список, «сделки без source_id» ('null') или
 * «все непустые, кроме перечисленных» (exclude) — так выражается «Не распределено»
 * пользовательской группировки, куда попадают и источники, которых нет в справочнике.
 */
export type SourceIdSet = string[] | 'null' | { exclude: string[] };

/** source_id'ы, попадающие в значение измерения (для фильтров WHERE/дрилл-даунов). */
export async function resolveSourceIds(rawDim: SourceDimension, value: string): Promise<SourceIdSet> {
  if (value === NO_SOURCE_LABEL || value === '__null__') return 'null'; // сделки без source_id
  const dim = await canonicalDimension(rawDim);
  if (isCustomDimension(dim)) {
    const g = (await loadGroupings()).get(customDimensionId(dim));
    if (!g) return value === UNASSIGNED_LABEL ? { exclude: [] } : [];
    if (value === UNASSIGNED_LABEL) {
      // Разложенные в существующие группы — исключаем; остальное (вкл. неизвестные id) — сюда.
      const live = new Set(g.groups.map(x => x.id));
      return { exclude: [...g.assign].filter(([, gid]) => live.has(gid)).map(([sid]) => sid) };
    }
    const grp = g.groups.find(x => x.name === value);
    if (!grp) return [];
    return [...g.assign].filter(([, gid]) => gid === grp.id).map(([sid]) => sid);
  }
  const map = await loadSourceMap();
  if (dim === 'source') {
    // value = source_id
    return map.has(value) ? [value] : [];
  }
  const ids: string[] = [];
  for (const info of map.values()) {
    if ((info[dim as Exclude<BuiltinSourceDimension, 'source'>] ?? UNDEFINED_LABEL) === value) ids.push(info.source_id);
  }
  return ids;
}

function quoteIds(ids: string[]): string {
  return ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
}

/** SQL-условие по source_id (текстовые id инлайним с экранированием кавычек). */
export function sourceIdsWhere(ids: SourceIdSet): string {
  if (ids === 'null') return 'd.source_id IS NULL';
  if (!Array.isArray(ids)) {
    return ids.exclude.length === 0
      ? 'd.source_id IS NOT NULL'
      : `(d.source_id IS NOT NULL AND d.source_id NOT IN (${quoteIds(ids.exclude)}))`;
  }
  if (ids.length === 0) return '1=0';
  return `d.source_id IN (${quoteIds(ids)})`;
}

/** То же условие в памяти: rid — source_id или '__null__' для сделок без источника. */
export function sourceIdMatcher(ids: SourceIdSet): (rid: string) => boolean {
  if (ids === 'null') return rid => rid === '__null__';
  if (!Array.isArray(ids)) {
    const ex = new Set(ids.exclude);
    return rid => rid !== '__null__' && !ex.has(rid);
  }
  const set = new Set(ids);
  return rid => set.has(rid);
}

// ── Филиал менеджера ─────────────────────────────────────────────────────────
// «Кол-во сделок по филиалу» считается через менеджера сделки, не через гео источника.
// Приоритет: колонка branch (миграция 039) → правило по логину (фолбэк для новых
// сотрудников из синка оргструктуры): 3+ значные логины — первая цифра
// 1→СПб, 2→Москва, 3→Краснодар, 4→Екатеринбург; короткие — СПб.

export function deriveBranchFromLogin(shortLogin: string | null): string {
  const digits = (shortLogin ?? '').replace(/\D/g, '');
  if (!digits || digits.length <= 2) return 'СПб';
  if (digits.startsWith('2')) return 'Москва/МО';
  if (digits.startsWith('3')) return 'Краснодар';
  if (digits.startsWith('4')) return 'Екатеринбург';
  return 'СПб';
}

// department/departmentId — тот же источник (sa.org_resolved_hierarchy.department_name/
// department_id), что и teamName/teamId в ReportRow (byManagers.ts) — добавлены задачей
// #2385, чтобы drill-down список сделок мог группировать «По отделу» тем же ключом,
// что и верхний уровень отчёта (без дублирования запроса к оргструктуре).
export interface ManagerInfo { name: string; login: string | null; branch: string; department: string | null; departmentId: string | null }

let _mgrInfo: Map<string, ManagerInfo> | null = null;
let _mgrInfoAt = 0;

export async function loadManagerInfoMap(): Promise<Map<string, ManagerInfo>> {
  if (_mgrInfo && Date.now() - _mgrInfoAt < TTL) return _mgrInfo;
  // Оргструктура переехала в sa (задача Серёги 13.07): читаем из analyticsDb.
  const res = await analyticsDb().query<{ id: string; name: string; branch: string | null; short_login: string | null; department_name: string | null; department_id: string | null }>(
    `SELECT manager_bitrix_user_id::text AS id, manager_name AS name, branch, short_login, department_name, department_id::text AS department_id
       FROM sa.org_resolved_hierarchy WHERE is_active = true`,
  );
  _mgrInfo = new Map(res.rows.map(r => [r.id, {
    name: r.name,
    login: r.short_login,
    branch: r.branch ?? deriveBranchFromLogin(r.short_login),
    department: r.department_name,
    departmentId: r.department_id,
  }]));
  _mgrInfoAt = Date.now();
  return _mgrInfo;
}

export async function loadManagerBranchMap(): Promise<Map<string, string>> {
  const info = await loadManagerInfoMap();
  return new Map([...info].map(([id, i]) => [id, i.branch]));
}

/** Bitrix user id'ы менеджеров филиала (числовые, безопасны для инлайна в SQL). */
export async function resolveBranchManagerIds(value: string): Promise<string[]> {
  const map = await loadManagerBranchMap();
  const ids: string[] = [];
  for (const [id, br] of map) {
    if (br === value && /^\d+$/.test(id)) ids.push(id);
  }
  return ids;
}

export function managerIdsWhere(ids: string[]): string {
  if (ids.length === 0) return '1=0';
  return `d.current_manager_id IN (${ids.join(',')})`;
}

/**
 * Bitrix user id'ы менеджеров отделов отчёта (bitrix_department_id, как departmentIds в
 * /api/reports/run) — фильтр «Отделы» маркетинговых отчётов режет сделки по менеджеру сделки.
 */
export async function resolveDeptManagerIds(bitrixDeptIds: string[]): Promise<string[]> {
  if (bitrixDeptIds.length === 0) return [];
  const res = await analyticsDb().query<{ id: string }>(
    `SELECT DISTINCT manager_bitrix_user_id::text AS id
       FROM sa.org_resolved_hierarchy
      WHERE department_id IN (SELECT id FROM sa.departments WHERE bitrix_department_id::text = ANY($1::text[]))
        AND is_active = true`,
    [bitrixDeptIds],
  );
  return res.rows.map(r => r.id).filter(id => /^\d+$/.test(id));
}

/** Менеджеры одного отдела по его uuid (teamId строк отчёта, как в byManagers). */
export async function resolveTeamManagerIds(teamId: string): Promise<string[]> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)) return [];
  const res = await analyticsDb().query<{ id: string }>(
    `SELECT manager_bitrix_user_id::text AS id FROM sa.org_resolved_hierarchy
      WHERE department_id = $1::uuid AND is_active = true`,
    [teamId],
  );
  return res.rows.map(r => r.id).filter(id => /^\d+$/.test(id));
}

/**
 * Строка маркетингового отчёта в разбивке по отделам: «значение измерения @@ отдел».
 * Дрилл и список сделок разбирают id обратно через splitSourceRowId.
 */
export { SOURCE_TEAM_SEP, splitSourceRowId } from './dimensions';

