import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';
import { canViewPeople, scopedPeople } from '@/features/big-brother/engine/daily/access';
import { computeDaily } from '@/features/big-brother/engine/daily/build';
import { isValidDate, mskDate } from '@/features/big-brother/engine/daily/time';
import { toDailyDto } from '@/features/big-brother/engine/daily/timeline';
import type { DailyRowDto, PeopleResponse } from '@/features/big-brother/engine/daily/types';

// «Большой брат» → «Люди»: список мониторимых (продажи + логисты) в срезе сессии + их агрегат за дату.
// GET ?date=YYYY-MM-DD (МСК, по умолчанию сегодня). Агрегат — из activity_daily; если за дату он ещё не собран
// (первые дни после выкатки, сбой джобы) — считается вживую без записи (builtAt = null).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canViewPeople(session)) return NextResponse.json({ error: 'Раздел — для уровня «директор и выше»' }, { status: 403 });
  const raw = req.nextUrl.searchParams.get('date');
  const today = mskDate();
  const date = isValidDate(raw) && raw <= today ? raw : today;
  try {
    const people = await scopedPeople(session);
    const r = await systemDb().query(
      `SELECT to_char(snap_date, 'YYYY-MM-DD') AS d, * FROM activity_daily WHERE snap_date = $1::date AND bitrix_user_id = ANY($2)`,
      [date, people.map(p => p.id)],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }));
    let builtAt: string | null = null;
    const byId = new Map<string, DailyRowDto>();
    if (r.rows.length) {
      for (const x of r.rows) {
        byId.set(String(x.bitrix_user_id), toDailyDto(x));
        const b = x.built_at ? new Date(x.built_at as string).toISOString() : null;
        if (b && (!builtAt || b > builtAt)) builtAt = b;
      }
    } else {
      const live = await computeDaily(date, { people });
      for (const row of live.rows) byId.set(row.bitrixUserId, row);
    }
    const body: PeopleResponse = {
      date, builtAt,
      people: people.map(p => {
        const d = byId.get(p.id);
        return {
          id: p.id, name: p.name, role: p.role, departmentId: p.departmentId, departmentName: p.departmentName, ropId: p.ropId, ropName: p.ropName,
          day: d ? { inWork: d.inWork, monoMinutes: d.monoMinutes, buckets: d.buckets, firstSignalAt: d.firstSignalAt, lastSignalAt: d.lastSignalAt, counts: d.counts } : null,
        };
      }),
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[big-brother people]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка расчёта' }, { status: 500 });
  }
}
