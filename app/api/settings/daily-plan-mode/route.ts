import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { invalidateDailyPlanModeCache, DEFAULT_DAILY_PLAN_MODE, type DailyPlanMode } from '@/lib/plans/dailyPlan';

// Режим дневного плана (п.7 согласованной спеки, решение собрания 08.07) — глобальная
// настройка, доступна ТОЛЬКО супер-админу (Серёга). Хранится в plan_settings (singleton,
// id=1, миграция 050). 'divide20' (дефолт) — месячный план ÷ 20; 'calendar' — прежняя
// логика через working_calendar (/settings/working-calendar).
export async function GET() {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const db = systemDb();
  const res = await db.query<{ daily_plan_mode: string | null }>('SELECT daily_plan_mode FROM plan_settings WHERE id = 1');
  const mode: DailyPlanMode = res.rows[0]?.daily_plan_mode === 'calendar' ? 'calendar' : DEFAULT_DAILY_PLAN_MODE;
  return NextResponse.json({ mode });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const body = await req.json() as { mode: DailyPlanMode };
  if (body.mode !== 'divide20' && body.mode !== 'calendar') {
    return NextResponse.json({ error: 'mode must be "divide20" or "calendar"' }, { status: 400 });
  }

  const db = systemDb();
  await db.query('UPDATE plan_settings SET daily_plan_mode = $1, updated_at = NOW() WHERE id = 1', [body.mode]);
  invalidateDailyPlanModeCache();
  return NextResponse.json({ ok: true, mode: body.mode });
}
