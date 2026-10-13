import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canUseModules } from '@/lib/auth/modulesAccess';
import {
  parseClientRef, saveClientProfile, saveObjectProfile,
  ProfilesNotReadyError, BitrixWriteError, MirrorWriteError, type ObjectSaveInput,
} from '@/features/client-module/engine/clientModule';

// Ручные поля модуля «Карточка клиента». Источник правды — Битрикс (решение
// владельца 13.10): пишем туда, при успехе — копию в sa.
//   клиент: тип клиента, «чем занимается», заметка (поля контакта/компании);
//   объект: элемент смарт-процесса «Объекты» — «Адрес идеальный» + точка,
//           стадия стройки, тип дома, заметка.
//
// body: { contactId? | companyId?, client?: {clientType, occupation, note},
//         object?: {key, buildStage, houseType, note, ideal?: {address, lat, lon}, address1c?} }
// key = 'new' — новый объект, заведённый вручную; в ответе — его ключ.
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
    const object = body.object as (ObjectSaveInput & { key?: unknown }) | undefined;
    if (client) await saveClientProfile(ref, { clientType: client.clientType, occupation: client.occupation, note: client.note }, session.login);
    let objectKey: string | null = null;
    if (object) {
      if (typeof object.key !== 'string' || !object.key) return NextResponse.json({ error: 'Не указан объект' }, { status: 400 });
      objectKey = await saveObjectProfile(ref, object.key, object, session.login);
    }
    return NextResponse.json({ ok: true, objectKey });
  } catch (e) {
    if (e instanceof BitrixWriteError) {
      console.error('[modules/client-card/profile] Битрикс:', e.message);
      return NextResponse.json({ error: `Битрикс не принял изменения — ничего не сохранено. ${e.message}` }, { status: 502 });
    }
    if (e instanceof ProfilesNotReadyError) {
      return NextResponse.json({ error: 'Хранилище ручных полей в sa недоступно — сохранение невозможно' }, { status: 503 });
    }
    if (e instanceof MirrorWriteError) {
      console.error('[modules/client-card/profile] sa:', e.message);
      return NextResponse.json({ ok: true, objectKey: null, warning: 'В Битрикс сохранено, но копия в Монолитике не обновилась — подтянется ночной сверкой' });
    }
    console.error('[modules/client-card/profile]', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось сохранить' }, { status: 500 });
  }
}
