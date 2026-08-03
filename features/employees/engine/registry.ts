// Реестр сотрудников (задача 2654 Б): стаж и история переименований битрикс-логина.
//
// Модель данных (всё в аналитической БД sa, пул analyticsDb):
//  * sa.org_resolved_hierarchy — актуальная оргструктура (ведёт ночной org-sync из
//    Bitrix), источник ФИО/отдела (задача 2820, замена sa.employees — см. ниже);
//  * sa.employee_registry — ручная дата начала (manual_start_date) + заметки, пишем мы
//    (создана супер-юзером 31.07.2026, migrations/sa_org/002_employee_registry.sql);
//  * sa.employee_name_history — SCD2 имён на логине (создана в sa_org/001, ведёт
//    org-sync из Битрикса). Слот-модель: на одном bitrix_id люди меняются, история
//    нужна, чтобы потом разделять данные по людям.
//
// Детект переименований — ИСТОРИЧЕСКИ ОТКЛЮЧЁН (задача 2820, 03.08.2026): раньше
// сравнивал sa.employees.full_name с открытой строкой sa.employee_name_history для
// логинов ВНЕ оргструктуры (не покрытых org-sync). Источник (sa.employees) —
// заготовка ~13.06.2026, ни разу не обновлялась (0 UPDATE/DELETE с создания,
// owners-inbox/orgstructure-guide.md) — то есть НИКАКИХ новых «текущих» имён
// оттуда прийти уже не может, детект по конструкции инертен. sa.org_resolved_hierarchy
// покрывает практически всех живых Bitrix-логинов (429 активных на 03.08, включая
// технические — им тоже назначен department, просто null), поэтому «логинов вне
// оргструктуры» на практике не остаётся: их переименования и так ведёт org-sync
// напрямую. Функция оставлена (сигнатура и вызовы в instrumentation.ts/
// app/api/employees/route.ts не трогаем) как явный no-op, а не удалена — если
// когда-нибудь появится реальный источник «внешних» логинов, реализацию можно
// восстановить из git-истории (planRenameOps в ./tenure — чистая функция, не удалена).

import { getAllRopAndDirectorIds } from '@/lib/org/callControlScope';
import { analyticsDb } from '@/lib/db/clients';
export { planRenameOps, normalizeName, type RenameOp } from './tenure';

export interface DetectResult { seeded: number; renamed: number; skippedFlips: number; checkedAt: number }

export async function detectRenames(_force = false): Promise<DetectResult> {
  return { seeded: 0, renamed: 0, skippedFlips: 0, checkedAt: Date.now() };
}

// ---------- Список сотрудников для страницы ----------

export interface NameHistoryItem { name: string; validFrom: string; validTo: string | null }

export type EmployeeOrgRole = 'director' | 'rop' | 'manager';

export interface EmployeeListRow {
  bitrixId: number;
  fullName: string;
  departmentName: string | null;
  branch: string | null;
  isActive: boolean;
  hireDate: string | null;          // sa.employees больше не читаем (задача 2820) — всегда null,
                                     // осталось только для совместимости формы; стаж живёт на manualStartDate
  manualStartDate: string | null;   // sa.employee_registry — правится в UI
  startDate: string | null;         // COALESCE(manual, hire) — база стажа
  notes: string;
  updatedBy: string | null;
  updatedAt: string | null;
  nameHistory: NameHistoryItem[];   // SCD2 по возрастанию valid_from
  // Организационная роль (задача 2771) — из «Контроль звонков»
  // (org_resolved_hierarchy + call_control_recipient_overrides), НЕ путать с
  // ролью доступа приложения (Администратор/Пользователь и т.п., lib/auth/perms).
  // «Директор» приоритетнее «РОП», если оба назначения совпали (редкий случай).
  orgRole: EmployeeOrgRole;
}

export async function getEmployeesList(): Promise<EmployeeListRow[]> {
  const pool = analyticsDb();
  const [rows, hist, orgRoles] = await Promise.all([
    // Задача 2820: раньше водило sa.employees (211 строк, мёртвая заготовка
    // 13.06 — на проверке 03.08 отсутствовало 222 из 429 активных
    // сотрудников). Теперь водит sa.org_resolved_hierarchy — актуальная
    // оргструктура (ночной синк), hire_date там нет (в sa.employees он и так
    // не заполнялся на проде — см. features/employees/ui/EmployeesPage.tsx).
    pool.query(
      `SELECT org.manager_bitrix_user_id::int AS bitrix_id, org.manager_name AS full_name, org.is_active,
              NULL::date AS hire_date,
              to_char(r.manual_start_date, 'YYYY-MM-DD') AS manual_start_date,
              coalesce(r.notes, '') AS notes, r.updated_by,
              to_char(r.updated_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS updated_at,
              org.department_name, org.branch
         FROM sa.org_resolved_hierarchy org
         LEFT JOIN sa.employee_registry r ON r.bitrix_id = org.manager_bitrix_user_id::int
        ORDER BY org.manager_name`,
    ),
    pool.query(
      `SELECT bitrix_user_id, name,
              to_char(valid_from AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS valid_from,
              to_char(valid_to   AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS valid_to
         FROM sa.employee_name_history
        ORDER BY valid_from, id`,
    ),
    getAllRopAndDirectorIds(),
  ]);

  const histBy = new Map<string, NameHistoryItem[]>();
  for (const r of hist.rows) {
    const list = histBy.get(r.bitrix_user_id) ?? [];
    list.push({ name: r.name, validFrom: r.valid_from, validTo: r.valid_to });
    histBy.set(r.bitrix_user_id, list);
  }

  return rows.rows.map((r) => {
    const id = String(r.bitrix_id);
    const orgRole: EmployeeOrgRole = orgRoles.directorIds.has(id)
      ? 'director' : orgRoles.ropIds.has(id) ? 'rop' : 'manager';
    return {
      bitrixId: r.bitrix_id,
      fullName: r.full_name,
      departmentName: r.department_name ?? null,
      branch: r.branch ?? null,
      isActive: !!r.is_active,
      hireDate: r.hire_date ?? null,
      manualStartDate: r.manual_start_date ?? null,
      startDate: r.manual_start_date ?? r.hire_date ?? null,
      notes: r.notes,
      updatedBy: r.updated_by ?? null,
      updatedAt: r.updated_at ?? null,
      nameHistory: histBy.get(String(r.bitrix_id)) ?? [],
      orgRole,
    };
  });
}

// ---------- Реестр: upsert ручной даты/заметок ----------

export { validateManualStartDate, tenureLabel } from './tenure';

export async function upsertRegistry(
  bitrixId: number,
  patch: { manualStartDate?: string | null; notes?: string },
  updatedBy: string,
): Promise<void> {
  // DELETE junior_user сознательно не выдан — очистка даты идёт через UPDATE ... = NULL.
  await analyticsDb().query(
    `INSERT INTO sa.employee_registry (bitrix_id, manual_start_date, notes, updated_by, updated_at)
     VALUES ($1, $2, coalesce($3, ''), $4, now())
     ON CONFLICT (bitrix_id) DO UPDATE SET
       manual_start_date = CASE WHEN $5 THEN $2 ELSE sa.employee_registry.manual_start_date END,
       notes      = coalesce($3, sa.employee_registry.notes),
       updated_by = $4,
       updated_at = now()`,
    [
      bitrixId,
      patch.manualStartDate ?? null,
      patch.notes ?? null,
      updatedBy,
      patch.manualStartDate !== undefined, // менять дату только если поле пришло
    ],
  );
}
