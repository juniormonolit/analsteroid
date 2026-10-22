// Общие справочники для инструментов MCP (lib/mcp/tools.ts): оргструктура в срезе сессии,
// товарные группы и словарь сленга, разбор периода. Ничего не считают сами — только
// переводят слова человека («газик», «Москва», «отдел Петрова») в параметры движков отчётов.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { branchLabel } from '@/lib/org/branchLabel';
import { loadDepartments } from '@/lib/org/deptCategories';
import type { SessionScope } from '@/lib/org/sessionScope';
import type { DateRange } from '@/lib/period';

// ── Период ─────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

export class ToolInputError extends Error {}

/** Конвенция lib/period: Date = МСК-календарь в локальном времени сервера, полночь без 'Z'
 *  (fetchByManagers сам делает addDays(startOfDay(to), 1)). */
export function parsePeriod(from: string, to: string): DateRange {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new ToolInputError('Даты периода — в формате YYYY-MM-DD');
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new ToolInputError('Некорректная дата периода');
  if (t < f) throw new ToolInputError('Конец периода раньше начала');
  if ((t.getTime() - f.getTime()) / 86_400_000 > MAX_DAYS) throw new ToolInputError(`Период длиннее ${MAX_DAYS} дней — разбейте на части`);
  return { from: f, to: t };
}

// ── Оргструктура ───────────────────────────────────────────────────────────────────

export interface OrgManager {
  managerId: string;
  name: string;
  login: string | null;
  departmentUuid: string | null;
  department: string | null;
  branch: string | null;
}

export async function loadOrg(): Promise<Map<string, OrgManager>> {
  const r = await analyticsDb().query<{
    manager_id: string; name: string; login: string | null; department_id: string | null; department: string | null; branch: string | null;
  }>(
    `SELECT manager_bitrix_user_id::text AS manager_id, manager_name AS name, short_login AS login,
            department_id::text AS department_id, department_name AS department, branch
       FROM sa.org_resolved_hierarchy
      WHERE is_active = true AND manager_bitrix_user_id IS NOT NULL`,
  );
  return new Map(r.rows.map(row => [row.manager_id, {
    managerId: row.manager_id,
    name: row.name,
    login: row.login,
    departmentUuid: row.department_id,
    department: row.department,
    // Правило проекта: не Москва и не Краснодар → СПб (как в entities.ts/grouping.ts).
    branch: branchLabel(row.branch ?? 'СПб') || null,
  }]));
}

export function visibleManagers(org: Map<string, OrgManager>, scope: SessionScope): OrgManager[] {
  if (scope.kind === 'all') return [...org.values()];
  return [...org.values()].filter(m => scope.managerIds.has(m.managerId));
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Менеджеры по словам: имя/фамилия/логин/bitrix id. Только видимые сессии. */
export function findManagers(managers: OrgManager[], query: string): OrgManager[] {
  const q = norm(query);
  if (!q) return [];
  const exact = managers.filter(m => m.managerId === q || (m.login && norm(m.login) === q));
  if (exact.length) return exact;
  const words = q.split(' ');
  return managers.filter(m => {
    const hay = norm(`${m.name} ${m.login ?? ''}`);
    return words.every(w => hay.includes(w));
  });
}

/** Отделы по названию → bitrix_department_id (формат фильтра движков отчётов). */
export async function findDepartments(query: string): Promise<{ uuid: string; bitrixId: string; name: string }[]> {
  const { byId } = await loadDepartments();
  const q = norm(query);
  const all = [...byId].map(([uuid, d]) => ({ uuid, bitrixId: String(d.bitrixId), name: d.name }));
  const exact = all.filter(d => norm(d.name) === q);
  if (exact.length) return exact;
  return all.filter(d => norm(d.name).includes(q));
}

// ── Товарные группы и словарь ──────────────────────────────────────────────────────

export interface GlossaryEntry {
  term: string;
  kind: 'product' | 'term';
  meaning: string;
  headGroup: string | null;
  kcGroups: string[];
}

export async function loadGlossary(): Promise<GlossaryEntry[]> {
  try {
    const r = await systemDb().query<{ term: string; kind: 'product' | 'term'; meaning: string; head_group: string | null; kc_groups: string[] | null }>(
      `SELECT term, kind, meaning, head_group, kc_groups FROM mcp_glossary ORDER BY term`,
    );
    return r.rows.map(x => ({ term: x.term, kind: x.kind, meaning: x.meaning, headGroup: x.head_group, kcGroups: x.kc_groups ?? [] }));
  } catch {
    return []; // таблицы нет до миграции 246 — инструменты работают без словаря
  }
}

export interface KcGroup { id: string; name: string }

export async function loadKcGroups(): Promise<KcGroup[]> {
  const r = await analyticsDb().query<{ id: number; name: string }>(
    `SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`,
  );
  return r.rows.map(x => ({ id: String(x.id), name: x.name }));
}

export interface ProductGroupMatch {
  /** Как поняли слово человека — показывать в ответе, чтобы ошибку было видно. */
  understoodAs: string;
  via: 'glossary' | 'name';
  kcGroups: KcGroup[];
}

/** «газик» → [Газобетон]. Сначала словарь (точное совпадение), потом подстрока в названиях
 *  групп КЦ. null — ничего не нашли (модель должна переспросить, а не угадывать). */
export async function resolveProductGroup(text: string): Promise<ProductGroupMatch | null> {
  const q = norm(text);
  if (!q) return null;
  const [glossary, kc] = await Promise.all([loadGlossary(), loadKcGroups()]);
  const byName = new Map(kc.map(g => [norm(g.name), g]));

  const g = glossary.find(e => e.kind === 'product' && norm(e.term) === q);
  if (g) {
    const groups = g.kcGroups.map(n => byName.get(norm(n))).filter((x): x is KcGroup => !!x);
    if (groups.length) return { understoodAs: g.meaning, via: 'glossary', kcGroups: groups };
  }
  const exact = byName.get(q);
  if (exact) return { understoodAs: exact.name, via: 'name', kcGroups: [exact] };
  // Подстрока по основе слова: «газобетона» → «газобетон».
  const stem = q.length > 5 ? q.slice(0, q.length - 2) : q;
  const partial = kc.filter(x => norm(x.name).includes(stem));
  if (partial.length) return { understoodAs: partial.map(p => p.name).join(', '), via: 'name', kcGroups: partial };
  return null;
}
