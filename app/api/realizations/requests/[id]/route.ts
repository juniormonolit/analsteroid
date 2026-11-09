import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../../guard';
import { loadRequestCardWithMoney } from '@/lib/realizations/data';

// Карточка заявки: шапка + строки состава + приобретения + история статусов.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Некорректный id заявки' }, { status: 400 });
  try {
    const card = await loadRequestCardWithMoney(id);
    if (!card) return NextResponse.json({ error: 'Заявка не найдена' }, { status: 404 });
    return NextResponse.json(card);
  } catch (e) {
    console.error('[realizations/card]', e);
    return NextResponse.json({ error: 'Не удалось получить заявки из 1С — попробуйте обновить страницу' }, { status: 502 });
  }
}
