import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { evaluateScenario, loadScenario } from '@/lib/jobs/scenarios';

// «Проверить сейчас без отправки»: полный расчёт по всем работающим менеджерам —
// значение, база, порог, что бы сделал сценарий и почему, готовый текст.
// Ничего не пишет и не шлёт; работает и для выключенного сценария/функции.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Не указан сценарий' }, { status: 400 });
  const s = await loadScenario(id);
  if (!s) return NextResponse.json({ error: 'Сценарий не найден' }, { status: 404 });
  try {
    const res = await evaluateScenario(s);
    return NextResponse.json({
      metric: { id: res.metric.id, name: res.metric.nameRu, dataType: res.metric.dataType, decimalPlaces: res.metric.decimalPlaces },
      window: res.window, baselineWindow: res.baselineWindow, evals: res.evals, summary: { ...res.summary, dryPreview: true },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось посчитать' }, { status: 400 });
  }
}
