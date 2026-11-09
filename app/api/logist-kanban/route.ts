import { NextRequest, NextResponse } from 'next/server';
import { guardLogistKanban } from './guard';
import { loadBoard, setCardStatus, type CardStatus } from '@/features/logist-kanban/engine/board';
import { REGIONS, type Region } from '@/lib/realizations/region';

// «Канбан логиста» (прототип, владелец 09.11): GET — доска по фильтрам, POST — смена колонки.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const g = await guardLogistKanban();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const region = (sp.get('region') ?? '') as Region | '';
  const days = Number(sp.get('days') ?? 60);
  const minAmount = Number(sp.get('min') ?? 0);
  if (region && !REGIONS.includes(region)) return NextResponse.json({ error: 'Неизвестный филиал' }, { status: 400 });
  if (![7, 14, 30, 60, 90, 180].includes(days)) return NextResponse.json({ error: 'Некорректный период' }, { status: 400 });
  if (!Number.isFinite(minAmount) || minAmount < 0) return NextResponse.json({ error: 'Некорректная сумма' }, { status: 400 });
  const statuses = (sp.get('statuses') ?? '').split('\u0001').filter(Boolean).slice(0, 50);
  const goods = (sp.get('goods') ?? '').slice(0, 100);
  try {
    const board = await loadBoard({ region, minAmount, statuses, goods, days, mine: sp.get('mine') === '1' }, g.session.login);
    return NextResponse.json(board);
  } catch (e) {
    console.error('[logist-kanban]', e);
    return NextResponse.json({ error: 'Не удалось получить заявки из 1С — попробуйте обновить страницу' }, { status: 502 });
  }
}

const STATUSES: CardStatus[] = ['pool', 'in_work', 'success', 'fail'];

export async function POST(req: NextRequest) {
  const g = await guardLogistKanban();
  if ('res' in g) return g.res;
  const body = await req.json().catch(() => null) as { key?: unknown; requestId?: unknown; status?: unknown; note?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  const requestId = typeof body?.requestId === 'string' ? body.requestId : '';
  const status = body?.status as CardStatus;
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 1000) : null;
  if (!key || key.length > 200 || !/^[0-9a-f-]{36}$/i.test(requestId) || !STATUSES.includes(status)) {
    return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  }
  try {
    await setCardStatus({ key, requestId, status, note }, { login: g.session.login, name: g.session.displayName || null });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') {
      return NextResponse.json({ error: 'Таблица канбана ещё не создана (миграция 261) — доска пока только для просмотра' }, { status: 503 });
    }
    console.error('[logist-kanban] POST', e);
    return NextResponse.json({ error: 'Не удалось сохранить статус' }, { status: 500 });
  }
}
