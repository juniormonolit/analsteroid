import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Справочники для формы расписания: ВСЕ сохранённые шаблоны «Мой отчёт» (всех
// пользователей — владелец так и просил: «выборку из всех с поиском») и
// получатели — активные пользователи с привязкой к Битриксу (иначе боту некуда
// писать). Списки небольшие, поиск — на клиенте.
export async function GET() {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const db = systemDb();
  const [templates, users] = await Promise.all([
    db.query<{ id: string; name: string; user_login: string; owner_name: string | null; state: Record<string, unknown> }>(
      `SELECT t.id::text, t.name, t.user_login, u.display_name AS owner_name, t.state
         FROM report_templates t LEFT JOIN users u ON u.login = t.user_login
        ORDER BY u.display_name NULLS LAST, t.name`,
    ),
    db.query<{ login: string; display_name: string; bitrix_user_id: string }>(
      `SELECT login, display_name, bitrix_user_id FROM users
        WHERE is_active = true AND bitrix_user_id IS NOT NULL ORDER BY display_name`,
    ),
  ]);
  const periodLabel: Record<string, string> = { day: 'день', week: 'неделя', month: 'месяц' };
  return NextResponse.json({
    templates: templates.rows.map(t => {
      const st = t.state ?? {};
      const ents = Array.isArray(st.entities) ? st.entities.length : 0;
      const mets = Array.isArray(st.metricIds) ? st.metricIds.length : 0;
      return {
        id: t.id, name: t.name, ownerLogin: t.user_login, ownerName: t.owner_name ?? t.user_login,
        summary: `${periodLabel[String(st.period)] ?? 'месяц'} · сущностей ${ents} · метрик ${mets}`,
      };
    }),
    recipients: users.rows.map(u => ({ bitrixId: u.bitrix_user_id, name: u.display_name, login: u.login })),
  });
}
