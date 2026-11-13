import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import {
  AutoBrakError, canAutoBrak, cleanRule, collectCandidates, deleteRule, fetchBatches, fetchBatchItems, fetchRules, revertBatch, saveRule, startBatch,
} from '@/features/repeat-kanban/engine/autoBrak';

// Автобрак по фильтру колонки (миграция 265). Правила, применение, журнал, откат — РОП и старше, по своей зоне.
// Предпросмотр («сколько останется / уйдёт») — GET /api/repeat-kanban?abPreview=… (считается на доске зоны).
//   GET ?column=           — правило колонки и журнал партий
//   GET ?batch=            — заказчики партии
//   POST {action:'save', column, mode, filters, reason, comment?, auto}
//   POST {action:'delete', column}
//   POST {action:'apply', column, mode, filters, reason, comment?} — брак всем кандидатам сейчас (в фоне)
//   POST {action:'revert', batchId} — снять брак со всех заказчиков партии
export const dynamic = 'force-dynamic';

async function guard() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (!hasPerm(session, 'section.repeat_kanban')) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  if (!(await canAutoBrak(session))) return { error: NextResponse.json({ error: 'Автобрак — РОПу и старше' }, { status: 403 }) };
  return { session };
}
const fail = (e: unknown, what: string) => {
  if (e instanceof AutoBrakError) return NextResponse.json({ error: e.message }, { status: 400 });
  console.error(`[auto-brak ${what}]`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: 'Не удалось выполнить' }, { status: 500 });
};

export async function GET(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const sp = req.nextUrl.searchParams;
  try {
    const batch = Number(sp.get('batch'));
    if (Number.isInteger(batch) && batch > 0) return NextResponse.json({ items: await fetchBatchItems(g.session.id, batch) }, { headers: { 'Cache-Control': 'no-store' } });
    const column = sp.get('column');
    const rules = await fetchRules(g.session.id);
    return NextResponse.json({ rule: column ? rules.find(r => r.column === column) ?? null : null, rules, batches: await fetchBatches(g.session.id, column) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return fail(e, 'GET'); }
}

export async function POST(req: NextRequest) {
  const g = await guard();
  if (g.error) return g.error;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  try {
    if (body.action === 'save') return NextResponse.json({ ok: true, rule: await saveRule(g.session, body) });
    if (body.action === 'delete') { await deleteRule(g.session, String(body.column ?? '')); return NextResponse.json({ ok: true }); }
    if (body.action === 'revert') {
      const id = Number(body.batchId);
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Не указана партия' }, { status: 400 });
      return NextResponse.json({ ok: true, restored: await revertBatch(g.session, id) });
    }
    if (body.action === 'apply') {
      const rule = cleanRule(body);
      const saved = (await fetchRules(g.session.id)).find(r => r.column === rule.column);
      const cands = await collectCandidates(g.session, rule);
      if (!cands.length) return NextResponse.json({ ok: true, batchId: null, total: 0 });
      // Защита от дурака (13.11): человек подтвердил конкретное число («Я подтверждаю, что в брак уйдут N»). Список успел
      // заметно разойтись (кто-то купил/поставили задачи/сменили фильтр в другой вкладке) — не браковать, пусть пересмотрит.
      const expectN = Number(body.expectN);
      if (!Number.isInteger(expectN) || expectN <= 0) return NextResponse.json({ error: 'Нет подтверждённого числа — откройте предпросмотр и подтвердите заново' }, { status: 400 });
      if (cands.length > expectN + Math.max(3, Math.ceil(expectN * 0.05))) {
        return NextResponse.json({ error: `Подтверждали ${expectN}, а сейчас под фильтр попадает ${cands.length} — проверьте предпросмотр и подтвердите заново` }, { status: 409 });
      }
      const batchId = await startBatch(g.session, rule, saved?.id ?? null, false, cands);
      return NextResponse.json({ ok: true, batchId, total: cands.length });
    }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (e) { return fail(e, String(body.action)); }
}
