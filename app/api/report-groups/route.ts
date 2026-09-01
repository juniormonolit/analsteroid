import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Пользовательские группы строк отчёта (задача 2653) — CRUD per-user
// (user_report_groups, миграция 110, системная БД). Права: любой залогиненный —
// группы видны ТОЛЬКО их автору (все запросы жёстко по session.login), чужие
// группы недоступны by construction.

const DIMENSION_KEYS = ['manager', 'product-group:kc', 'product-group:by_max'];
const MAX_GROUPS_PER_KEY = 50;
const MAX_MEMBERS = 300;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const dimensionKey = req.nextUrl.searchParams.get('dimensionKey') ?? '';
  if (!DIMENSION_KEYS.includes(dimensionKey)) {
    return NextResponse.json({ error: 'dimensionKey обязателен' }, { status: 400 });
  }
  // COALESCE: до миграции 190 колонки enabled нет — группы считаются включёнными,
  // роут не падает (тот же приём, что loadNonMoneyPlans в year-weekly).
  const res = await systemDb().query(
    `SELECT id, name, member_ids, created_at,
            COALESCE((to_jsonb(user_report_groups)->>'enabled')::boolean, true) AS enabled
       FROM user_report_groups
      WHERE user_login = $1 AND dimension_key = $2 ORDER BY created_at`,
    [session.login, dimensionKey],
  );
  return NextResponse.json({ groups: res.rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const dimensionKey = String(body.dimensionKey ?? '');
  const name = String(body.name ?? '').trim();
  const memberIds = Array.isArray(body.memberIds)
    ? (body.memberIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200)
    : [];
  if (!DIMENSION_KEYS.includes(dimensionKey)) return NextResponse.json({ error: 'dimensionKey обязателен' }, { status: 400 });
  if (!name || name.length > 80) return NextResponse.json({ error: 'Название 1..80 символов' }, { status: 400 });
  if (memberIds.length === 0 || memberIds.length > MAX_MEMBERS) {
    return NextResponse.json({ error: `Участники: 1..${MAX_MEMBERS}` }, { status: 400 });
  }

  // «Один участник — только в одной группе» (дефолт, подтверждён владельцем):
  // отклоняем создание, если кто-то уже состоит в другой группе этого же юзера
  // и этой же шкалы (клиент таких и не предлагает — это защита от гонки).
  const busy = await systemDb().query<{ member: string }>(
    `SELECT DISTINCT unnest(member_ids) AS member FROM user_report_groups
      WHERE user_login = $1 AND dimension_key = $2`,
    [session.login, dimensionKey],
  );
  const busySet = new Set(busy.rows.map(r => r.member));
  const conflicts = memberIds.filter(id => busySet.has(id));
  if (conflicts.length > 0) {
    return NextResponse.json({ error: `Уже в другой группе: ${conflicts.slice(0, 5).join(', ')}` }, { status: 409 });
  }
  const cnt = await systemDb().query<{ n: string }>(
    `SELECT count(*) AS n FROM user_report_groups WHERE user_login = $1 AND dimension_key = $2`,
    [session.login, dimensionKey],
  );
  if (Number(cnt.rows[0].n) >= MAX_GROUPS_PER_KEY) {
    return NextResponse.json({ error: `Максимум ${MAX_GROUPS_PER_KEY} групп` }, { status: 400 });
  }

  const ins = await systemDb().query(
    `INSERT INTO user_report_groups (user_login, dimension_key, name, member_ids)
     VALUES ($1, $2, $3, $4) RETURNING id, name, member_ids, created_at`,
    [session.login, dimensionKey, name, memberIds],
  );
  return NextResponse.json({ group: ins.rows[0] });
}

// Тумблер вкл/выкл (правка владельца 31.08): выключенная группа остаётся на
// аккаунте, но не применяется к отчёту. Только своя группа (WHERE user_login).
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.id !== 'string' || !body.id || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Нужны id и enabled' }, { status: 400 });
  }
  const res = await systemDb().query(
    `UPDATE user_report_groups SET enabled = $1 WHERE id = $2::uuid AND user_login = $3 RETURNING id`,
    [body.enabled, body.id, session.login],
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Группа не найдена' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  // либо одна группа по id, либо все группы шкалы («сбросить все»)
  if (typeof body.id === 'string' && body.id) {
    await systemDb().query(
      `DELETE FROM user_report_groups WHERE id = $1::uuid AND user_login = $2`,
      [body.id, session.login],
    );
    return NextResponse.json({ ok: true });
  }
  const dimensionKey = String(body.dimensionKey ?? '');
  if (body.all === true && DIMENSION_KEYS.includes(dimensionKey)) {
    await systemDb().query(
      `DELETE FROM user_report_groups WHERE user_login = $1 AND dimension_key = $2`,
      [session.login, dimensionKey],
    );
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: 'нужен id либо {all:true, dimensionKey}' }, { status: 400 });
}
