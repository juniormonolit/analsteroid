import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUnsellDeal, lookupDeal, performUnsell } from '@/lib/sales/unsellDeal';

// GET — карточка сделки для поиска на странице «Снять с продажи» (стадия,
// sold_at, менеджер, сумма). Гейт — тот же canUnsellDeal (директор+/админ).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUnsellDeal(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { dealId } = await params;
  const id = Number(dealId);
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Некорректный номер сделки' }, { status: 400 });

  const deal = await lookupDeal(id);
  if (!deal) return NextResponse.json({ error: 'Сделка не найдена' }, { status: 404 });
  return NextResponse.json({ deal });
}

// POST — собственно снятие с продажи (задача #6260). Body: { reason: string }.
// Гейт по праву action.deals.unsell (директор+/админ) — РОП получает 403.
// Стадийный гард и запись в журнал — в lib/sales/unsellDeal.ts::performUnsell.
// Обратной операции («вернуть sold_at») нет НАМЕРЕННО — нельзя «продать» сделку
// повторно кнопкой, это должно происходить только через реальный переход стадии.
export async function POST(req: NextRequest, { params }: { params: Promise<{ dealId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUnsellDeal(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { dealId } = await params;
  const id = Number(dealId);
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'Некорректный номер сделки' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const reason = typeof body.reason === 'string' ? body.reason : '';

  const result = await performUnsell({ dealId: id, reason, userId: session.id, userName: session.displayName });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
