// Цикл обратной связи по журналу управленческих подсказок РОПу (задача 2769,
// продолжение 2765) — та же механика, что lib/jobs/adviceFeedback.ts, только
// три РАЗНЫХ критерия «успеха» (по типу подсказки), т.к. предмет советования
// разный (клиент / отдельная группа / отдел целиком):
//
//  stale_customer     — 1-в-1 переиспользует hasSaleSince/firstCallSince из
//                        adviceFeedback.ts (сам факт «была продажа/звонок по
//                        client_key после отметки» не зависит от того, кому
//                        адресован совет — менеджеру или РОПу), тот же ритм
//                        (3 дня между напоминаниями, 21 день наблюдения после
//                        контакта, cooldown 30 дней).
//  unphoned_bookings  — пересчёт fetchDeptBookingCallbackStat (скользящее
//                        окно 7 дней «как сейчас») — успех, если
//                        непрозвоненных не осталось.
//  conversion_drop    — пересчёт recheckDeptGroupConversion — успех, если CR
//                        группы отросла обратно хотя бы до уровня ДО
//                        просадки (prevCrPct из decision_trace на момент
//                        совета). Недостаточно сделок в окне для честного
//                        суждения (null) — трактуем как «recovery ещё не
//                        подтверждён» и НЕ тратим на это напоминание (ждём
//                        следующего тика, а не штрафуем за нехватку данных).
//
// Тон — то же правило «помощь, а не надзор»: закрытие без результата — ВСЕГДА
// молча (closed_no_contact/closed_no_deal), пуш РОПу только на успехе или
// нейтральном напоминании. Ни один текст не называет менеджера и не пересказывает
// его переписку с ботом (см. шапку lib/jobs/ropDigest.ts).

import { systemDb } from '@/lib/db/clients';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { fetchDigestSettings } from './managerDigest';
import { hasSaleSince, firstCallSince } from './adviceFeedback';
import { fetchDeptRoster, fetchRopBotPrefs, fetchDeptBookingCallbackStat, recheckDeptGroupConversion } from './ropDigest';

const REMINDER_INTERVAL_DAYS = 3;
const WATCH_DAYS_AFTER_CONTACT = 21; // только stale_customer
const COOLDOWN_DAYS = 30;

interface OpenRopAdvice {
  id: string;
  rop_bitrix_id: number;
  hint_type: 'conversion_drop' | 'unphoned_bookings' | 'stale_customer';
  target_key: string;
  target_label: string;
  status: 'active' | 'contacted';
  reminder_count: number;
  advised_at: string;
  last_nudge_at: string | null;
  contacted_at: string | null;
  decision_trace: Record<string, unknown> | null;
}

async function sendMsg(ropBitrixId: number, message: string, msgType: string, reason: string, decisionTrace: Record<string, unknown>): Promise<void> {
  const prefs = await fetchRopBotPrefs(ropBitrixId);
  const suppressReason = !prefs.enabled ? 'rop_opted_out_all' : !prefs.showHints ? 'rop_opted_out_hints' : null;
  await sendManagerBotMessage(ropBitrixId, message, msgType, reason, { suppressReason, decisionTrace });
}

export interface RopFeedbackTickStats {
  checked: number; success: number; contacted: number; reminded: number;
  closedNoContact: number; closedNoDeal: number; errors: number;
}

export async function runRopAdviceFeedbackTick(): Promise<RopFeedbackTickStats> {
  const stats: RopFeedbackTickStats = { checked: 0, success: 0, contacted: 0, reminded: 0, closedNoContact: 0, closedNoDeal: 0, errors: 0 };
  const settings = await fetchDigestSettings();
  const db = systemDb();

  const open = await db.query<OpenRopAdvice>(
    `SELECT id::text, rop_bitrix_id, hint_type, target_key, target_label, status, reminder_count,
            advised_at, last_nudge_at, contacted_at, decision_trace
       FROM rop_advice_log WHERE status IN ('active', 'contacted') AND test_run = false`,
  ).catch(() => ({ rows: [] as OpenRopAdvice[] }));

  const now = Date.now();
  const rosterCache = new Map<number, number[]>();
  async function rosterFor(ropId: number): Promise<number[]> {
    if (!rosterCache.has(ropId)) {
      const roster = await fetchDeptRoster(ropId);
      rosterCache.set(ropId, roster.map(m => m.bitrixId));
    }
    return rosterCache.get(ropId)!;
  }

  for (const row of open.rows) {
    stats.checked++;
    try {
      if (row.hint_type === 'stale_customer') {
        await tickStaleCustomer(row, stats);
      } else if (row.hint_type === 'unphoned_bookings') {
        await tickUnphonedBookings(row, stats, await rosterFor(row.rop_bitrix_id), settings.maxReminders, now);
      } else {
        await tickConversionDrop(row, stats, await rosterFor(row.rop_bitrix_id), settings.maxReminders, now);
      }
    } catch (e) {
      stats.errors++;
      console.error(`[ropAdviceFeedback] rop_advice_log #${row.id} упал:`, e instanceof Error ? e.message : e);
    }
  }
  return stats;
}

// ── stale_customer: тот же факт продажи/звонка, что и у менеджерской версии ──

async function tickStaleCustomer(row: OpenRopAdvice, stats: RopFeedbackTickStats): Promise<void> {
  const db = systemDb();
  if (await hasSaleSince(row.target_key, row.advised_at)) {
    await db.query(`UPDATE rop_advice_log SET status = 'success', resolved_at = now(), resolved_reason = 'deal_won' WHERE id = $1`, [row.id]);
    await sendMsg(row.rop_bitrix_id, `🎉 ${row.target_label}: заказчик снова купил! Отдел довёл до сделки без напоминаний сверху — красиво 😎`,
      'rop_advice_success', `Подтверждение: ${row.target_label}`, { rule: 'rop_sale_after_advice', ropAdviceLogId: Number(row.id), targetKey: row.target_key, advisedAt: row.advised_at });
    stats.success++;
    return;
  }

  if (row.status === 'active') {
    const firstCall = await firstCallSince(row.target_key, row.advised_at);
    if (firstCall) {
      await db.query(`UPDATE rop_advice_log SET status = 'contacted', contacted_at = $2 WHERE id = $1`, [row.id, firstCall.toISOString()]);
      stats.contacted++;
      return;
    }
    const sinceLastNudge = Date.now() - new Date(row.last_nudge_at ?? row.advised_at).getTime();
    if (sinceLastNudge < REMINDER_INTERVAL_DAYS * 86_400_000) return;

    if (row.reminder_count < (await fetchDigestSettings()).maxReminders) {
      await db.query(`UPDATE rop_advice_log SET reminder_count = reminder_count + 1, last_nudge_at = now() WHERE id = $1`, [row.id]);
      await sendMsg(row.rop_bitrix_id, `${row.target_label}: заказчик всё ещё без контакта — момент неплохой, чтобы кто-то из отдела позвонил.`,
        'rop_advice_nudge', `Напоминание: ${row.target_label}`, { rule: 'rop_reminder_no_contact_yet', ropAdviceLogId: Number(row.id), targetKey: row.target_key, reminderNumber: row.reminder_count + 1 });
      stats.reminded++;
    } else {
      await db.query(
        `UPDATE rop_advice_log SET status = 'closed_no_contact', resolved_at = now(), resolved_reason = 'no_contact_timeout',
                next_eligible_at = now() + ($2 || ' days')::interval WHERE id = $1`,
        [row.id, COOLDOWN_DAYS],
      );
      stats.closedNoContact++;
    }
  } else { // contacted — тихо ждём сделку
    const sinceContact = Date.now() - new Date(row.contacted_at ?? row.advised_at).getTime();
    if (sinceContact >= WATCH_DAYS_AFTER_CONTACT * 86_400_000) {
      await db.query(
        `UPDATE rop_advice_log SET status = 'closed_no_deal', resolved_at = now(), resolved_reason = 'no_deal_after_contact',
                next_eligible_at = now() + ($2 || ' days')::interval WHERE id = $1`,
        [row.id, COOLDOWN_DAYS],
      );
      stats.closedNoDeal++;
    }
  }
}

// ── unphoned_bookings / conversion_drop: активная-но-не-«contacted» подсказка,
// действуем раз в REMINDER_INTERVAL_DAYS: успех / напоминание / тихое закрытие.

async function dueForAction(row: OpenRopAdvice): Promise<boolean> {
  const sinceLastNudge = Date.now() - new Date(row.last_nudge_at ?? row.advised_at).getTime();
  return sinceLastNudge >= REMINDER_INTERVAL_DAYS * 86_400_000;
}

async function closeOrRemind(row: OpenRopAdvice, stats: RopFeedbackTickStats, maxReminders: number, nudgeText: string, msgType: string): Promise<void> {
  const db = systemDb();
  if (!(await dueForAction(row))) return;
  if (row.reminder_count < maxReminders) {
    await db.query(`UPDATE rop_advice_log SET reminder_count = reminder_count + 1, last_nudge_at = now() WHERE id = $1`, [row.id]);
    await sendMsg(row.rop_bitrix_id, nudgeText, msgType, `Напоминание: ${row.target_label}`,
      { rule: `rop_reminder_${row.hint_type}`, ropAdviceLogId: Number(row.id), targetKey: row.target_key, reminderNumber: row.reminder_count + 1 });
    stats.reminded++;
  } else {
    await db.query(
      `UPDATE rop_advice_log SET status = 'closed_no_deal', resolved_at = now(), resolved_reason = 'no_improvement_timeout',
              next_eligible_at = now() + ($2 || ' days')::interval WHERE id = $1`,
      [row.id, COOLDOWN_DAYS],
    );
    stats.closedNoDeal++;
  }
}

async function tickUnphonedBookings(row: OpenRopAdvice, stats: RopFeedbackTickStats, managerIds: number[], maxReminders: number, _now: number): Promise<void> {
  const stat = await fetchDeptBookingCallbackStat(managerIds, new Date(Date.now() - 7 * 86_400_000), new Date());
  const unphoned = stat ? stat.total - stat.called : 0;
  if (!stat || unphoned <= 0) {
    await systemDb().query(`UPDATE rop_advice_log SET status = 'success', resolved_at = now(), resolved_reason = 'bookings_cleared' WHERE id = $1`, [row.id]);
    await sendMsg(row.rop_bitrix_id, '🎉 Отдел прозвонил все брони за последнюю неделю — красавцы, никто не потерян!',
      'rop_advice_success', `Подтверждение: ${row.target_label}`, { rule: 'rop_bookings_cleared', ropAdviceLogId: Number(row.id) });
    stats.success++;
    return;
  }
  await closeOrRemind(row, stats, maxReminders,
    `Отдел так и не дозвонился до части броней (осталось ${unphoned}${stat.riskSum > 0 ? `, риск ещё в силе` : ''}) — стоит вернуться к списку.`,
    'rop_advice_nudge');
}

async function tickConversionDrop(row: OpenRopAdvice, stats: RopFeedbackTickStats, managerIds: number[], maxReminders: number, _now: number): Promise<void> {
  const trace = row.decision_trace ?? {};
  const prevCrPct = typeof trace.prevCrPct === 'number' ? trace.prevCrPct : null;
  const recheck = await recheckDeptGroupConversion(managerIds.map(String), row.target_key);

  if (recheck === null) return; // недостаточно сделок за окно, чтобы честно судить — не тратим напоминание, ждём данных

  if (prevCrPct !== null && recheck.curCrPct >= prevCrPct) {
    await systemDb().query(`UPDATE rop_advice_log SET status = 'success', resolved_at = now(), resolved_reason = 'conversion_recovered' WHERE id = $1`, [row.id]);
    await sendMsg(row.rop_bitrix_id, `🎉 Конверсия по «${row.target_label}» восстановилась (сейчас ${recheck.curCrPct}%) — отдел справился!`,
      'rop_advice_success', `Подтверждение: ${row.target_label}`, { rule: 'rop_conversion_recovered', ropAdviceLogId: Number(row.id), curCrPct: recheck.curCrPct, prevCrPct });
    stats.success++;
    return;
  }
  await closeOrRemind(row, stats, maxReminders,
    `Просадка конверсии по «${row.target_label}» пока не выправилась (сейчас ${recheck.curCrPct}%) — стоит ещё раз посмотреть на группу.`,
    'rop_advice_nudge');
}
