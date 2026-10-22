import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { getAnalysis } from '@/features/ai-analysis/engine/store';
import { fetchClientModule, saveClientProfile } from '@/features/client-module/engine/clientModule';
import { CLIENT_TYPES, type ClientRef } from '@/features/client-module/engine/types';

// «Записать в карточку» (этап 2): тип заказчика, который ИИ вывел из звонков, — в карточку клиента
// (Битрикс + зеркало, тот же saveClientProfile, что у карточки). Только по кнопке РОПа: модель
// между прогонами путает «начало» и «финал» стройки — подтверждает человек. «Чем занимается» и
// заметку не трогаем: передаём текущие значения (saveClientProfile перезаписывает все три поля) —
// берём их так же, как карточка (fetchClientModule: зеркало, а нет записи — сам Битрикс).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'action.ai_call_analysis')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = Number((await ctx.params).id);
  const body = await req.json().catch(() => ({})) as { clientType?: string };
  const a = Number.isInteger(id) ? await getAnalysis(id) : null;
  if (!a || a.status !== 'done') return NextResponse.json({ error: 'Отчёт не найден' }, { status: 404 });
  // Тип — из отчёта; РОП может поправить на другой из списка перед записью.
  const clientType = body.clientType ?? a.parsed?.clientType ?? null;
  if (!clientType || !CLIENT_TYPES.some(t => t.value === clientType)) return NextResponse.json({ error: 'Тип заказчика не распознан' }, { status: 400 });
  try {
    const cur = (await fetchClientModule(a.clientRef as ClientRef)).profile;
    await saveClientProfile(a.clientRef as ClientRef, { clientType, occupation: cur.occupation ?? '', note: cur.note ?? '' }, session.login);
    return NextResponse.json({ ok: true, clientType });
  } catch (e) {
    console.error('[ai-analysis/client-type]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось записать тип' }, { status: 500 });
  }
}
