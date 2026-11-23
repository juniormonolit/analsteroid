import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { permError } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { isKnownDeptKey, listDeptRepeatShares } from '@/lib/plans/repeatShare';

// Доля повторных продаж в плане отдела (миграция 284, lib/plans/repeatShare.ts).
// GET — любой залогиненный (доли не секретны: это коэффициент, не деньги менеджеров).
// PUT — право «Редактирование планов» (action.plans.edit), то же, что у планов менеджеров
// и коэффициента N на той же странице. sharePct = null — убрать долю (план (повт.) пропадёт).

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ departments: await listDeptRepeatShares() });
}

export async function PUT(request: Request) {
  const session = await getSession();
  const denied = permError(session, 'action.plans.edit');
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as { deptKey?: unknown; sharePct?: unknown } | null;
  const deptKey = typeof body?.deptKey === 'string' ? body.deptKey : '';
  if (!isKnownDeptKey(deptKey)) return NextResponse.json({ error: 'Неизвестный отдел' }, { status: 400 });

  const db = systemDb();
  if (body?.sharePct === null) {
    await db.query(`DELETE FROM dept_repeat_plan_share WHERE dept_key = $1`, [deptKey]);
    return NextResponse.json({ ok: true });
  }
  const pct = typeof body?.sharePct === 'number' ? body.sharePct : NaN;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return NextResponse.json({ error: 'Доля — число от 0 до 100' }, { status: 400 });
  }
  await db.query(
    `INSERT INTO dept_repeat_plan_share (dept_key, repeat_share_pct, updated_at, updated_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (dept_key) DO UPDATE
       SET repeat_share_pct = EXCLUDED.repeat_share_pct, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [deptKey, Math.round(pct * 100) / 100, session!.displayName || session!.login],
  );
  return NextResponse.json({ ok: true });
}
