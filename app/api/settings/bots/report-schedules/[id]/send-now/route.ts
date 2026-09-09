import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { sendReportScheduleNow } from '@/lib/jobs/reportSchedules';

// «Отправить сейчас» — проверить расписание, не дожидаясь времени. Рубильник
// функции report_schedules НЕ обходит: выключено — вернётся понятная ошибка.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Не указано расписание' }, { status: 400 });
  try {
    await sendReportScheduleNow(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось отправить' }, { status: 400 });
  }
}
