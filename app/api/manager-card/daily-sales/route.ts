// Динамика продаж по дням для ЛК менеджера/отдела (график в «Карточке 10.0»).
// POST { managerId } | { mode:'department', departmentId } + { from, to, segment? }.
// Дни без продаж заполняются нулями — график честный, без «склеенных» провалов.

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { resolveManagersForDepartments, getUserDepartmentOptions } from '@/lib/org/teamRoster';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const from = new Date(String(body.from ?? ''));
  const to = new Date(String(body.to ?? ''));
  if (isNaN(+from) || isNaN(+to)) return NextResponse.json({ error: 'from/to (ISO) обязательны' }, { status: 400 });
  const segment = body.segment === 'fl' ? 'fl' : body.segment === 'ul' ? 'ul' : 'all';

  try {
    let managerIds: string[];
    if (body.mode === 'department') {
      const departmentId = String(body.departmentId ?? '');
      // 'my' — отделы по оргструктуре «Контроля звонков» (ЛК РОПа/директора)
      const deptIds = departmentId === 'my'
        ? (session.bitrixUserId ? (await getCallControlManagedDepts(session.bitrixUserId)).map(m => m.deptId) : [])
        : departmentId === 'all'
          ? (await getUserDepartmentOptions(session.id)).map(o => o.id)
          : [departmentId];
      managerIds = (await resolveManagersForDepartments(deptIds)).map(m => m.managerId);
    } else {
      const managerId = String(body.managerId ?? '');
      if (!/^\d+$/.test(managerId)) return NextResponse.json({ error: 'managerId (число) обязателен' }, { status: 400 });
      managerIds = [managerId];
    }
    const idsNum = managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (idsNum.length === 0) return NextResponse.json({ days: [] });

    // Сегментация — те же funnel_id-наборы, что funnel_type b2c/b2b в lib/metrics/sqlGen.ts
    const segmentWhere = segment === 'fl' ? 'AND d.funnel_id IN (0, 2)' : segment === 'ul' ? 'AND d.funnel_id IN (1, 3)' : '';

    const res = await analyticsDb().query<{ date: string; sales_count: string; sales_amount: string }>(
      `SELECT to_char(d.sold_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS date,
              COUNT(DISTINCT d.deal_id) AS sales_count,
              COALESCE(SUM(d.amount), 0) AS sales_amount
         FROM deals d
        WHERE d.sold_at >= $1 AND d.sold_at < $2
          AND d.current_manager_id IN (${idsNum.join(',')})
          ${segmentWhere}
        GROUP BY 1 ORDER BY 1`,
      [from.toISOString(), to.toISOString()],
    );
    const byDate = new Map(res.rows.map(r => [r.date, { salesCount: Number(r.sales_count), salesAmount: Number(r.sales_amount) }]));

    // Плотный ряд дат (МСК-даты границ периода)
    const days: { date: string; salesCount: number; salesAmount: number }[] = [];
    const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }); // YYYY-MM-DD
    for (let t = +from; t <= +to && days.length < 400; t += 86_400_000) {
      const date = fmt.format(new Date(t));
      if (days.length && days[days.length - 1].date === date) continue;
      days.push({ date, ...(byDate.get(date) ?? { salesCount: 0, salesAmount: 0 }) });
    }
    return NextResponse.json({ days });
  } catch (e) {
    console.error('[manager-card/daily-sales] failed:', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка графика' }, { status: 500 });
  }
}
