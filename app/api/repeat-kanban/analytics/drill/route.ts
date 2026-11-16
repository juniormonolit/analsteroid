import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canSeeKanbanAnalytics } from '@/features/repeat-kanban/engine/analyticsAccess';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { analyticsDb } from '@/lib/db/clients';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';
import { REPEAT_PROJECT_GROUP_ID } from '@/features/repeat-kanban/engine/config';

// Дриллдаун аналитики канбана повторных (владелец 16.11: «цифры нажимабельными с дриллдауном на сделки, как в основных
// отчётах»). Список задач строится в браузере из уже загруженного «Результата»; здесь — только подписи: имя заказчика
// (кэш client_names, без Битрикса) и названия/стадии/суммы сделок (sa.deals). Отдаём только по задачам проекта в зоне
// смотрящего и только сделки заказчиков этих задач.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban') || !(await canSeeKanbanAnalytics(session))) return NextResponse.json({ error: 'Аналитика — РОПам и выше' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { taskIds?: unknown; dealIds?: unknown };
  const taskIds = (Array.isArray(body.taskIds) ? body.taskIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 2000);
  const dealIds = (Array.isArray(body.dealIds) ? body.dealIds : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 6000);
  if (!taskIds.length) return NextResponse.json({ deals: {}, names: {} });
  try {
    const db = analyticsDb();
    const scope = await ropScope(session);
    const zone = scope.full ? null : new Set((await scopeManagers(scope)).map(m => m.id));
    const tasks = (await db.query<{ task_id: string; deal_id: string | null; responsible_id: string | null }>(
      `SELECT task_id::text, deal_id::text, responsible_id::text FROM sa.bitrix_task_current WHERE task_id = ANY($1::bigint[]) AND group_id = $2`,
      [taskIds, REPEAT_PROJECT_GROUP_ID],
    )).rows.filter(t => !zone || (t.responsible_id && zone.has(t.responsible_id)));
    const taskDeals = tasks.map(t => Number(t.deal_id)).filter(Boolean);
    const own = (await db.query<{ company_id: string | null; contact_id: string | null }>(
      `SELECT company_id::text, contact_id::text FROM sa.deals WHERE deal_id = ANY($1::bigint[])`, [taskDeals],
    )).rows;
    const companies = [...new Set(own.map(r => Number(r.company_id)).filter(Boolean))];
    const contacts = [...new Set(own.map(r => Number(r.contact_id)).filter(Boolean))];
    const rows = (await db.query<{ deal_id: string; deal_name: string | null; stage: string | null; amount: string | null; funnel_id: number; company_id: string | null; contact_id: string | null }>(
      `SELECT d.deal_id::text, d.deal_name, s.name AS stage, d.amount::text, d.funnel_id, d.company_id::text, d.contact_id::text
         FROM sa.deals d LEFT JOIN sa.stages s ON s.id = d.stage_id
        WHERE d.deal_id = ANY($1::bigint[])
          AND (d.deal_id = ANY($2::bigint[]) OR d.company_id = ANY($3::bigint[]) OR d.contact_id = ANY($4::bigint[]))`,
      [[...new Set([...dealIds, ...taskDeals])], taskDeals, companies, contacts],
    )).rows;
    const deals: Record<string, { name: string | null; stage: string | null; amount: number | null; funnel: number }> = {};
    for (const r of rows) deals[r.deal_id] = { name: r.deal_name, stage: r.stage, amount: r.amount !== null ? Math.round(Number(r.amount)) : null, funnel: r.funnel_id };
    const keys = [...companies.map(id => `k${id}`), ...contacts.flatMap(id => [`c${id}`, `x${id}`])];
    const cached = await getCachedClientNames(keys);
    const names: Record<string, string> = {};
    for (const id of companies) { const n = cached.get(`k${id}`); if (n) names[`k${id}`] = n; }
    for (const id of contacts) { const n = cached.get(`c${id}`) ?? cached.get(`x${id}`); if (n) names[`p${id}`] = n; }
    return NextResponse.json({ deals, names }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban drill]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось загрузить сделки' }, { status: 500 });
  }
}
