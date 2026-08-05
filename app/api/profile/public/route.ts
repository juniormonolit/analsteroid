import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { getManagerAvatarUrl } from '@/lib/bitrix/managerAvatar';

// Личность для ПУБЛИЧНОГО профиля (задача владельца 05.08, ЛК-соцсетка):
// имя/отдел/филиал/аватар менеджера — любому залогиненному. Решение владельца
// дословно: «публичный профиль показывает всё, что и так у человека в профиле,
// всем; „Статистика“, „Квесты“, „Заказчики“, „Инвентарь“ — личное». Аналитика
// (радар/конверсии/звонки, /api/manager-card) остаётся за canViewManager —
// этот роут отдаёт ТОЛЬКО личность, остальное публичный профиль собирает из
// геймификационных роутов (/api/badges/*), открытых тем же решением.
//
// Аватар — через getManagerAvatarUrl (кэш manager_avatars с ленивым обновлением
// из Битрикса): здесь один человек, не список — ленивый поход уместен, заодно
// прогревает кэш для справочника «Люди».

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bitrixId = req.nextUrl.searchParams.get('bitrixId');
  if (!bitrixId || !/^\d+$/.test(bitrixId)) {
    return NextResponse.json({ error: 'bitrixId (число) обязателен' }, { status: 400 });
  }

  const [org, avatarUrl] = await Promise.all([
    analyticsDb().query<{ name: string; department: string | null; branch: string | null }>(
      `SELECT h.manager_name AS name, d.name AS department, h.branch
         FROM sa.org_resolved_hierarchy h
         LEFT JOIN sa.departments d ON d.id = h.department_id
        WHERE h.manager_bitrix_user_id::text = $1
        ORDER BY h.is_active DESC
        LIMIT 1`,
      [bitrixId],
    ),
    getManagerAvatarUrl(bitrixId),
  ]);

  const row = org.rows[0];
  if (!row) return NextResponse.json({ error: 'Сотрудник не найден' }, { status: 404 });

  return NextResponse.json({
    profile: { name: row.name, department: row.department, branch: row.branch, avatarUrl },
  });
}
