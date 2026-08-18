import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Сохранённые графики конструктора (миграция 162, задача владельца 18.08).
// Личный список: каждый видит и правит только свои (user_login из сессии) —
// та же модель, что у saved_reports. Имя уникально в пределах пользователя,
// повторное сохранение под тем же именем ПЕРЕЗАПИСЫВАЕТ конфиг (upsert): это
// ожидаемое «пересохранил график», а не ошибка.

interface ChartConfig {
  mode: string;            // by-managers | by-product-groups | by-amount-buckets
  chartType: string;       // bar | line | scatter
  grouping: string;        // none | team | branch
  yMetricIds: string[];
  xMetricId: string | null;
  dealScope: string;       // пилюли страницы — часть смысла графика,
  clientType: string;      // сохраняем и применяем при загрузке
  productGroupMode: string;
  productGroupIds: string[];
}

const STR = (v: unknown, fallback: string, max = 64): string =>
  typeof v === 'string' && v.length <= max ? v : fallback;
const IDS = (v: unknown, maxLen = 30): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 128).slice(0, maxLen) : [];

function sanitizeConfig(raw: unknown): ChartConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    mode:             STR(o.mode, 'by-managers'),
    chartType:        STR(o.chartType, 'bar'),
    grouping:         STR(o.grouping, 'none'),
    yMetricIds:       IDS(o.yMetricIds, 4),
    xMetricId:        typeof o.xMetricId === 'string' && o.xMetricId.length <= 128 ? o.xMetricId : null,
    dealScope:        STR(o.dealScope, 'primary'),
    clientType:       STR(o.clientType, 'all'),
    productGroupMode: STR(o.productGroupMode, 'kc'),
    productGroupIds:  IDS(o.productGroupIds, 100),
  };
}

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const res = await systemDb().query<{ id: string; name: string; config: ChartConfig }>(
    `SELECT id, name, config FROM saved_charts WHERE user_login = $1 ORDER BY name`,
    [session.login],
  );
  return NextResponse.json({ charts: res.rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null) as { name?: unknown; config?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
  if (!name) return NextResponse.json({ error: 'Дайте графику имя' }, { status: 400 });
  const config = sanitizeConfig(body?.config);
  const res = await systemDb().query<{ id: string }>(
    `INSERT INTO saved_charts (user_login, name, config) VALUES ($1, $2, $3)
     ON CONFLICT (user_login, name) DO UPDATE SET config = EXCLUDED.config, updated_at = now()
     RETURNING id`,
    [session.login, name, JSON.stringify(config)],
  );
  return NextResponse.json({ ok: true, id: res.rows[0].id, name, config });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'id обязателен' }, { status: 400 });
  await systemDb().query(`DELETE FROM saved_charts WHERE id = $1 AND user_login = $2`, [id, session.login]);
  return NextResponse.json({ ok: true });
}
