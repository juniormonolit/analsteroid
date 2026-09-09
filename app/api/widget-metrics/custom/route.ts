import { NextRequest, NextResponse } from 'next/server';
import { resolveWidgetTokenUser } from '@/lib/widget/tokens';
import { loadWidgetConfig } from '@/lib/widget/configStore';
import { getCachedWidgetMetrics } from '@/lib/jobs/widgetMetrics';
import { sliceForConfig } from '@/lib/widget/resolve';
import { loadWidgetScopeAccess, widgetConfigForbidden } from '@/lib/widget/scopeAccess';
import { loadSessionUserByLogin } from '@/lib/auth/session';
import { systemDb } from '@/lib/db/clients';

// Публичный эндпоинт для Scriptable-виджета. Авторизация — персональный bearer-токен в query
// (?token=), как у легаси /widget-metrics/plan. Данные — готовый срез из Redis (widget:metrics),
// расчёт НЕ триггерится (джоба считает фоном) → Redis не «сходит с ума».
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const token = sp.get('token') ?? '';
  const family = sp.get('family') ?? 'medium';
  const param = sp.get('param') ?? '';

  const userId = await resolveWidgetTokenUser(token);
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const config = await loadWidgetConfig(userId, family, param);
  if (!config) {
    return NextResponse.json({ error: 'Виджет не настроен — откройте «Конструктор виджетов»' }, { status: 404 });
  }

  // Аудит 09.09: конфиг мог указывать любой филиал/отдел — разрез сверяется со срезом
  // ВЛАДЕЛЬЦА токена. Токен → user_id → login → SessionUser с ролью (тот же SELECT,
  // что у cookie-сессии) → getSessionScope. Пользователь деактивирован — 401 (как и
  // токен без владельца); разрез вне среза — 403 с подсказкой пересобрать виджет.
  const userRow = await systemDb().query<{ login: string }>('SELECT login FROM users WHERE id = $1', [userId]);
  const owner = userRow.rows[0] ? await loadSessionUserByLogin(userRow.rows[0].login) : null;
  if (!owner) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await loadWidgetScopeAccess(owner);
  if (!access.allows(config)) return widgetConfigForbidden();

  const blob = await getCachedWidgetMetrics();
  if (!blob) return NextResponse.json({ error: 'Данные ещё не рассчитаны или устарели' }, { status: 503 });

  const slice = sliceForConfig(blob, config);
  if (!slice) return NextResponse.json({ error: 'Разрез недоступен (пересоберите виджет)' }, { status: 404 });

  return NextResponse.json(slice);
}
