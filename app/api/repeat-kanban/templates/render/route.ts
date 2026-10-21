import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { canManageRepeatKanbanSettings, canSessionSeeClientRef } from '@/lib/auth/modulesAccess';
import {
  SettingsError, CLIENT_KEY_RE, MANAGER_ID_RE, getTemplate, renderTemplate, sampleClient, clientManagerId,
} from '@/features/repeat-kanban/engine/settings';

// Текст задачи по шаблону (владелец 21.10): окно постановки задачи канбана повторных
// и предпросмотр в редакторе шаблонов.
//   POST { clientKey, managerId?, templateId? } → { text, templateId, clientKey, managerId }
//   без templateId — шаблон по умолчанию; без managerId — менеджер заказчика по атрибуции.
// Только для админов (редактор): body — несохранённый текст вместо шаблона;
// sample: true — взять любого заказчика с последней отгрузкой.
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Нет доступа к канбану повторных' }, { status: 403 });
  const b = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return NextResponse.json({ error: 'Пустой запрос' }, { status: 400 });
  const admin = canManageRepeatKanbanSettings(session);

  try {
    let clientKey = typeof b.clientKey === 'string' ? b.clientKey.trim().toLowerCase() : '';
    let managerId = typeof b.managerId === 'string' || typeof b.managerId === 'number' ? String(b.managerId).trim() : '';
    if (!clientKey && b.sample === true && admin) {
      const s = await sampleClient();
      if (!s) return NextResponse.json({ error: 'Не нашли заказчика с отгрузкой для примера' }, { status: 404 });
      clientKey = s.clientKey; managerId = s.managerId;
    }
    if (!CLIENT_KEY_RE.test(clientKey)) return NextResponse.json({ error: 'Заказчик — ключ вида c123, k456 или x789' }, { status: 400 });
    if (managerId && !MANAGER_ID_RE.test(managerId)) return NextResponse.json({ error: 'Некорректный менеджер' }, { status: 400 });
    // РОП видит только свою зону — и текст по заказчику чужой зоны собрать не даём.
    if (!admin && !(await canSessionSeeClientRef(session, clientKey.replace(/^x/, 'c')))) {
      return NextResponse.json({ error: 'Этот заказчик вне вашей зоны' }, { status: 403 });
    }
    if (!managerId) managerId = (await clientManagerId(clientKey)) ?? '';

    let body: string;
    let templateId: number | null = null;
    if (admin && typeof b.body === 'string') {
      body = b.body.slice(0, 5000);
    } else {
      const rawId = b.templateId;
      const id = rawId === undefined || rawId === null || rawId === '' ? null : Number(rawId);
      if (id !== null && !(Number.isInteger(id) && id > 0)) return NextResponse.json({ error: 'Некорректный шаблон' }, { status: 400 });
      const t = await getTemplate(id);
      if (!t) return NextResponse.json({ error: id ? 'Шаблон не найден' : 'Шаблонов ещё нет' }, { status: 404 });
      body = t.body; templateId = t.id;
    }
    const text = await renderTemplate(body, { clientKey, managerId });
    return NextResponse.json({ text, templateId, clientKey, managerId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof SettingsError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error('[repeat-kanban render]', e instanceof Error ? e.message : e);
    const missing = e instanceof Error && /relation .* does not exist/i.test(e.message);
    return NextResponse.json({ error: missing ? 'Таблицы шаблонов ещё не созданы (миграция 233)' : 'Не удалось собрать текст по шаблону' }, { status: 500 });
  }
}
