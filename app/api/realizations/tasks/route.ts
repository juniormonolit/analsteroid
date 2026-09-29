import { NextRequest, NextResponse } from 'next/server';
import { guardRealizations } from '../guard';
import { fetchRequestTasks } from '@/features/reports/engine/requestResponse';

// Дриллдаун отчёта «Ответы на запросы»: задачи-запросы менеджера за период.
// managerId — Bitrix id постановщика (через запятую — группа), '__all__' — все.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const g = await guardRealizations();
  if ('res' in g) return g.res;
  const sp = req.nextUrl.searchParams;
  const from = new Date(sp.get('from') ?? '');
  const to = new Date(sp.get('to') ?? '');
  const managerId = sp.get('managerId') ?? '';
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NextResponse.json({ error: 'Период задан неверно' }, { status: 400 });
  if (managerId !== '__all__' && !/^\d+(,\d+)*$/.test(managerId)) return NextResponse.json({ error: 'Некорректный менеджер' }, { status: 400 });
  try {
    const items = await fetchRequestTasks({ from, to }, managerId);
    return NextResponse.json({ items, truncated: items.length >= 2000 });
  } catch (e) {
    const msg = (e as Error).message ?? '';
    console.error('[realizations/tasks]', msg);
    if (/permission denied/i.test(msg)) {
      return NextResponse.json({ error: 'Нет доступа к задачам Битрикса в базе (sa.bitrix_task_current / sa.bitrix_flows): роли приложения нужен GRANT SELECT' }, { status: 503 });
    }
    return NextResponse.json({ error: 'Не удалось загрузить запросы' }, { status: 502 });
  }
}
