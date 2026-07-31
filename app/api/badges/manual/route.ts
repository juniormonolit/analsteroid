import { NextRequest, NextResponse } from 'next/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess, managedDepartmentIds } from '@/lib/org/managerAccess';
import { resolveManagersForDepartments } from '@/lib/org/teamRoster';
import { systemDb } from '@/lib/db/clients';
import { getCurrencyName } from '@/features/badges/engine/coins';

// Ручные поощрения/штрафы валютой (доп. Серёги 31.07 к 2657).
// Право: админ/директор — на всех; РОП и любой с managed-отделами — ТОЛЬКО на
// своих подчинённых (та же механика managed-depts, что «Моя команда»); себя
// поощрять нельзя никому, кроме полного доступа. Менеджерам кнопки не видны
// (canManual=false) и POST отбивается тем же расчётом — второй рубеж.
async function canManualFor(session: SessionUser, bitrixId: string): Promise<boolean> {
  if (hasFullManagerAccess(session)) return true;
  if (session.bitrixUserId === bitrixId) return false; // сам себе — нет
  const deptIds = await managedDepartmentIds(session);
  if (deptIds.length === 0) return false;
  const roster = await resolveManagersForDepartments(deptIds);
  return roster.some(m => m.managerId === bitrixId);
}

interface PenaltyTypeRow { id: number; name: string; price: number; price_mode: 'fixed' | 'percent' }

async function balanceOf(bitrixId: number): Promise<number> {
  const r = await systemDb().query<{ balance: string }>(
    `SELECT balance FROM badge_coin_balances WHERE bitrix_id = $1`, [bitrixId],
  );
  return Number(r.rows[0]?.balance ?? 0);
}

// Остаток месячного бюджета поощрений АКТОРА (по МСК-месяцу; сторно возвращает
// бюджет автоматически — компенсирующая запись отрицательна и входит в SUM).
// 0 в настройках = без лимита (возвращаем null).
async function bonusBudgetLeft(actorLogin: string): Promise<{ budget: number; left: number } | null> {
  const db = systemDb();
  const s = await db.query<{ monthly_bonus_budget: number }>(
    `SELECT monthly_bonus_budget FROM badge_coin_settings WHERE id = 1`,
  );
  const budget = s.rows[0]?.monthly_bonus_budget ?? 2000;
  if (budget === 0) return null;
  const spent = await db.query<{ spent: string }>(
    `SELECT coalesce(sum(amount), 0) AS spent
       FROM badge_coin_ledger
      WHERE source = 'manual_bonus' AND actor_login = $1
        AND created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'`,
    [actorLogin],
  );
  return { budget, left: Math.max(0, budget - Number(spent.rows[0]?.spent ?? 0)) };
}

// Расчёт суммы штрафа: фикс — как в справочнике; percent — от накопленного
// баланса менеджера НА МОМЕНТ операции (прогрессивный штраф), фиксируется
// абсолютным числом и потом не пересчитывается.
function penaltyAmount(t: PenaltyTypeRow, balance: number): number {
  if (t.price_mode === 'percent') return Math.max(0, Math.round(balance * t.price / 100));
  return t.price;
}

// Контекст для UI карточки: можно ли этому пользователю поощрять/штрафовать
// данного менеджера, остаток бюджета, справочник штрафов с РАССЧИТАННЫМИ
// суммами (для подтверждающего окна), название валюты.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const bitrixId = req.nextUrl.searchParams.get('bitrixId');
  if (!bitrixId || !/^\d+$/.test(bitrixId)) return NextResponse.json({ canManual: false });

  const canManual = await canManualFor(session, bitrixId);
  const db = systemDb();
  const currencyName = await getCurrencyName(db);
  if (!canManual) return NextResponse.json({ canManual: false, currencyName });

  const [types, balance, budget] = await Promise.all([
    db.query<PenaltyTypeRow>(`SELECT id, name, price, price_mode FROM penalty_types WHERE enabled ORDER BY name`),
    balanceOf(Number(bitrixId)),
    bonusBudgetLeft(session.login),
  ]);
  return NextResponse.json({
    canManual: true,
    currencyName,
    balance,
    budget, // null = без лимита
    canReverse: session.isSuperadmin, // сторно — только админ
    penaltyTypes: types.rows.map(t => ({
      id: t.id, name: t.name, price: t.price, priceMode: t.price_mode,
      computedAmount: penaltyAmount(t, balance),
    })),
  });
}

// Операция: {bitrixId, type:'bonus', amount, comment} | {bitrixId, type:'penalty', penaltyTypeId, comment?}
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { bitrixId?: unknown; type?: unknown; amount?: unknown; penaltyTypeId?: unknown; comment?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const bitrixId = typeof body.bitrixId === 'number' && Number.isInteger(body.bitrixId) && body.bitrixId > 0
    ? String(body.bitrixId) : null;
  if (!bitrixId) return NextResponse.json({ error: 'bitrixId обязателен' }, { status: 400 });
  if (!(await canManualFor(session, bitrixId))) {
    return NextResponse.json({ error: 'Ручные операции по этому сотруднику вам недоступны' }, { status: 403 });
  }

  const db = systemDb();
  const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';

  if (body.type === 'bonus') {
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > 1_000_000) {
      return NextResponse.json({ error: 'Сумма поощрения — целое число больше нуля' }, { status: 400 });
    }
    if (!comment) return NextResponse.json({ error: 'Комментарий обязателен для поощрения' }, { status: 400 });
    const budget = await bonusBudgetLeft(session.login);
    if (budget && amount > budget.left) {
      return NextResponse.json(
        { error: `Бюджет поощрений исчерпан: осталось ${budget.left} из ${budget.budget} в этом месяце` },
        { status: 400 },
      );
    }
    const r = await db.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award,
                                      source, actor_bitrix_id, actor_login, comment)
       VALUES ($1, NULL, NULL, $2, $2, 'manual_bonus', $3, $4, $5) RETURNING id`,
      [Number(bitrixId), amount, session.bitrixUserId ? Number(session.bitrixUserId) : null, session.login, comment],
    );
    return NextResponse.json({ ok: true, id: r.rows[0].id, amount });
  }

  if (body.type === 'penalty') {
    const typeId = body.penaltyTypeId;
    if (typeof typeId !== 'number' || !Number.isInteger(typeId)) {
      return NextResponse.json({ error: 'Выберите причину штрафа' }, { status: 400 });
    }
    const t = await db.query<PenaltyTypeRow>(
      `SELECT id, name, price, price_mode FROM penalty_types WHERE id = $1 AND enabled`, [typeId],
    );
    if (t.rowCount === 0) return NextResponse.json({ error: 'Причина штрафа не найдена или выключена' }, { status: 404 });
    // Цена фиксирована справочником: сумму менять нельзя, percent считается от
    // баланса на момент операции и фиксируется абсолютным числом.
    const amount = penaltyAmount(t.rows[0], await balanceOf(Number(bitrixId)));
    if (amount <= 0) return NextResponse.json({ error: 'Расчётная сумма штрафа — 0 (нулевой баланс), операция не создана' }, { status: 400 });
    const r = await db.query<{ id: number }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award,
                                      source, actor_bitrix_id, actor_login, comment, penalty_type_id)
       VALUES ($1, NULL, NULL, $2, $3, 'manual_penalty', $4, $5, $6, $7) RETURNING id`,
      [Number(bitrixId), -amount, amount, session.bitrixUserId ? Number(session.bitrixUserId) : null, session.login, comment, typeId],
    );
    return NextResponse.json({ ok: true, id: r.rows[0].id, amount: -amount });
  }

  return NextResponse.json({ error: 'type: bonus | penalty' }, { status: 400 });
}
