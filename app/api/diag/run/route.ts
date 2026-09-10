import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';

// Ручной запуск движка диагностики (супер-админ): step=refs — месячные справочники (лаги,
// зомби-пороги, сезонность); step=daily — ежедневный расчёт рядов по менеджерам. Те же
// функции, что гоняет планировщик; отправок нет (ТЗ №1 фаза 1).
export const maxDuration = 600;

export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const step = req.nextUrl.searchParams.get('step');
  try {
    if (step === 'refs') {
      const { refreshAllRefs } = await import('@/features/diag/engine/refs');
      return NextResponse.json({ step, result: await refreshAllRefs() });
    }
    if (step === 'daily') {
      const { runDaily } = await import('@/features/diag/engine/daily');
      return NextResponse.json({ step, result: await runDaily() });
    }
    return NextResponse.json({ error: 'step: refs | daily' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
