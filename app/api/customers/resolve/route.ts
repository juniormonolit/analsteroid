import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { CLIENT_KEY_CASE_SQL } from '@/features/customers/engine/clientKey';

// Резолвер «сырой id из сделки → (clientKey, менеджер-владелец)» для сквозной
// навигации в карточку заказчика (задача 17.08, фикс «Заказчик не найден в списке
// этого менеджера»). Двойная причина бага:
//   1) ключ: юр-сделки живут в списках заказчиков под 'k<company_id>' (или
//      'x<contact_id>' — юр без карточки компании, фикс химеры k0, задача 2776),
//      а навигация слала 'c<contact_id>' всегда;
//   2) владелец: клиент принадлежит менеджеру своей ПОСЛЕДНЕЙ сделки (attr в
//      customers.ts), а не менеджеру кликнутой.
// Оба правила здесь зеркалят движок: ключ — CLIENT_KEY_CASE_SQL (единая формула,
// clientKey.ts), владелец — DISTINCT ON (key) ORDER BY created_at DESC.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const contactId = sp.get('contactId');
  const companyId = sp.get('companyId');
  if ((!contactId || !/^\d+$/.test(contactId)) && (!companyId || !/^\d+$/.test(companyId))) {
    return NextResponse.json({ error: 'contactId или companyId обязателен' }, { status: 400 });
  }

  const db = analyticsDb();
  let cardKey: string | null = null;
  if (companyId) {
    cardKey = `k${companyId}`;
  } else {
    // Ключ — по последней сделке контакта, У КОТОРОЙ КЛЮЧ ЕСТЬ. Живой баг второй
    // итерации (скриншот владельца 17.08): юр-сделка с company_id IS NULL даёт в
    // формуле NULL («пропуск» — сознательно вне скоупа фикса 2776, 10 969 сделок на
    // проде), и если ПОСЛЕДНЯЯ сделка контакта именно такая — резолв возвращал
    // «ключа нет», хотя у клиента есть нормально ключуемые сделки (c/x/k) раньше.
    const r = await db.query<{ card_key: string | null }>(
      `SELECT (${CLIENT_KEY_CASE_SQL}) AS card_key
         FROM sa.deals d
        WHERE d.contact_id = $1 AND d.funnel_id IN (0,1,2,3)
          AND (${CLIENT_KEY_CASE_SQL}) IS NOT NULL
        ORDER BY d.created_at DESC, d.deal_id DESC
        LIMIT 1`,
      [Number(contactId)],
    );
    cardKey = r.rows[0]?.card_key ?? null;
  }
  if (!cardKey) return NextResponse.json({ clientKey: null, managerId: null });

  const owner = await db.query<{ mgr: string | null }>(
    `SELECT d.current_manager_id::text AS mgr
       FROM sa.deals d
      WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_CASE_SQL}) = $1
      ORDER BY d.created_at DESC, d.deal_id DESC
      LIMIT 1`,
    [cardKey],
  );
  return NextResponse.json({ clientKey: cardKey, managerId: owner.rows[0]?.mgr ?? null });
}
