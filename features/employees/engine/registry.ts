// Реестр сотрудников (задача 2654 Б): стаж и история переименований битрикс-логина.
//
// Модель данных (всё в аналитической БД sa, пул analyticsDb):
//  * sa.employees        — ведёт внешний синк, приложение ЧИТАЕТ и никогда не пишет;
//  * sa.employee_registry — ручная дата начала (manual_start_date) + заметки, пишем мы
//    (создана супер-юзером 31.07.2026, migrations/sa_org/002_employee_registry.sql);
//  * sa.employee_name_history — SCD2 имён на логине (создана в sa_org/001, ведёт и
//    org-sync из Битрикса, и наш детект ниже). Слот-модель: на одном bitrix_id люди
//    меняются, история нужна, чтобы потом разделять данные по людям.
//
// Детект переименований: сравниваем текущий sa.employees.full_name с открытой
// (valid_to IS NULL) строкой истории. Нет строки → сеем текущим именем БЕЗ события.
// Отличается → закрываем старую и открываем новую (это и есть событие переименования).
// Анти-пинг-понг: org-sync пишет имена из Битрикса, синк employees — свои; если они
// расходятся форматом, наивный детект зациклился бы A→B→A→B. Поэтому «переименование
// назад в только что закрытое имя» пропускаем (planRenameOps, kind='skip-flip').
// Запускается при обращении к странице (in-memory кэш ~6 ч) + суточным тиком в
// instrumentation.ts. Идемпотентно: повторный прогон без изменений имён = 0 операций.

import { analyticsDb } from '@/lib/db/clients';
import { planRenameOps } from './tenure';
export { planRenameOps, normalizeName, type RenameOp } from './tenure';

export interface DetectResult { seeded: number; renamed: number; skippedFlips: number; checkedAt: number }

let _lastDetect: DetectResult | null = null;
const DETECT_TTL_MS = 6 * 60 * 60 * 1000; // ~6 ч

export async function detectRenames(force = false): Promise<DetectResult> {
  if (!force && _lastDetect && Date.now() - _lastDetect.checkedAt < DETECT_TTL_MS) return _lastDetect;

  const pool = analyticsDb();
  const [emp, hist] = await Promise.all([
    pool.query<{ bitrix_id: number; full_name: string }>(
      `SELECT bitrix_id, full_name FROM sa.employees
        WHERE bitrix_id IS NOT NULL AND full_name IS NOT NULL AND full_name <> ''`,
    ),
    pool.query<{ bitrix_user_id: string; name: string; is_open: boolean; rn: number }>(
      // Для каждого логина: открытая строка (is_open) + последняя закрытая (rn=1 среди закрытых)
      `SELECT bitrix_user_id, name, (valid_to IS NULL) AS is_open,
              row_number() OVER (PARTITION BY bitrix_user_id, (valid_to IS NULL) ORDER BY valid_from DESC)::int AS rn
         FROM sa.employee_name_history`,
    ),
  ]);

  const current = new Map<string, string>();
  for (const r of emp.rows) current.set(String(r.bitrix_id), r.full_name);
  const openHistory = new Map<string, string>();
  const lastClosed = new Map<string, string>();
  for (const r of hist.rows) {
    if (r.is_open && r.rn === 1) openHistory.set(r.bitrix_user_id, r.name);
    if (!r.is_open && r.rn === 1) lastClosed.set(r.bitrix_user_id, r.name);
  }

  const ops = planRenameOps(current, openHistory, lastClosed);
  let seeded = 0; let renamed = 0; let skippedFlips = 0;

  const toApply = ops.filter(o => o.kind !== 'skip-flip');
  skippedFlips = ops.length - toApply.length;
  if (toApply.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const op of toApply) {
        if (op.kind === 'seed') {
          // Гонка с org-sync: строка могла появиться между чтением и записью — не дублируем.
          const ins = await client.query(
            `INSERT INTO sa.employee_name_history (bitrix_user_id, name, valid_from)
             SELECT $1, $2, now()
              WHERE NOT EXISTS (SELECT 1 FROM sa.employee_name_history
                                 WHERE bitrix_user_id = $1 AND valid_to IS NULL)`,
            [op.bitrixId, op.name],
          );
          seeded += ins.rowCount ?? 0;
        } else {
          const upd = await client.query(
            `UPDATE sa.employee_name_history SET valid_to = now()
              WHERE bitrix_user_id = $1 AND valid_to IS NULL AND name = $2`,
            [op.bitrixId, op.prevName],
          );
          if ((upd.rowCount ?? 0) > 0) {
            await client.query(
              `INSERT INTO sa.employee_name_history (bitrix_user_id, name, valid_from) VALUES ($1, $2, now())`,
              [op.bitrixId, op.name],
            );
            renamed++;
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  _lastDetect = { seeded, renamed, skippedFlips, checkedAt: Date.now() };
  return _lastDetect;
}

// ---------- Список сотрудников для страницы ----------

export interface NameHistoryItem { name: string; validFrom: string; validTo: string | null }

export interface EmployeeListRow {
  bitrixId: number;
  fullName: string;
  departmentName: string | null;
  branch: string | null;
  isActive: boolean;
  hireDate: string | null;          // sa.employees.hire_date (ISO date) — ведёт синк
  manualStartDate: string | null;   // sa.employee_registry — правится в UI
  startDate: string | null;         // COALESCE(manual, hire) — база стажа
  notes: string;
  updatedBy: string | null;
  updatedAt: string | null;
  nameHistory: NameHistoryItem[];   // SCD2 по возрастанию valid_from
}

export async function getEmployeesList(): Promise<EmployeeListRow[]> {
  const pool = analyticsDb();
  const [rows, hist] = await Promise.all([
    pool.query(
      `SELECT e.bitrix_id, e.full_name, e.is_active,
              to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date,
              to_char(r.manual_start_date, 'YYYY-MM-DD') AS manual_start_date,
              coalesce(r.notes, '') AS notes, r.updated_by,
              to_char(r.updated_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS updated_at,
              h.department_name, h.branch
         FROM sa.employees e
         LEFT JOIN sa.employee_registry r ON r.bitrix_id = e.bitrix_id
         LEFT JOIN sa.org_resolved_hierarchy h ON h.manager_bitrix_user_id = e.bitrix_id::text
        WHERE e.bitrix_id IS NOT NULL
        ORDER BY e.full_name`,
    ),
    pool.query(
      `SELECT bitrix_user_id, name,
              to_char(valid_from AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS valid_from,
              to_char(valid_to   AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS valid_to
         FROM sa.employee_name_history
        ORDER BY valid_from, id`,
    ),
  ]);

  const histBy = new Map<string, NameHistoryItem[]>();
  for (const r of hist.rows) {
    const list = histBy.get(r.bitrix_user_id) ?? [];
    list.push({ name: r.name, validFrom: r.valid_from, validTo: r.valid_to });
    histBy.set(r.bitrix_user_id, list);
  }

  return rows.rows.map((r) => ({
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
  }));
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
