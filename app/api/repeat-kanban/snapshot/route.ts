import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { buildDailySnapshot } from '@/features/repeat-kanban/engine/snapshot';

// Ручной запуск ежедневного снимка канбана повторных (суперадмин): первый снимок сразу после
// выкатки и перезапись дня после правок. Плановый — джоба repeatKanbanSnapshot в 23:30 МСК.
// Снимок идёт 10–15 минут — ЗАПУСКАЕМ В ФОНЕ и сразу отвечаем: долгий HTTP-запрос обрывает
// прокси, и снимок умирал вместе с ним (20.10: дважды остановился на ~213 менеджерах).
export const dynamic = 'force-dynamic';

let running = false;

export async function POST() {
  const session = await getSession();
  if (!session?.isSuperadmin) return NextResponse.json({ error: 'Только суперадмин' }, { status: 403 });
  if (running) return NextResponse.json({ started: false, note: 'Снимок уже идёт' });
  running = true;
  void buildDailySnapshot()
    .then(r => console.log(`[repeatKanbanSnapshot] ручной ${r.date}: менеджеров ${r.managers}, записано ${r.written}, пропущено ${r.skipped}, ${Math.round(r.ms / 1000)} с`))
    .catch(e => console.error('[repeatKanbanSnapshot] ручной не удался:', e instanceof Error ? e.message : e))
    .finally(() => { running = false; });
  return NextResponse.json({ started: true });
}
