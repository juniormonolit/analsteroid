import { NextRequest, NextResponse } from 'next/server';
import { moduleActor } from '@/lib/bitrix/widgetGrant';
import {
  parseClientRef, saveClientProfile, saveObjectProfile, saveDealObject,
  ProfilesNotReadyError, BitrixWriteError, MirrorWriteError, V2NotReadyError, type ObjectSaveInput,
} from '@/features/client-module/engine/clientModule';

// Ручные поля модуля «Карточка клиента» (решения владельца 13.10):
//   клиент — тип клиента, «чем занимается», заметка: СНАЧАЛА Битрикс (поля
//            контакта/компании), при успехе — копия в sa;
//   объект — только Монолитика (sa): адрес (правка/подтверждение), статус
//            «Завершён» вручную, стадия стройки, тип дома, заметка;
//   сделка — ручная привязка к объекту (если автоматическая по адресу ошиблась).
//
// body: { contactId? | companyId?, client?: {clientType, occupation, note},
//         object?: {key, buildStage?, houseType?, note?, ideal?: {address, lat, lon}, confirmAddress?, done?},
//         deal?: {dealId, objectKey} }   // objectKey '' — вернуть автоматическую привязку
// object.key = 'new' — новый объект, заведённый вручную; в ответе — его ключ.
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Некорректный запрос' }, { status: 400 });
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
  const ref = parseClientRef(str(body.contactId), str(body.companyId));
  if (!ref) return NextResponse.json({ error: 'Укажите ID контакта или компании' }, { status: 400 });
  const actor = await moduleActor(req, ref);
  if (!actor) return NextResponse.json({ error: 'Нет доступа — откройте карточку клиента заново' }, { status: 403 });

  try {
    const client = body.client as Record<string, unknown> | undefined;
    const object = body.object as (ObjectSaveInput & { key?: unknown }) | undefined;
    if (client) await saveClientProfile(ref, { clientType: client.clientType, occupation: client.occupation, note: client.note }, actor);
    let objectKey: string | null = null;
    if (object) {
      if (typeof object.key !== 'string' || !object.key) return NextResponse.json({ error: 'Не указан объект' }, { status: 400 });
      objectKey = await saveObjectProfile(ref, object.key, object, actor);
    }
    const deal = body.deal as { dealId?: unknown; objectKey?: unknown } | undefined;
    if (deal) {
      const dealId = Number(deal.dealId);
      if (!Number.isInteger(dealId) || dealId <= 0 || typeof deal.objectKey !== 'string') return NextResponse.json({ error: 'Некорректная сделка' }, { status: 400 });
      await saveDealObject(ref, dealId, deal.objectKey, actor);
    }
    return NextResponse.json({ ok: true, objectKey });
  } catch (e) {
    if (e instanceof BitrixWriteError) {
      console.error('[modules/client-card/profile] Битрикс:', e.message);
      return NextResponse.json({ error: `Битрикс не принял изменения — ничего не сохранено. ${e.message}` }, { status: 502 });
    }
    if (e instanceof V2NotReadyError) {
      return NextResponse.json({ error: 'Это действие станет доступно после миграции sa_org/006 (статусы и привязка сделок к объектам)' }, { status: 503 });
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
