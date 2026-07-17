// «Доля прозвона броней / подтв. броней на следующий рабочий день» (задача Иосифа
// 17.07). Регламент: менеджер, переведший сделку в бронь (reserved) или подтв. бронь
// (confirmed), обязан прозвонить клиента В СЛЕДУЮЩИЙ рабочий день (вариант Б —
// СТРОГО в него, не в день перевода; выбор владельца).
//
// Знаменатель: сделки с reserved_at (confirmed_at) в периоде отчёта, атрибуция по
//   current_manager_id (как все by-managers метрики). Незавершённое окно исключаем:
//   если конец следующего рабочего дня ещё не наступил (now), сделка в знаменатель
//   не идёт — иначе штрафуем за не наступивший срок.
// Числитель: из них те, где ∃ ИСХОДЯЩИЙ звонок по сделке (va.calls.deal_id,
//   direction='outbound') с called_at ВНУТРИ следующего рабочего дня [00:00, 23:59:59] МСК.
//   Звонок любого сотрудника (клиенту перезвонили — регламент соблюдён).
//
// Кросс-БД: брони+звонки из sa (analyticsDb), рабочий календарь из system (systemDb) —
// джойна нет, следующий рабочий день считаем в приложении. Данные звонков — с
// CALLS_DATA_START; если ВЕСЬ период раньше → null (честный, как в callsMetrics).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CALLS_DATA_START } from '@/features/reports/engine/callsMetrics';
import { periodDateStrFromInstant, type DateRange } from '@/lib/period';

export interface BookingCallRateRow {
  reservedDenom: number;
  reservedNum: number;
  confirmedDenom: number;
  confirmedNum: number;
}

const MSK = 'Europe/Moscow';
const mskDay = (d: Date): string => d.toLocaleDateString('sv-SE', { timeZone: MSK }); // YYYY-MM-DD

/** Карта «следующий рабочий день» по календарю system (нет записи → считаем будни:
 *  пн–пт рабочие). Возвращает функцию dateStr → следующий рабочий dateStr. */
async function loadNextWorkingDayFn(): Promise<(dateStr: string) => string> {
  const res = await systemDb().query<{ d: string; is_working: boolean }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, is_working FROM working_calendar`,
  );
  const cal = new Map(res.rows.map(r => [r.d, r.is_working]));
  const isWorking = (s: string): boolean => {
    const v = cal.get(s);
    if (v !== undefined) return v;
    const dow = new Date(`${s}T12:00:00Z`).getUTCDay(); // нет в календаре → будни
    return dow !== 0 && dow !== 6;
  };
  return (dateStr: string): string => {
    const d = new Date(`${dateStr}T12:00:00Z`);
    for (let i = 0; i < 21; i++) {
      d.setUTCDate(d.getUTCDate() + 1);
      const s = d.toISOString().slice(0, 10);
      if (isWorking(s)) return s;
    }
    return dateStr; // защита от зацикливания (не должно случаться)
  };
}

export async function fetchBookingCallRate(period: DateRange): Promise<Map<string, BookingCallRateRow> | null> {
  const fromStr = periodDateStrFromInstant(period.from, 'from');
  const toStr = periodDateStrFromInstant(period.to, 'to');
  // Весь период раньше старта сбора звонков — числитель был бы всегда 0, это ложь.
  if (toStr < CALLS_DATA_START) return null;

  const sa = analyticsDb();
  const nextWorkingDay = await loadNextWorkingDayFn();
  const now = new Date();
  const out = new Map<string, BookingCallRateRow>();
  const ensure = (mgr: string) => {
    let r = out.get(mgr);
    if (!r) { r = { reservedDenom: 0, reservedNum: 0, confirmedDenom: 0, confirmedNum: 0 }; out.set(mgr, r); }
    return r;
  };

  for (const milestone of ['reserved_at', 'confirmed_at'] as const) {
    // Брони периода. Полуинтервал [from, to+1day) МСК — как везде в отчётах.
    const deals = await sa.query<{ deal_id: string; mgr: number; at: Date }>(
      `SELECT deal_id, current_manager_id AS mgr, ${milestone} AS at
       FROM sa.deals
       WHERE current_manager_id IS NOT NULL
         AND ${milestone} >= ($1 || 'T00:00:00+03:00')::timestamptz
         AND ${milestone} <  (($2 || 'T00:00:00+03:00')::timestamptz + interval '1 day')`,
      [fromStr, toStr],
    );
    if (deals.rows.length === 0) continue;

    const dealIds = deals.rows.map(r => Number(r.deal_id));
    // Исходящие звонки по этим сделкам (один запрос). deal_id в va.calls — bigint →
    // node-pg отдаёт строкой; ключуем Map строкой (иначе не сматчится с sa.deals).
    const calls = await sa.query<{ deal_id: string; called_at: Date }>(
      `SELECT deal_id, called_at FROM va.calls
       WHERE deal_id = ANY($1) AND direction::text = 'outbound'`,
      [dealIds],
    );
    const callsByDeal = new Map<string, Date[]>();
    for (const c of calls.rows) {
      const k = String(c.deal_id);
      const arr = callsByDeal.get(k);
      if (arr) arr.push(new Date(c.called_at)); else callsByDeal.set(k, [new Date(c.called_at)]);
    }

    for (const d of deals.rows) {
      const nwd = nextWorkingDay(mskDay(new Date(d.at)));
      const winStart = new Date(`${nwd}T00:00:00+03:00`);
      const winEnd = new Date(`${nwd}T23:59:59.999+03:00`);
      // Окно ещё не завершилось — срок не наступил, из знаменателя исключаем.
      if (winEnd > now) continue;
      const r = ensure(String(d.mgr));
      const dealCalls = callsByDeal.get(String(d.deal_id)) ?? [];
      const called = dealCalls.some(t => t >= winStart && t <= winEnd);
      if (milestone === 'reserved_at') { r.reservedDenom++; if (called) r.reservedNum++; }
      else { r.confirmedDenom++; if (called) r.confirmedNum++; }
    }
  }

  return out;
}
