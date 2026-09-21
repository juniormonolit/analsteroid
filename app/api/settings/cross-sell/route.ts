import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import {
  MANUAL_MAX, fetchCrossSellMatrix, fetchCrossSellPriorities, recommendFor,
} from '@/features/customers/engine/crossSell';

// Настройки → «Что предложить»: ручные приоритеты кросс-селла (правка владельца
// 21.09, миграция 214). Статистика после «Газобетон» советует «Сухие смеси»
// (клей берут той же покупкой) — это шум; здесь для каждой товарной группы
// можно задать до трёх групп, которые пойдут перед статистикой.
//
// Словарь групп берём из САМОЙ матрицы переходов (Redis 24 ч) — это ровно то
// множество head-групп, которым оперирует рекомендация; отдельный справочник
// разошёлся бы с ней (услуги/доставка/«Разное» из матрицы исключены).
// Правит только супер-админ, как и остальные настройки расчёта.

export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const [matrix, priorities] = await Promise.all([fetchCrossSellMatrix(), fetchCrossSellPriorities()]);

  const names = new Set<string>([...Object.keys(matrix.from), ...Object.keys(matrix.globalTo), ...Object.keys(priorities)]);
  const rows = [...names].map(name => ({
    name,
    /** Сколько раз из этой группы вообще был переход дальше — вес группы. */
    transitions: matrix.from[name]?.total ?? 0,
    /** Что рекомендация показывает СЕЙЧАС по статистике (без ручных приоритетов). */
    stat: (recommendFor(matrix, [name])?.items ?? []).map(i => ({ group: i.group, pct: i.pct })),
    priorities: priorities[name] ?? [],
  }));
  rows.sort((a, b) => b.transitions - a.transitions || a.name.localeCompare(b.name, 'ru'));

  return NextResponse.json({
    rows,
    allGroups: [...names].sort((a, b) => a.localeCompare(b, 'ru')),
    max: MANUAL_MAX,
  });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json().catch(() => null) as { fromGroup?: unknown; groups?: unknown } | null;
  const fromGroup = typeof body?.fromGroup === 'string' ? body.fromGroup.trim() : '';
  if (!fromGroup) return NextResponse.json({ error: 'Не указана товарная группа' }, { status: 400 });

  const raw = Array.isArray(body?.groups) ? body!.groups : [];
  const groups: string[] = [];
  for (const g of raw) {
    if (typeof g !== 'string') continue;
    const v = g.trim();
    if (!v || groups.includes(v)) continue;
    // Предлагать ту же группу бессмысленно: движок самоповторы и так вырезает
    // («предложить то же самое» — правило 01.08), приоритет просто не сработал бы.
    if (v === fromGroup) return NextResponse.json({ error: 'Нельзя предлагать ту же самую группу' }, { status: 400 });
    groups.push(v);
  }
  if (groups.length > MANUAL_MAX) {
    return NextResponse.json({ error: `Не больше ${MANUAL_MAX} приоритетов` }, { status: 400 });
  }

  const db = systemDb();
  if (groups.length === 0) {
    await db.query(`DELETE FROM cross_sell_priorities WHERE from_group = $1`, [fromGroup]);
  } else {
    await db.query(
      `INSERT INTO cross_sell_priorities (from_group, groups, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (from_group) DO UPDATE SET groups = EXCLUDED.groups, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [fromGroup, groups, session!.displayName],
    );
  }
  return NextResponse.json({ ok: true, fromGroup, groups });
}
