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
import { loadPersonSegments } from './segments';
import { resolveTenure } from './personSegment';
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
  manualStartDate: string | null;   // sa.employee_registry — правится в UI (как есть, даже устаревшая)
  manualStartName: string | null;   // ФИО, при котором внесена ручная дата (задача 11110)
  startDate: string | null;         // действующая дата начала: ручная, если поставлена при текущем ФИО
  // Задача 11110: учётка = слот, стаж — по человеку.
  manualStale: boolean;             // ручная дата есть, но от предыдущего человека
  vacant: boolean;                  // на учётке заглушка (managerN, User N…)
  personSince: string | null;       // начало отрезка текущего ФИО/вакансии (МСК), если известно
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
  const [rows, segs, orgRoles] = await Promise.all([
    // Задача 2820: раньше водило sa.employees (211 строк, мёртвая заготовка
    // 13.06 — на проверке 03.08 отсутствовало 222 из 429 активных
    // сотрудников). Теперь водит sa.org_resolved_hierarchy — актуальная
    // оргструктура (ночной синк), hire_date там нет (в sa.employees он и так
    // не заполнялся на проде — см. features/employees/ui/EmployeesPage.tsx).
    pool.query(
      `SELECT org.manager_bitrix_user_id::int AS bitrix_id, org.manager_name AS full_name, org.is_active,
              NULL::date AS hire_date,
              to_char(r.manual_start_date, 'YYYY-MM-DD') AS manual_start_date,
              -- to_jsonb: не падаем, пока миграция sa_org/009 не накатана
              to_jsonb(r) ->> 'manual_start_name' AS manual_start_name,
              coalesce(r.notes, '') AS notes, r.updated_by,
              to_char(r.updated_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS updated_at,
              org.department_name, org.branch
         FROM sa.org_resolved_hierarchy org
         LEFT JOIN sa.employee_registry r ON r.bitrix_id = org.manager_bitrix_user_id::int
        ORDER BY org.manager_name`,
    ),
    loadPersonSegments(),
    getAllRopAndDirectorIds(),
  ]);

  // История для раскрывашки — даты МСК, как раньше.
  const toMsk = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });

  return rows.rows.map((r) => {
    const id = String(r.bitrix_id);
    const seg = segs.byId.get(id) ?? null;
    // Реестр: без фолбэка на начало отрезка — устаревшая/пустая дата = «не заполнено»,
    // РОП видит подсказку и проставляет руками.
    const t = resolveTenure(r.manual_start_date ?? null, r.manual_start_name ?? null, seg, false);
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
      manualStartName: r.manual_start_name ?? null,
      startDate: t.startDate,
      manualStale: t.manualStale,
      vacant: t.vacant,
      personSince: seg && (seg.knownStart || seg.vacant) ? seg.startDate : null,
      notes: r.notes,
      updatedBy: r.updated_by ?? null,
      updatedAt: r.updated_at ?? null,
      nameHistory: (segs.historyById.get(id) ?? []).map(h => ({
        name: h.name, validFrom: toMsk(h.validFrom), validTo: h.validTo ? toMsk(h.validTo) : null,
      })),
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
  // Задача 11110: вместе с датой запоминаем ФИО, при котором её поставили
  // (текущее открытое имя в sa.employee_name_history; нет истории — имя из оргструктуры).
  const params = [
    bitrixId,
    patch.manualStartDate ?? null,
    patch.notes ?? null,
    updatedBy,
    patch.manualStartDate !== undefined, // менять дату только если поле пришло
  ];
  try {
    await analyticsDb().query(
      `INSERT INTO sa.employee_registry (bitrix_id, manual_start_date, manual_start_name, notes, updated_by, updated_at)
       VALUES ($1, $2, CASE WHEN $2::date IS NULL THEN NULL ELSE (
                 coalesce((SELECT name FROM sa.employee_name_history WHERE bitrix_user_id = $1::text AND valid_to IS NULL
                            ORDER BY valid_from DESC LIMIT 1),
                          (SELECT manager_name FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id::int = $1))) END,
               coalesce($3, ''), $4, now())
       ON CONFLICT (bitrix_id) DO UPDATE SET
         manual_start_date = CASE WHEN $5 THEN $2 ELSE sa.employee_registry.manual_start_date END,
         manual_start_name = CASE WHEN $5 THEN EXCLUDED.manual_start_name ELSE sa.employee_registry.manual_start_name END,
         notes      = coalesce($3, sa.employee_registry.notes),
         updated_by = $4,
         updated_at = now()`,
      params,
    );
  } catch (e) {
    // 42703 = колонки manual_start_name ещё нет (миграция sa_org/009 не накатана) —
    // пишем по-старому, без ФИО.
    if ((e as { code?: string }).code !== '42703') throw e;
    await analyticsDb().query(
      `INSERT INTO sa.employee_registry (bitrix_id, manual_start_date, notes, updated_by, updated_at)
       VALUES ($1, $2, coalesce($3, ''), $4, now())
       ON CONFLICT (bitrix_id) DO UPDATE SET
         manual_start_date = CASE WHEN $5 THEN $2 ELSE sa.employee_registry.manual_start_date END,
         notes      = coalesce($3, sa.employee_registry.notes),
         updated_by = $4,
         updated_at = now()`,
      params,
    );
  }
}
