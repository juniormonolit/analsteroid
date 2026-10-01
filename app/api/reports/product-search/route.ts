import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';

// Поиск товара по позициям сделок — для поля «Товар» в «Фильтре сделок»
// (задача владельца 01.10.2026: «хочу выбирать через поиск конкретный товар»).
//
// ПОЧЕМУ ЭТО ПОИСК, А НЕ СПРАВОЧНИК В ВЫПАДАЮЩЕМ СПИСКЕ: в sa.deals.products
// 60 056 разных названий и 37 379 product_id. Отдать такой список в <select>
// нельзя, а главное — не нужно: один товар живёт под десятками названий
// («Роклайт» — 25 строк и 12 product_id), и человеку нужен именно поиск по
// куску названия, который поймает их все.
//
// Эндпоинт НЕ выбирает значение фильтра, а показывает, что поймает подстрока:
// список названий с числом сделок. Человек видит улов до того, как построит
// отчёт, и может уточнить запрос. Само условие фильтра — это подстрока.
//
// ЦЕНА ЗАПРОСА: индекса под ILIKE внутри jsonb нет, это Seq Scan по 259 тыс.
// сделок (замер 01.10: ~1,3 с). Поэтому результат кладём в Redis на 10 минут:
// подбор запроса — это несколько нажатий подряд по одной и той же основе.
export const dynamic = 'force-dynamic';

const MIN_Q = 3;
const LIMIT = 25;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  // Короткая подстрока даёт десятки тысяч совпадений и секунды ожидания ради
  // мусора — лучше честно попросить дописать.
  if (q.length < MIN_Q) return NextResponse.json({ items: [], deals: 0, tooShort: true });
  if (q.length > 100) return NextResponse.json({ error: 'Слишком длинный запрос' }, { status: 400 });

  const key = `dealFilter:productSearch:v1:${q.toLowerCase()}`;
  const data = await cached(key, 600, async () => {
    const db = analyticsDb();
    // Экранируем %/_/\ — иначе «50%» в названии ловил бы всё подряд.
    const like = `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    const res = await db.query<{ name: string; deals: string; lines: string; total: string }>(
      `SELECT pl->>'name' AS name,
              count(DISTINCT d.deal_id)::text AS deals,
              count(*)::text AS lines,
              COALESCE(SUM((pl->>'sum')::numeric), 0)::bigint::text AS total
         FROM sa.deals d, jsonb_array_elements(d.products) pl
        WHERE jsonb_typeof(d.products) = 'array' AND pl->>'name' ILIKE $1
        GROUP BY 1 ORDER BY count(DISTINCT d.deal_id) DESC, 1 LIMIT $2`,
      [like, LIMIT],
    );
    const totals = await db.query<{ names: string; deals: string }>(
      `SELECT count(DISTINCT pl->>'name')::text AS names, count(DISTINCT d.deal_id)::text AS deals
         FROM sa.deals d, jsonb_array_elements(d.products) pl
        WHERE jsonb_typeof(d.products) = 'array' AND pl->>'name' ILIKE $1`,
      [like],
    );
    return {
      items: res.rows.map(r => ({
        name: r.name, deals: Number(r.deals), lines: Number(r.lines), sum: Number(r.total),
      })),
      // Сколько всего названий и сделок поймает подстрока — чтобы человек видел,
      // что список из 25 строк это верхушка, а фильтр возьмёт всё.
      names: Number(totals.rows[0]?.names ?? 0),
      deals: Number(totals.rows[0]?.deals ?? 0),
    };
  });

  return NextResponse.json(data);
}
