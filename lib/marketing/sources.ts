import { systemDb } from '@/lib/db/clients';
import { UNDEFINED_LABEL, NO_SOURCE_LABEL, type SourceDimension } from './dimensions';

export { UNDEFINED_LABEL, NO_SOURCE_LABEL };
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

/** Значение измерения для источника (label группы в отчёте). */
export function dimensionValue(info: SourceInfo | undefined, dim: SourceDimension): string {
  if (!info) return UNDEFINED_LABEL; // source_id есть в deals, но нет в справочнике
  if (dim === 'source') return info.name || info.source_id;
  return info[dim] ?? UNDEFINED_LABEL;
}

/** source_id'ы, попадающие в значение измерения (для фильтров WHERE/дрилл-даунов). */
export async function resolveSourceIds(dim: SourceDimension, value: string): Promise<string[] | 'null'> {
  if (value === NO_SOURCE_LABEL || value === '__null__') return 'null'; // сделки без source_id
  const map = await loadSourceMap();
  if (dim === 'source') {
    // value = source_id
    return map.has(value) ? [value] : [];
  }
  const ids: string[] = [];
  for (const info of map.values()) {
    if ((info[dim] ?? UNDEFINED_LABEL) === value) ids.push(info.source_id);
  }
  return ids;
}

/** SQL-условие по source_id (текстовые id инлайним с экранированием кавычек). */
export function sourceIdsWhere(ids: string[] | 'null'): string {
  if (ids === 'null') return 'd.source_id IS NULL';
  if (ids.length === 0) return '1=0';
  const quoted = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  return `d.source_id IN (${quoted})`;
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

export interface ManagerInfo { name: string; login: string | null; branch: string; department: string | null }

let _mgrInfo: Map<string, ManagerInfo> | null = null;
let _mgrInfoAt = 0;

export async function loadManagerInfoMap(): Promise<Map<string, ManagerInfo>> {
  if (_mgrInfo && Date.now() - _mgrInfoAt < TTL) return _mgrInfo;
  const res = await systemDb().query<{ id: string; name: string; branch: string | null; short_login: string | null; department_name: string | null }>(
    `SELECT manager_bitrix_user_id::text AS id, manager_name AS name, branch, short_login, department_name
       FROM org_resolved_hierarchy WHERE is_active = true`,
  );
  _mgrInfo = new Map(res.rows.map(r => [r.id, {
    name: r.name,
    login: r.short_login,
    branch: r.branch ?? deriveBranchFromLogin(r.short_login),
    department: r.department_name,
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
