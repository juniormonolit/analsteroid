import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';

// Справочник товарных групп для мультиселект-фильтра раздела «Графики» (задача
// 29.07). Список зависит от ВЫБРАННОЙ ШКАЛЫ (kc/by_max — они несовместимы, между
// ними нет маппинга в БД, см. бриф задачи):
//  * kc     — sa.product_groups (активные, ~96 строк), id — числовой FK
//    (d.product_group_id).
//  * by_max — sa.head_groups (справочник «по наибольшему»); фильтрация в SQL идёт
//    по СТРОКЕ d.head_group_name (свободный текст на сделке), поэтому здесь
//    отдаём DISTINCT name — то же множество значений, что реально встречается на
//    сделках, а не потенциально более широкий/узкий справочник head_groups.
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const mode = req.nextUrl.searchParams.get('mode') === 'by_max' ? 'by_max' : 'kc';
  const db = analyticsDb();

  if (mode === 'by_max') {
    const res = await db.query<{ name: string }>(
      `SELECT DISTINCT head_group_name AS name FROM deals WHERE head_group_name IS NOT NULL ORDER BY 1`,
    );
    return NextResponse.json({ groups: res.rows.map(r => ({ id: r.name, name: r.name })) });
  }

  const res = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM sa.product_groups WHERE is_active = true ORDER BY name`,
  );
  return NextResponse.json({ groups: res.rows.map(r => ({ id: String(r.id), name: r.name })) });
}
