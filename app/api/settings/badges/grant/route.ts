import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';

// Ручная выдача ачивки (задача владельца 05.08: «нужен конструктор ачивок,
// чтобы можно было наградить менеджера какой-нибудь хуйнёй вроде „Разозлил
// охранника в БЦ и сумел скрыться“. Создать может только админ и присвоить
// тоже только админ»).
//
// Выдаётся ЛЮБАЯ существующая награда (обычно — кастомная с шаблоном 'manual'
// или секретка), одному человеку, с датой = сегодня. Идемпотентно: повторная
// выдача той же награды в тот же день ничего не задвоит (UNIQUE из миграции 112).
//
// MLT за ручную выдачу НЕ начисляются: денежная сторона живёт отдельно
// («Ручные операции» в карточке менеджера, /api/badges/manual) — смешивать
// ачивку и деньги в одном действии значило бы прятать списание бюджета внутри
// «награждения». Захочет админ ещё и денег — начислит явно.
//
// Ночной пересчёт наград ТОЛЬКО добавляет (INSERT ... ON CONFLICT), ничего не
// удаляет — выданное руками не затирается.

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;

  let body: { badgeKey?: unknown; bitrixId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const badgeKey = typeof body.badgeKey === 'string' ? body.badgeKey.trim() : '';
  const bitrixId = Number(body.bitrixId);
  if (!badgeKey) return NextResponse.json({ error: 'Выберите награду' }, { status: 400 });
  if (!Number.isInteger(bitrixId) || bitrixId <= 0) {
    return NextResponse.json({ error: 'Выберите сотрудника' }, { status: 400 });
  }

  const db = systemDb();
  const def = await db.query<{ key: string; name: string; tiered: boolean }>(
    'SELECT key, name, tiered FROM badge_definitions WHERE key = $1',
    [badgeKey],
  );
  if (def.rows.length === 0) return NextResponse.json({ error: 'Награда не найдена' }, { status: 404 });
  if (def.rows[0].tiered) {
    return NextResponse.json({ error: 'Уровневые награды выдаются движком, вручную нельзя' }, { status: 400 });
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const res = await db.query<{ is_insert: boolean }>(
    `INSERT INTO badge_awards (bitrix_id, badge_key, tier, period_type, period_date, value)
     VALUES ($1, $2, NULL, 'day', $3, NULL)
     ON CONFLICT (bitrix_id, badge_key, coalesce(tier,'-'), coalesce(period_type,'-'), coalesce(period_date,'0001-01-01'::date))
     DO NOTHING
     RETURNING (xmax = 0) AS is_insert`,
    [bitrixId, badgeKey, today],
  );

  const granted = res.rows.length > 0 && res.rows[0].is_insert;
  return NextResponse.json({
    ok: true,
    granted,
    message: granted
      ? `Награда «${def.rows[0].name}» выдана`
      : `«${def.rows[0].name}» у этого сотрудника уже есть за сегодня`,
  });
}
