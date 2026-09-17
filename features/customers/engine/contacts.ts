import { systemDb } from '@/lib/db/clients';
import type { SessionUser } from '@/lib/auth/session';

// ── «Связался» и исключение через РОПа (задача владельца 17.09) ─────────────
// Хранение — системная БД (миграция 213). Отметки применяются ПОВЕРХ кэша движка
// списка, свежим запросом: «Связался» должно снимать заказчика из очереди сразу.

export type { ContactChannel, CustomerContact, ExclusionStatus, ExclusionRequest } from './contactTypes';
export { CONTACT_CHANNEL_LABELS } from './contactTypes';
import type { ContactChannel, CustomerContact, ExclusionStatus, ExclusionRequest } from './contactTypes';

function toIso(v: string | Date): string { return (v instanceof Date ? v : new Date(v)).toISOString(); }

/** Последняя ручная отметка «Связался» по каждому клиенту. */
export async function fetchLastContacts(clientKeys: string[]): Promise<Map<string, CustomerContact>> {
  if (!clientKeys.length) return new Map();
  try {
    const r = await systemDb().query<{ client_key: string; contacted_at: string | Date; channel: ContactChannel; note: string; created_by: string }>(
      `SELECT DISTINCT ON (client_key) client_key, contacted_at, channel, note, created_by
         FROM customer_contacts WHERE client_key = ANY($1::text[])
        ORDER BY client_key, contacted_at DESC`, [clientKeys],
    );
    return new Map(r.rows.map(x => [x.client_key, { contactedAt: toIso(x.contacted_at), channel: x.channel, note: x.note, createdBy: x.created_by }]));
  } catch { return new Map(); } // до миграции 213
}

/** Вся история ручных контактов клиента — для карточки. */
export async function fetchContactHistory(clientKey: string): Promise<CustomerContact[]> {
  try {
    const r = await systemDb().query<{ contacted_at: string | Date; channel: ContactChannel; note: string; created_by: string }>(
      `SELECT contacted_at, channel, note, created_by FROM customer_contacts WHERE client_key = $1 ORDER BY contacted_at DESC LIMIT 50`, [clientKey],
    );
    return r.rows.map(x => ({ contactedAt: toIso(x.contacted_at), channel: x.channel, note: x.note, createdBy: x.created_by }));
  } catch { return []; }
}

export async function addContact(input: { clientKey: string; managerBitrixId: string | null; channel: ContactChannel; note: string; contactedAt?: string | null; session: SessionUser }): Promise<void> {
  await systemDb().query(
    `INSERT INTO customer_contacts (client_key, manager_bitrix_id, channel, note, contacted_at, created_by, created_by_user_id)
     VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7)`,
    [input.clientKey, input.managerBitrixId, input.channel, input.note.trim().slice(0, 500), input.contactedAt ?? null, input.session.displayName, input.session.id],
  );
}

// ── Исключение из канбана через РОПа ────────────────────────────────────────

function toReq(x: Record<string, unknown>): ExclusionRequest {
  return {
    id: Number(x.id), clientKey: String(x.client_key), managerBitrixId: String(x.manager_bitrix_id),
    requestedBy: String(x.requested_by), reason: String(x.reason), status: x.status as ExclusionStatus,
    decidedBy: (x.decided_by as string | null) ?? null,
    decidedAt: x.decided_at ? toIso(x.decided_at as string | Date) : null,
    decisionComment: (x.decision_comment as string | null) ?? null,
    createdAt: toIso(x.created_at as string | Date),
  };
}

/** Ожидающие решения запросы по клиентам списка (чип «ждёт решения РОПа»). */
export async function fetchPendingExclusions(clientKeys: string[]): Promise<Map<string, ExclusionRequest>> {
  if (!clientKeys.length) return new Map();
  try {
    const r = await systemDb().query(`SELECT * FROM customer_exclusion_requests WHERE status = 'pending' AND client_key = ANY($1::text[])`, [clientKeys]);
    return new Map(r.rows.map(x => [String(x.client_key), toReq(x)]));
  } catch { return new Map(); }
}

/** Все ожидающие запросы по менеджеру — панель РОПа. */
export async function listPendingExclusions(managerBitrixId: string): Promise<ExclusionRequest[]> {
  try {
    const r = await systemDb().query(`SELECT * FROM customer_exclusion_requests WHERE status = 'pending' AND manager_bitrix_id = $1 ORDER BY created_at`, [managerBitrixId]);
    return r.rows.map(toReq);
  } catch { return []; }
}

export async function createExclusionRequest(input: { clientKey: string; managerBitrixId: string; reason: string; session: SessionUser }): Promise<ExclusionRequest> {
  const r = await systemDb().query(
    `INSERT INTO customer_exclusion_requests (client_key, manager_bitrix_id, requested_by, requested_by_user_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_key) WHERE status = 'pending' DO UPDATE SET reason = EXCLUDED.reason, created_at = now()
     RETURNING *`,
    [input.clientKey, input.managerBitrixId, input.session.displayName, input.session.id, input.reason.trim().slice(0, 500)],
  );
  return toReq(r.rows[0]);
}

/** Решение РОПа. Одобрение = отметка no_call (существующая вкладка «Отказались»)
 *  с историей — клиент исключается из очередей и сигналов насовсем. */
export async function decideExclusion(id: number, approve: boolean, comment: string | null, session: SessionUser): Promise<ExclusionRequest | null> {
  const db = systemDb();
  const r = await db.query(
    `UPDATE customer_exclusion_requests SET status = $2, decided_by = $3, decided_at = now(), decision_comment = $4
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, approve ? 'approved' : 'rejected', session.displayName, comment],
  );
  if (!r.rows[0]) return null;
  const req = toReq(r.rows[0]);
  if (approve) {
    const note = `Исключён через РОПа (${session.displayName}): ${req.reason}${comment ? ` — ${comment}` : ''}`.slice(0, 500);
    await db.query(
      `INSERT INTO customer_marks (client_key, kind, snooze_until, reason, comment, created_by, created_by_user_id)
       VALUES ($1, 'no_call', NULL, 'other', $2, $3, $4)
       ON CONFLICT (client_key) DO UPDATE SET kind = 'no_call', snooze_until = NULL, reason = 'other',
         comment = EXCLUDED.comment, created_by = EXCLUDED.created_by, created_by_user_id = EXCLUDED.created_by_user_id, created_at = now()`,
      [req.clientKey, note, session.displayName, session.id],
    );
    await db.query(
      `INSERT INTO customer_mark_history (client_key, action, snooze_until, reason, comment, created_by, created_by_user_id)
       VALUES ($1, 'no_call', NULL, 'other', $2, $3, $4)`,
      [req.clientKey, note, session.displayName, session.id],
    ).catch(() => {});
  }
  return req;
}
