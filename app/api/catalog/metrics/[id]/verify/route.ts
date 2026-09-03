import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { ycAnalyticsDb } from '@/lib/db/clients';
import { invalidateMetricsCache } from '@/lib/metrics/catalog';

// Отметка «Проверено» у метрики каталога (миграция 192). Ставит и снимает ТОЛЬКО
// супер-админ: это ручная сверка владельца с Битриксом, а не редакторское право
// раздела «Метрики» (section.metrics), поэтому гейт — superadminError, а не permError.
// Правка определения метрики через PUT /api/admin/metrics/[id] сбрасывает отметку
// сама — здесь только ручной тумблер.
//
// Тело: { verified: boolean }. Ответ: { id, verifiedAt: ISO|null, verifiedBy: login|null }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  const denied = superadminError(session);
  if (denied) return denied;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.verified !== 'boolean') {
    return NextResponse.json({ error: 'verified должен быть boolean' }, { status: 400 });
  }
  const verified: boolean = body.verified;
  // superadminError выше уже гарантировал сессию — `?.` только для сужения типа.
  const login = session?.login ?? null;

  const db = ycAnalyticsDb();
  const res = await db.query<{ verified_at: Date | string | null; verified_by: string | null }>(`
    UPDATE metrics SET
      verified_at = CASE WHEN $2::boolean THEN now() ELSE NULL END,
      verified_by = CASE WHEN $2::boolean THEN $3::text ELSE NULL END
    WHERE id = $1
    RETURNING verified_at, verified_by
  `, [id, verified, login]);

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Метрика не найдена' }, { status: 404 });
  }

  // loadMetrics() кэширует каталог на 5 минут — иначе галочка «догонит» UI с опозданием.
  invalidateMetricsCache();

  const row = res.rows[0];
  return NextResponse.json({
    id,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    verifiedBy: row.verified_by ?? null,
  });
}
