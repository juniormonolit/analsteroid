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

/** «Сразу в брак» (владелец 20.10): РОП видит, что заказчик безнадёжен (10 тыс. штукатурки,
 *  подвели) — брак без разбора отказа. Та же отметка no_call, что у брака по разбору. */
export async function markBrakNow(input: { clientKey: string; reason: string; comment: string | null; session: SessionUser }): Promise<void> {
  if (!BRAK_REASONS.some(r => r.value === input.reason)) throw new ReviewError('Укажите причину брака');
  const reason = input.reason as BrakReason;
  const comment = input.comment?.trim().slice(0, 1000) || null;
  const note = `Сразу в брак (канбан повторных): ${NO_CALL_REASON_LABELS[reason]}${comment ? ` — ${comment}` : ''}`.slice(0, 500);
  const db = systemDb();
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

/** «Скрыть из пула» до даты с обязательным комментарием («вернётся к стройке весной») —
 *  колонка «Скрытые»; после даты заказчик сам возвращается в пул. Отметка snooze. */
export async function hideFromPool(input: { clientKey: string; until: string; comment: string; session: SessionUser }): Promise<void> {
  const comment = input.comment.trim().slice(0, 1000);
  if (comment.length < 3) throw new ReviewError('Напишите, почему скрываете');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw new ReviewError('Укажите дату');
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  if (input.until <= today) throw new ReviewError('Дата должна быть в будущем');
  const db = systemDb();
  await db.query(
    `INSERT INTO customer_marks (client_key, kind, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'snooze', $2::date, NULL, $3, $4, $5)
     ON CONFLICT (client_key) DO UPDATE SET kind = 'snooze', snooze_until = EXCLUDED.snooze_until, reason = NULL,
       comment = EXCLUDED.comment, created_by = EXCLUDED.created_by, created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()`,
    [input.clientKey, input.until, comment, input.session.displayName, input.session.id],
  );
  await db.query(
    `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'snooze', $2::date, NULL, $3, $4, $5)`,
    [input.clientKey, input.until, comment, input.session.displayName, input.session.id],
  ).catch(() => {});
}

/** Вернуть скрытого в пул раньше срока. */
export async function unhide(clientKey: string, session: SessionUser): Promise<void> {
  const db = systemDb();
  await db.query(`DELETE FROM customer_marks WHERE client_key = $1 AND kind = 'snooze'`, [clientKey]);
  await db.query(
    `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
     VALUES ($1, 'clear', NULL, NULL, 'Возвращён в пул из «Скрытых» (канбан повторных)', $2, $3)`,
    [clientKey, session.displayName, session.id],
  ).catch(() => {});
}

// ── Предложение скрыть (миграция 234) ───────────────────────────────────────
// Скрывает только РОП; менеджер ПРЕДЛАГАЕТ (дата + комментарий), РОП принимает или отклоняет.
export interface HideRequest { id: number; until: string; comment: string; by: string; at: string }

export async function requestHide(input: { clientKey: string; managerId: string; until: string; comment: string; session: SessionUser }): Promise<void> {
  const comment = input.comment.trim().slice(0, 1000);
  if (comment.length < 3) throw new ReviewError('Напишите, почему скрыть');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.until)) throw new ReviewError('Укажите дату');
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  if (input.until <= today) throw new ReviewError('Дата должна быть в будущем');
  await systemDb().query(
    `INSERT INTO repeat_kanban_hide_requests (client_key, manager_id, until, comment, requested_by, requested_by_user_id)
     VALUES ($1, $2, $3::date, $4, $5, $6)
     ON CONFLICT (client_key) WHERE status = 'pending' DO UPDATE SET until = EXCLUDED.until, comment = EXCLUDED.comment,
       requested_by = EXCLUDED.requested_by, requested_by_user_id = EXCLUDED.requested_by_user_id, requested_at = now()`,
    [input.clientKey, input.managerId, input.until, comment, input.session.displayName, input.session.id],
  );
}

/** Решение РОПа: accept — скрыть с датой и комментарием менеджера, decline — отклонить. */
export async function decideHideRequest(input: { clientKey: string; accept: boolean; comment: string | null; session: SessionUser }): Promise<HideRequest | null> {
  const db = systemDb();
  const r = await db.query<{ id: string; until: string; comment: string; requested_by: string; requested_at: Date }>(
    `UPDATE repeat_kanban_hide_requests SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4
      WHERE client_key = $1 AND status = 'pending'
      RETURNING id::text, to_char(until, 'YYYY-MM-DD') AS until, comment, requested_by, requested_at`,
    [input.clientKey, input.accept ? 'accepted' : 'declined', input.session.displayName, input.comment?.trim().slice(0, 500) || null],
  );
  const row = r.rows[0];
  if (!row) throw new ReviewError('Предложение уже рассмотрено');
  if (input.accept) {
    await hideFromPool({ clientKey: input.clientKey, until: row.until, comment: `${row.comment} (предложил ${row.requested_by})`, session: input.session });
  }
  return { id: Number(row.id), until: row.until, comment: row.comment, by: row.requested_by, at: new Date(row.requested_at).toISOString() };
}

export async function fetchHideRequests(keys: string[]): Promise<Map<string, HideRequest>> {
  if (!keys.length) return new Map();
  const r = await systemDb().query<{ client_key: string; id: string; until: string; comment: string; requested_by: string; requested_at: Date }>(
    `SELECT client_key, id::text, to_char(until, 'YYYY-MM-DD') AS until, comment, requested_by, requested_at
       FROM repeat_kanban_hide_requests WHERE status = 'pending' AND client_key = ANY($1::text[])`, [keys],
  ).catch(() => ({ rows: [] as never[] }));
  return new Map(r.rows.map(x => [x.client_key, { id: Number(x.id), until: x.until, comment: x.comment, by: x.requested_by, at: new Date(x.requested_at).toISOString() }]));
}
