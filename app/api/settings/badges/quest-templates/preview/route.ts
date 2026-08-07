import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { systemDb, analyticsDb } from '@/lib/db/clients';
import { validateTemplate } from '@/features/quests/engine/templates';
import { previewTemplate } from '@/features/quests/engine/quests';

// Предпросмотр шаблона квеста (задача 60): что он выдал бы прямо сейчас живым
// менеджерам. Шаблон приходит из формы НЕСОХРАНЁННЫМ — смысл именно в том,
// чтобы увидеть цифры до того, как включишь.

/** Выборка менеджеров для примера: сильный, средний и слабый по продажам за
 *  90 дней. Три случайных дали бы три похожие строки и ничего не показали бы
 *  про край шкалы — а именно на краях шаблоны и ломаются. */
async function sampleManagers(limit: number): Promise<number[]> {
  const r = await analyticsDb().query<{ m: number }>(`
    WITH ranked AS (
      SELECT current_manager_id AS m, count(*) AS n,
             ntile(3) OVER (ORDER BY count(*) DESC) AS band
      FROM sa.deals
      WHERE sold_at >= now() - interval '90 days' AND current_manager_id IS NOT NULL
      GROUP BY 1 HAVING count(*) >= 3
    )
    SELECT m FROM (
      SELECT m, band, row_number() OVER (PARTITION BY band ORDER BY n DESC) AS rn FROM ranked
    ) x WHERE rn <= $1 ORDER BY band, rn
  `, [Math.max(1, Math.ceil(limit / 3))]);
  return r.rows.map(x => Number(x.m));
}

export async function POST(req: Request) {
  const session = await getSession();
  const err = superadminError(session);
  if (err) return err;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 }); }

  const v = validateTemplate(body);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  try {
    const mgrs = await sampleManagers(6);
    if (mgrs.length === 0) return NextResponse.json({ rows: [], note: 'Нет менеджеров с продажами за 90 дней' });
    const rows = await previewTemplate(systemDb(), { id: 0, ...v.value }, mgrs);
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Не удалось посчитать предпросмотр' }, { status: 500 },
    );
  }
}
