import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { startRun, getRun, lastRuns } from '@/features/diag/engine/runs';

// Прогоны движка диагностики (супер-админ). POST ?step=refs|daily — стартует фоновый прогон
// и сразу отвечает {id}; GET ?id= — прогресс; GET без id — последние прогоны по видам.
// Отправок нет (ТЗ №1 фаза 1). Одновременно — один прогон каждого вида.
export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const step = req.nextUrl.searchParams.get('step');
  if (step === 'refs') {
    const r = await startRun('refs', session!.login, async (progress) => {
      const { computeLags, computeZombieThresholds, computeSeason } = await import('@/features/diag/engine/refs');
      await progress('лаги переходов по группам', 0, 3); const lags = await computeLags();
      await progress('зомби-пороги', 1, 3); const z = await computeZombieThresholds();
      await progress('сезонность', 2, 3); const season = await computeSeason();
      await progress('готово', 3, 3);
      return { lags: lags.rows, zombieGroups: z.groups, zombieFallback: z.fallback, season: season.rows };
    });
    return NextResponse.json(r);
  }
  if (step === 'daily') {
    const r = await startRun('daily', session!.login, async (progress) => {
      const { runDaily } = await import('@/features/diag/engine/daily');
      return runDaily({ progress });
    });
    return NextResponse.json(r);
  }
  return NextResponse.json({ error: 'step: refs | daily' }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const id = req.nextUrl.searchParams.get('id');
  if (id) return NextResponse.json({ run: await getRun(Number(id)) });
  return NextResponse.json({ runs: await lastRuns() });
}
