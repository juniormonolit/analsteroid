import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';

// «Путь клиента» — цепочка покупок заказчика по товарным группам (задача владельца
// 17.08: «дерево развития»: первая сделка → интервал → следующая → …, у каждой —
// группы ПО ПОЗИЦИЯМ с суммами; если групп в сделке несколько — показать все).
//
// Покупка = отгрузка (delivered_at) — та же ось, что у клиентских метрик/LTV.
// Разбор групп — по товарным позициям (jsonb products: head_group_name + sum),
// сервисные позиции (доставка и т.п.) НЕ выкидываются: клиент их оплатил, в сумме
// сделки они есть — прячем их только из «категорийных» метрик, а тут показываем
// как есть, иначе суммы групп не сойдутся с суммой сделки.
// Категория КЦ — product_group_id сделки (шкала КЦ, одна на сделку).
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const contactId = sp.get('contactId');
  const companyId = sp.get('companyId');
  if ((!contactId || !/^\d+$/.test(contactId)) && (!companyId || !/^\d+$/.test(companyId))) {
    return NextResponse.json({ error: 'contactId или companyId обязателен' }, { status: 400 });
  }
  const where = companyId ? 'd.company_id = $1' : 'd.contact_id = $1';
  const id = Number(companyId ?? contactId);

  const res = await analyticsDb().query<{
    deal_id: number; deal_name: string | null; amount: string | null;
    delivered_at: string; head_group_name: string | null; kc_name: string | null;
    groups: { name: string | null; sum: number }[] | null;
  }>(
    `SELECT d.deal_id, d.deal_name, d.amount, d.delivered_at,
            d.head_group_name, pg.name AS kc_name,
            (SELECT jsonb_agg(g) FROM (
               SELECT COALESCE(p->>'head_group_name', 'Без группы') AS name,
                      SUM((p->>'sum')::numeric)::float8 AS sum
                 FROM jsonb_array_elements(d.products) p
                GROUP BY 1 ORDER BY 2 DESC
             ) g) AS groups
       FROM sa.deals d
       LEFT JOIN product_groups pg ON pg.id = d.product_group_id
      WHERE ${where}
        AND d.delivered_at IS NOT NULL
        AND d.funnel_id NOT IN (4, 7)
      ORDER BY d.delivered_at ASC, d.deal_id ASC`,
    [id],
  );

  return NextResponse.json({
    purchases: res.rows.map(r => ({
      dealId: r.deal_id,
      dealName: r.deal_name,
      amount: Number(r.amount ?? 0),
      deliveredAt: new Date(r.delivered_at).toISOString(),
      headGroup: r.head_group_name,
      kcCategory: r.kc_name,
      groups: r.groups ?? [],
    })),
  });
}
