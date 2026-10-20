// Разбор отказов РОПом (канбан повторных продаж). Сделку закрыли в отказ → заказчик в
// колонке «Отказ на проверке» → РОП решает:
//   brak      — брак (причина обязательна). Дублируется отметкой no_call в customer_marks:
//               заказчик уходит и из «Моих заказчиков» (вкладка «Отказались»);
//   no_answer — недозвон: не брак, заказчик возвращается в пул;
//   return    — вернуть менеджеру: карточка остаётся на разборе с пометкой, пока менеджер
//               не переоткроет сделку (стадия сменится — карточка уедет сама).
// Правило трёх касаний: брак при отказе до 3/3 — только с явным комментарием РОПа.
import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';
import { BRAK_REASONS, TOUCHES, type BrakReason, type ReviewDecision } from './config';
import { NO_CALL_REASON_LABELS } from '@/features/customers/engine/customers';

export class ReviewError extends Error {}

export async function decideReview(input: {
  clientKey: string; dealId: number; decision: ReviewDecision; reason: string | null; comment: string | null;
  touchesDone: number; session: SessionUser;
}): Promise<void> {
  const comment = input.comment?.trim().slice(0, 1000) || null;
  let reason: BrakReason | null = null;
  if (input.decision === 'brak') {
    if (!BRAK_REASONS.some(r => r.value === input.reason)) throw new ReviewError('Укажите причину брака');
    reason = input.reason as BrakReason;
    if (input.touchesDone < TOUCHES && !comment) {
      throw new ReviewError(`Попыток ${input.touchesDone} из ${TOUCHES} и без дозвона: чтобы принять такой отказ, напишите почему`);
    }
  }
  const db = systemDb();
  await db.query(
    `INSERT INTO repeat_kanban_reviews (client_key, deal_id, decision, reason, comment, touches_done, decided_by, decided_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (deal_id) DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, comment = EXCLUDED.comment,
       touches_done = EXCLUDED.touches_done, decided_by = EXCLUDED.decided_by, decided_by_user_id = EXCLUDED.decided_by_user_id,
       decided_at = now()`,
    [input.clientKey, input.dealId, input.decision, reason, comment, input.touchesDone, input.session.displayName, input.session.id],
  );
  if (input.decision !== 'brak' || !reason) return;
  const note = `Брак (канбан повторных, сделка ${input.dealId}): ${NO_CALL_REASON_LABELS[reason]}${comment ? ` — ${comment}` : ''}`.slice(0, 500);
  await db.query(
    `INSERT INTO customer_marks (client_key, kind, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'no_call', NULL, $2, $3, $4, $5)
     ON CONFLICT (client_key) DO UPDATE SET kind = 'no_call', snooze_until = NULL, reason = EXCLUDED.reason,
       comment = EXCLUDED.comment, created_by = EXCLUDED.created_by, created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()`,
    [input.clientKey, reason, note, input.session.displayName, input.session.id],
  );
  await db.query(
    `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'no_call', NULL, $2, $3, $4, $5)`,
    [input.clientKey, reason, note, input.session.displayName, input.session.id],
  ).catch(() => {});
}

/** Снять брак (ошиблись) — заказчик возвращается в пул. История остаётся. */
export async function restoreFromBrak(clientKey: string, session: SessionUser): Promise<void> {
  const db = systemDb();
  await db.query(`DELETE FROM customer_marks WHERE client_key = $1 AND kind = 'no_call'`, [clientKey]);
  await db.query(
    `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'clear', NULL, NULL, 'Брак снят в канбане повторных', $2, $3)`,
    [clientKey, session.displayName, session.id],
  ).catch(() => {});
}
