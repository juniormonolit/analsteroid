import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadAllWidgetConfigs, saveWidgetConfig } from '@/lib/widget/configStore';
import { validateWidgetConfig } from '@/lib/widget/config';
import { widgetScopeError } from '@/lib/widget/scopeAccess';

// Сессионный CRUD персональных конфигов виджетов. Доступен любому залогиненному:
// данные — те же, что пользователь и так видит в приложении (см. план, RBAC-уточнение).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const configs = await loadAllWidgetConfigs(session.id);
  return NextResponse.json({ configs });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const result = validateWidgetConfig(body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // Аудит 09.09: scope_id не сверялся с правами — сохранить можно было конфиг на
  // чужой филиал/отдел (а /custom по токену потом его отдавал). Разрез вне среза → 403.
  const denied = await widgetScopeError(session, result.config);
  if (denied) return denied;

  await saveWidgetConfig(session.id, result.config);
  return NextResponse.json({ ok: true, config: result.config });
}
