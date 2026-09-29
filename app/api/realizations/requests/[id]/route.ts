import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { loadRequestCard } from '@/lib/realizations/data';

// Карточка заявки: шапка + строки состава + приобретения + история статусов.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Некорректный id заявки' }, { status: 400 });
  try {
    const card = await loadRequestCard(id);
    if (!card) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 });
    const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    const salesNv = card.lines.reduce((a, l) => a + n(l.amount) - n(l.vat_amount), 0);
    const purchNv = card.purchases.reduce((a, p) => a + n(p.amount) - (p.include_vat ? n(p.amount_vat) : 0), 0);
    const broken = card.purchases.some(p => p.integrity_ok === false);
    return NextResponse.json({
      ...card,
      money: { salesNv, purchNv, broken, marginNv: card.purchases.length && !broken ? salesNv - purchNv : null },
    });
  } catch (e) {
    console.error('[realizations/card]', e);
    return NextResponse.json({ error: 'Не удалось получить данные базы Диспетчера' }, { status: 502 });
  }
}
