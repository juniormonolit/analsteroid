import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb, systemDb } from '@/lib/db/clients';

// Справочник «Люди» (задача владельца 05.08, ЛК-соцсетка): все активные менеджеры
// компании — имя, отдел, филиал, аватар. Доступен ЛЮБОМУ залогиненному — решение
// владельца: «публичный профиль показывает всё, что и так у человека в профиле,
// всем»; справочник — точка входа в такие профили. Ничего денежного/аналитического
// здесь нет — цифры остаются за своими гейтами.
//
// Аватары — bulk-чтение кэша manager_avatars БЕЗ ленивого похода в Битрикс
// (getManagerAvatarUrl ходит по одному и не для списка на ~200 человек): у кого
// кэш ещё пуст, аватар появится после первого открытия его карточки/профиля.

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const org = await analyticsDb().query<{
    id: string; name: string; department: string | null; branch: string | null;
  }>(
    `SELECT DISTINCT ON (h.manager_bitrix_user_id)
            h.manager_bitrix_user_id::text AS id,
            h.manager_name AS name,
            d.name AS department,
            h.branch
       FROM sa.org_resolved_hierarchy h
       LEFT JOIN sa.departments d ON d.id = h.department_id
      WHERE h.is_active = true AND h.manager_bitrix_user_id IS NOT NULL
      ORDER BY h.manager_bitrix_user_id, h.manager_name`,
  );

  const ids = org.rows.map(r => r.id);
  let avatarById = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const av = await systemDb().query<{ bitrix_user_id: string; avatar_url: string | null }>(
        'SELECT bitrix_user_id, avatar_url FROM manager_avatars WHERE bitrix_user_id = ANY($1) AND avatar_url IS NOT NULL',
        [ids],
      );
      avatarById = new Map(av.rows.map(r => [r.bitrix_user_id, r.avatar_url as string]));
    } catch {
      // Таблицы может не быть до миграции 106 — справочник живёт и без аватарок.
    }
  }

  const people = org.rows
    .map(r => ({ ...r, avatarUrl: avatarById.get(r.id) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return NextResponse.json({ people });
}
