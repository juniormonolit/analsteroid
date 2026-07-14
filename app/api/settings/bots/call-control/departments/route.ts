import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// Получатели эскалации по отделам: оргструктура (РОП/директор департамента) +
// ручные переопределения (call_control_recipient_overrides, миграция 100).
// GET — таблица для админки; PUT — назначить/сбросить переопределение.
//
// Оргструктура (departments / org_resolved_hierarchy) переехала в sa 13.07 —
// читаем её из analyticsDb (sa), как раздел «Оргструктура». Таблица переопределений
// call_control_recipient_overrides живёт в system(YC), поэтому джойн через один SQL
// невозможен: тянем оргданные из sa и оверрайды из YC отдельными запросами и
// склеиваем в JS. department_id — uuid, стабилен по bitrix_department_id (см.
// lib/org/sync.ts), поэтому ключи sa совпадают с уже сохранёнными в YC оверрайдами.

export async function GET() {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const sa = analyticsDb();
  const sys = systemDb();

  // 1. Оргструктура из sa. Только поддерево «Отдел продаж» (правка Иосифа 14.07):
  // HR/маркетинг/логистика и прочие ветки в таблицу получателей не попадают.
  const orgRes = await sa.query(
    `WITH RECURSIVE sales_tree AS (
       SELECT id, bitrix_department_id
       FROM sa.departments
       WHERE name = 'Отдел продаж' AND is_active
       UNION ALL
       SELECT d.id, d.bitrix_department_id
       FROM sa.departments d
       JOIN sales_tree s ON d.parent_bitrix_department_id = s.bitrix_department_id
       WHERE d.is_active
     )
     SELECT DISTINCT ON (department_id)
       department_id, department_name,
       rop_bitrix_user_id, rop_name,
       department_director_bitrix_user_id, department_director_name
     FROM sa.org_resolved_hierarchy
     WHERE is_active AND department_id IS NOT NULL
       AND department_id IN (SELECT id FROM sales_tree)
     ORDER BY department_id, rop_bitrix_user_id NULLS LAST, department_director_bitrix_user_id NULLS LAST`
  );

  // 2. Ручные переопределения из system(YC).
  const ovRes = await sys.query(
    `SELECT department_id, role, bitrix_user_id FROM call_control_recipient_overrides`
  );
  const overrideByKey = new Map<string, string>(
    ovRes.rows.map((r) => [`${r.department_id}:${r.role}`, String(r.bitrix_user_id)])
  );

  // 3. Имена для переопределённых получателей — из sa.org_resolved_hierarchy.
  const overrideIds = [...new Set(ovRes.rows.map((r) => String(r.bitrix_user_id)))];
  const nameById = new Map<string, string>();
  if (overrideIds.length > 0) {
    const nameRes = await sa.query(
      `SELECT DISTINCT ON (manager_bitrix_user_id) manager_bitrix_user_id, manager_name
       FROM sa.org_resolved_hierarchy
       WHERE manager_bitrix_user_id = ANY($1)
       ORDER BY manager_bitrix_user_id, is_active DESC`,
      [overrideIds]
    );
    for (const r of nameRes.rows) if (r.manager_name) nameById.set(r.manager_bitrix_user_id, r.manager_name);
  }

  const departments = orgRes.rows
    .map((d) => {
      const ropOverrideId = overrideByKey.get(`${d.department_id}:rop`) ?? null;
      const dirOverrideId = overrideByKey.get(`${d.department_id}:department_director`) ?? null;
      return {
        department_id: d.department_id,
        department_name: d.department_name,
        rop_bitrix_user_id: d.rop_bitrix_user_id,
        rop_name: d.rop_name,
        department_director_bitrix_user_id: d.department_director_bitrix_user_id,
        department_director_name: d.department_director_name,
        rop_override_id: ropOverrideId,
        rop_override_name: ropOverrideId ? (nameById.get(ropOverrideId) ?? null) : null,
        director_override_id: dirOverrideId,
        director_override_name: dirOverrideId ? (nameById.get(dirOverrideId) ?? null) : null,
      };
    })
    .sort((a, b) => String(a.department_name ?? '').localeCompare(String(b.department_name ?? ''), 'ru'));

  return NextResponse.json({ departments });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = permError(session, 'section.settings');
  if (denied) return denied;

  const body = await req.json().catch(() => null) as
    { departmentId?: string; role?: string; bitrixUserId?: string | null } | null;
  if (!body?.departmentId || !/^[0-9a-f-]{36}$/i.test(body.departmentId)) {
    return NextResponse.json({ error: 'departmentId: uuid' }, { status: 400 });
  }
  if (body.role !== 'rop' && body.role !== 'department_director') {
    return NextResponse.json({ error: 'role: rop|department_director' }, { status: 400 });
  }
  const userId = (body.bitrixUserId ?? '').trim();
  if (userId && !/^\d+$/.test(userId)) {
    return NextResponse.json({ error: 'bitrixUserId: число или null (сброс на авто)' }, { status: 400 });
  }

  const db = systemDb();
  if (!userId) {
    await db.query(
      `DELETE FROM call_control_recipient_overrides WHERE department_id = $1 AND role = $2`,
      [body.departmentId, body.role]
    );
  } else {
    await db.query(
      `INSERT INTO call_control_recipient_overrides (department_id, role, bitrix_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (department_id, role) DO UPDATE SET bitrix_user_id = EXCLUDED.bitrix_user_id, updated_at = now()`,
      [body.departmentId, body.role, userId]
    );
  }
  return NextResponse.json({ ok: true });
}
