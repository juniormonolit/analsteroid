import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseModules } from '@/lib/auth/modulesAccess';
import {
  parseClientRef, saveClientProfile, saveObjectProfile, ProfilesNotReadyError,
} from '@/features/client-module/engine/clientModule';

// Ручные поля модуля «Карточка клиента»: тип клиента / «чем занимается» (на
// клиенте) и стадия стройки / тип дома / заметка (на объекте). Хранятся в sa
// (решение владельца 13.10, миграция migrations/sa_org/005_client_module.sql).
//
// body: { contactId? | companyId?, client?: {clientType, occupation, note},
//         object?: {key, buildStage, houseType, note} }
export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!canUseModules(session)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const ref = parseClientRef(str(body.contactId), str(body.companyId));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });

  try {
    const client = body.client as Record<string, unknown> | undefined;
    const object = body.object as Record<string, unknown> | undefined;
    if (client) await saveClientProfile(ref, { clientType: client.clientType, occupation: client.occupation, note: client.note }, session.login);
    if (object) {
      if (typeof object.key !== 'string' || !object.key) return NextResponse.json({ error: 'Не указан объект' }, { status: 400 });
      await saveObjectProfile(ref, object.key, { buildStage: object.buildStage, houseType: object.houseType, note: object.note }, session.login);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ProfilesNotReadyError) {
      return NextResponse.json({ error: 'Хранилище ручных полей ещё не создано (миграция sa_org/005) — сохранение недоступно' }, { status: 503 });
    }
    console.error('[modules/client-card/profile]', e);
    return NextResponse.json({ error: 'Не удалось сохранить' }, { status: 500 });
  }
}
