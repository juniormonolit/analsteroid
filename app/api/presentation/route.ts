import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { buildPresentation } from '@/features/presentation/engine/presentation';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// POST — параметры сложные (массив отделов + два диапазона), GET с query был бы
// длиннее и без выгоды кэша (данные живые). Право — как у самого раздела.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const denied = permError(session, 'section.presentation');
  if (denied) return denied;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  const b = body as {
    departmentIds?: unknown;
    period?: { from?: unknown; to?: unknown };
    comparison?: { from?: unknown; to?: unknown };
  };
  const departmentIds = Array.isArray(b.departmentIds)
    ? b.departmentIds.filter((x): x is string => typeof x === 'string').slice(0, 500)
    : [];
  const dates = [b.period?.from, b.period?.to, b.comparison?.from, b.comparison?.to];
  if (!dates.every(d => typeof d === 'string' && DATE_RE.test(d))) {
    return NextResponse.json({ error: 'Ожидаются period/comparison с датами YYYY-MM-DD' }, { status: 400 });
  }
  const [periodFrom, periodTo, comparisonFrom, comparisonTo] = dates as string[];
  if (periodFrom > periodTo || comparisonFrom > comparisonTo) {
    return NextResponse.json({ error: 'Начало диапазона позже конца' }, { status: 400 });
  }

  const data = await buildPresentation({ departmentIds, periodFrom, periodTo, comparisonFrom, comparisonTo });
  return NextResponse.json(data);
}
