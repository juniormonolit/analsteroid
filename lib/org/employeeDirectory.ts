// Единая точка получения ФИО/отдела сотрудника (задача 2820, находка проверки
// 2818 — owners-inbox/orgstructure-guide.md): `sa.employees`/`sa.teams`
// (заготовка ~13.06.2026) НИ РАЗУ не обновлялась (0 UPDATE/DELETE с создания)
// и не подключена ни к одному синку. На проверке 03.08 из 429 активных
// сотрудников 222 (52%) в ней вообще отсутствовали, а ещё у 112 из
// оставшихся 207 имя РАСХОДИЛОСЬ с текущим Bitrix (48 — другой реальный
// человек на том же слоте, 19 — Bitrix не заполнил ФИО, остальное —
// порядок слов/техническое). Раньше ~12 мест в коде копипастили
// `FROM sa.employees` каждое по-своему — теперь только это модуль.
//
// Источник — sa.org_resolved_hierarchy (ведёт ночной org-sync из Bitrix,
// см. lib/org/sync.ts): 1 строка = 1 занятый Bitrix-логин ("слот"),
// manager_name уже содержит фолбэк органа синка ('ФИО' | 'User <id>', см.
// lib/org/sync.ts коммент «Резолвер»). sa.employees и sa.teams НЕ удаляем —
// они не наши (могут читаться внешними системами, напр. разработчиком
// Никитой), просто больше не читаем.
//
// Слот-модель: то, что отдаёт этот модуль — ВСЕГДА текущее имя занимающего
// слот. Для истории (кто был кем на дату X) использовать sa.employee_name_history
// напрямую (SCD2, valid_from/valid_to) — см. пример в features/customers/engine/customers.ts.

import { analyticsDb } from '@/lib/db/clients';

export interface EmployeeDirectoryEntry {
  bitrixId: number;
  name: string;              // актуальное ФИО (или 'User <id>' — фолбэк org-sync, если Bitrix не задал имя)
  departmentName: string | null;
  branch: string | null;
  isActive: boolean;
}

let _dir: Map<number, EmployeeDirectoryEntry> | null = null;
let _dirAt = 0;
const DIR_TTL_MS = 30 * 60 * 1000; // тот же TTL, что у lib/org/deptCategories.ts::loadDepartments

/** Весь sa.org_resolved_hierarchy (активные и неактивные — 429+1 на 03.08),
 *  проиндексирован по bitrix_id. Кэш в памяти инстанса ~30 мин. */
export async function getEmployeeDirectory(force = false): Promise<Map<number, EmployeeDirectoryEntry>> {
  if (!force && _dir && Date.now() - _dirAt < DIR_TTL_MS) return _dir;
  const res = await analyticsDb().query<{
    manager_bitrix_user_id: string; manager_name: string;
    department_name: string | null; branch: string | null; is_active: boolean;
  }>(
    `SELECT manager_bitrix_user_id, manager_name, department_name, branch, is_active
       FROM sa.org_resolved_hierarchy`,
  );
  const byId = new Map<number, EmployeeDirectoryEntry>();
  for (const r of res.rows) {
    const id = Number(r.manager_bitrix_user_id);
    if (!Number.isFinite(id)) continue;
    byId.set(id, {
      bitrixId: id,
      name: r.manager_name,
      departmentName: r.department_name,
      branch: r.branch,
      isActive: r.is_active,
    });
  }
  _dir = byId;
  _dirAt = Date.now();
  return byId;
}

/** Для роутов, которые сами меняют данные (org-sync руками) и хотят гарантию
 *  свежести — сбрасывает кэш каталога. */
export function invalidateEmployeeDirectoryCache(): void { _dir = null; }

/** Активные сотрудники — замена ростер-циклов, раньше читавших
 *  `sa.employees WHERE is_active` (дайджест «Аналитик», квесты, список
 *  подписок и т.п.). */
export async function getActiveEmployeeRoster(): Promise<EmployeeDirectoryEntry[]> {
  const dir = await getEmployeeDirectory();
  return [...dir.values()].filter((e) => e.isActive);
}

/** Фолбэк для id, которых нет и в актуальной оргструктуре (уволен и
 *  полностью убран из Bitrix, либо технический bitrix_id, которого вообще
 *  не было в синке): последняя известная запись sa.employee_name_history
 *  (даже закрытая, valid_to не NULL), а если и там пусто — понятный
 *  плейсхолдер, не пустая строка. */
async function lastKnownNamesFromHistory(bitrixIds: number[]): Promise<Map<number, string>> {
  if (bitrixIds.length === 0) return new Map();
  const res = await analyticsDb().query<{ bitrix_user_id: string; name: string }>(
    `SELECT DISTINCT ON (bitrix_user_id) bitrix_user_id, name
       FROM sa.employee_name_history
      WHERE bitrix_user_id = ANY($1::text[])
      ORDER BY bitrix_user_id, valid_from DESC`,
    [bitrixIds.map(String)],
  );
  return new Map(res.rows.map((r) => [Number(r.bitrix_user_id), r.name]));
}

/** Bulk-резолв имён по списку bitrix_id (роуты вида «Исходящие»/«Обратная
 *  связь», выплаты, магазин — где раньше был `WHERE bitrix_id = ANY($1)` по
 *  sa.employees). Порядок фолбэка: актуальная оргструктура → последняя
 *  запись истории имён → 'Сотрудник #<id>'. */
export async function resolveEmployeeNames(bitrixIds: number[]): Promise<Map<number, string>> {
  const uniqIds = [...new Set(bitrixIds)];
  const dir = await getEmployeeDirectory();
  const out = new Map<number, string>();
  const missing: number[] = [];
  for (const id of uniqIds) {
    const hit = dir.get(id);
    if (hit) out.set(id, hit.name);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const fromHistory = await lastKnownNamesFromHistory(missing);
    for (const id of missing) out.set(id, fromHistory.get(id) ?? `Сотрудник #${id}`);
  }
  return out;
}

/** Одиночный резолв — обёртка над resolveEmployeeNames для точечных вызовов. */
export async function resolveEmployeeName(bitrixId: number): Promise<string> {
  const map = await resolveEmployeeNames([bitrixId]);
  return map.get(bitrixId) ?? `Сотрудник #${bitrixId}`;
}
