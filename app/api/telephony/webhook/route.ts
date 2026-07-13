import { NextRequest, NextResponse } from 'next/server';
import { systemDb } from '@/lib/db/clients';
import { normalizePhone } from '@/lib/bots/callControl';

// Приём ИСХОДЯЩЕГО вебхука Bitrix по событиям телефонии (бот «Контроль звонков»).
// Bitrix шлёт application/x-www-form-urlencoded с вложенными ключами
// (event, data[CALL_ID], data[CALL_TYPE], data[PHONE_NUMBER], ...). Мы принимаем и
// form-encoded, и JSON, складываем сырое событие + нормализованные поля в
// call_events (YC system). Дальше события разбирает движок lib/bots/callControl.ts.
//
// Аутентификация: секрет в query (?token=...) — Bitrix не умеет кастомные заголовки
// в исходящих вебхуках. Роут публичный (auth-гейта сессии нет — API в proxy.ts
// пропускается), поэтому без валидного токена — 403 без деталей.
//
// Идемпотентность: UNIQUE (bitrix_call_id, event_name) → ON CONFLICT DO NOTHING
// (Bitrix ретраит недоставленные вебхуки).

export const dynamic = 'force-dynamic';

// CALL_TYPE Bitrix: 1 исходящий, 2 входящий, 3 входящий с переадресацией, 4 callback.
function directionFromCallType(callType: string | null): 'inbound' | 'outbound' | null {
  if (callType === '1') return 'outbound';
  if (callType === '2' || callType === '3') return 'inbound';
  if (callType === '4') return 'outbound'; // callback инициируем мы
  return null;
}

function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}[${k}]` : k, out);
    }
  } else if (prefix) {
    out[prefix] = obj == null ? '' : String(obj);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const secret = process.env.TELEPHONY_WEBHOOK_SECRET || '';
  if (!secret || req.nextUrl.searchParams.get('token') !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Тело: form-urlencoded (штатный формат Bitrix) или JSON — принимаем оба.
  let fields: Record<string, string> = {};
  const contentType = req.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      fields = flatten(await req.json());
    } else {
      const form = await req.formData();
      for (const [k, v] of form.entries()) fields[k] = String(v);
    }
  } catch {
    return NextResponse.json({ error: 'bad body' }, { status: 400 });
  }

  const get = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = fields[`data[${k}]`] ?? fields[k];
      if (v !== undefined && v !== '') return v;
    }
    return null;
  };

  const eventName = (fields['event'] ?? 'UNKNOWN').toUpperCase();
  const callId = get('CALL_ID');
  const callType = get('CALL_TYPE');
  const phoneRaw = get('PHONE_NUMBER', 'CALLER_ID', 'PHONE_NUMBER_INTERNATIONAL');
  const durationRaw = get('CALL_DURATION', 'DURATION');
  const failedCode = get('CALL_FAILED_CODE', 'FAILED_CODE');
  const managerId = get('PORTAL_USER_ID', 'USER_ID');
  const startRaw = get('CALL_START_DATE', 'CALL_START_TIME');
  const crmEntityType = get('CRM_ENTITY_TYPE');
  const crmEntityId = get('CRM_ENTITY_ID');

  const direction = directionFromCallType(callType);
  const duration = durationRaw != null && /^\d+$/.test(durationRaw) ? parseInt(durationRaw, 10) : null;
  // Пропущенный входящий: код 304 (классика Bitrix) либо входящий с нулевой длительностью.
  // ТОЛЬКО на событии ЗАВЕРШЕНИЯ звонка: владелец подписал вебхук и на CALLINIT/CALLSTART —
  // у тех нет длительности, и без этого гейта каждый ОТВЕЧЕННЫЙ входящий считался бы
  // пропущенным по (duration ?? 0) === 0.
  const isCallEnd = eventName.includes('CALLEND');
  const isMissedInbound =
    isCallEnd && direction === 'inbound' && (failedCode === '304' || (failedCode == null && (duration ?? 0) === 0));
  const dealId = crmEntityType === 'DEAL' && crmEntityId && /^\d+$/.test(crmEntityId) ? crmEntityId : null;
  const startedAt = startRaw ? new Date(startRaw) : null;

  const db = systemDb();
  await db.query(
    `INSERT INTO call_events
       (event_name, bitrix_call_id, direction, call_type_raw, phone_normalized, phone_raw,
        manager_bitrix_user_id, duration_seconds, failed_code, is_missed_inbound,
        crm_deal_id, call_started_at, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (bitrix_call_id, event_name) WHERE bitrix_call_id IS NOT NULL DO NOTHING`,
    [
      eventName,
      callId,
      direction,
      callType,
      normalizePhone(phoneRaw),
      phoneRaw,
      managerId,
      duration,
      failedCode,
      isMissedInbound,
      dealId,
      startedAt && !isNaN(startedAt.getTime()) ? startedAt : null,
      JSON.stringify(fields),
    ]
  );

  return NextResponse.json({ ok: true });
}
