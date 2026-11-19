import { NextRequest, NextResponse } from 'next/server';
import type { TriggerResponse } from '@/features/logist-kanban/engine/requests/contract';
import { err, toErrorResponse, NO_STORE } from '@/features/logist-kanban/engine/requests/http';
import { authenticateTrigger, parseTypeHint, pickDealId, runTrigger } from '@/features/logist-kanban/engine/requests/trigger';

// POST /api/logist-requests/trigger?key=<LOGIST_TRIGGER_SECRET>&deal={{ID}} — робот «Исходящий вебхук» Битрикса
// на стадиях «Сделал запрос снабженцу…» / «Есть цена дешевле…» (4 воронки). Сессии нет — доступ по секрету в URL,
// fail-closed (секрет не задан → 503 всем). В proxy.ts — в PUBLIC. Инструкция админу портала —
// ai_docs/fresh_docs/LOGIST_REQUESTS_SPEC.md, «Робот на стадиях». Логика — engine/requests/trigger.ts.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let notConfiguredWarned = false;

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('application/json')) {
      const j = await req.json();
      return j && typeof j === 'object' ? j as Record<string, unknown> : {};
    }
    if (ct.includes('form')) {
      const f = await req.formData();
      const o: Record<string, unknown> = {};
      for (const [k, v] of f.entries()) if (typeof v === 'string') o[k] = v;
      return o;
    }
  } catch { /* пустое/битое тело — id сделки может быть в URL */ }
  return {};
}

async function handle(req: NextRequest): Promise<Response> {
  const q = req.nextUrl.searchParams;
  const body = req.method === 'POST' ? await readBody(req) : {};
  const auth = authenticateTrigger(q.get('key'), body);
  if (!auth.ok) {
    if (auth.reason === 'not_configured') {
      if (!notConfiguredWarned) { console.warn('[logist-requests/trigger] LOGIST_TRIGGER_SECRET не задан — вебхук робота отклоняется'); notConfiguredWarned = true; }
      return err('Триггер не настроен', 503);
    }
    console.warn(`[logist-requests/trigger] отказ: ${auth.reason}, ключ ${auth.hint}`);
    return err('Forbidden', 403, 'forbidden');
  }
  const dealId = pickDealId(q, body);
  if (!dealId) return err('Нет id сделки (?deal={{ID}})', 400, 'invalid');
  try {
    const res: TriggerResponse = await runTrigger(dealId, parseTypeHint(q.get('type')));
    console.log(`[logist-requests/trigger] сделка ${dealId}: ${res.result}${res.requestId ? ` №${res.requestId} (${res.status})` : ''}${res.draftReason ? ` — черновик: ${res.draftReason}` : ''}`);
    return NextResponse.json(res, { headers: NO_STORE });
  } catch (e) {
    return toErrorResponse(e, `trigger deal ${dealId}`);
  }
}

export const POST = handle;
// GET — тот же путь: в роботе «Исходящий вебхук» метод не выбрать на некоторых тарифах; ручная проверка из браузера.
export const GET = handle;
