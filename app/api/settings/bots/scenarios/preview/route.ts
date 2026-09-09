import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { evaluateFlow } from '@/lib/jobs/scenarios';
import { validateFlow } from '@/lib/jobs/scenarioFlow';

// «Проверить на живых данных» из редактора: считает ЧЕРНОВИК (flow из тела запроса,
// сохранять не обязательно) по всем работающим менеджерам — значение, база, порог,
// какие блоки выполнятся сегодня и что человек получит. Если передан scenarioId —
// учитывает открытые цепочки и паузы этого сценария. Ничего не пишет и не шлёт;
// работает и при выключенной функции.
export async function POST(req: NextRequest) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  const body = await req.json().catch(() => null) as { scenarioId?: unknown; flow?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  const scenarioId = typeof body.scenarioId === 'string' && /^[0-9a-f-]{36}$/.test(body.scenarioId) ? body.scenarioId : null;
  const { flow, errors } = validateFlow(body.flow);
  if (errors.length) return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
  try {
    const res = await evaluateFlow(flow, scenarioId);
    return NextResponse.json({
      metric: { id: res.metric.id, name: res.metric.nameRu, dataType: res.metric.dataType, decimalPlaces: res.metric.decimalPlaces },
      window: res.window, baselineWindow: res.baselineWindow, evals: res.evals, summary: { ...res.summary, dryPreview: true },
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось посчитать' }, { status: 400 });
  }
}
