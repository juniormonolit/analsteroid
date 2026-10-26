// «Запросить разбор» (владелец 26.10): менеджер в карточке клиента просит ИИ-разбор, если разбора не было никогда
// или есть свежие разговоры — состоявшиеся звонки, не попавшие в предыдущий разбор (после его запуска). Без разбора —
// любой состоявшийся разговор за HISTORY_MONTHS (окно, из которого разбор берёт звонки). Запрос активен, пока нет
// готового разбора новее него (миграция 257, статус не храним). РОПу в канбане — индикатор, фильтр, «Сегодня».
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { clientKeys, HISTORY_MONTHS } from './collect';
import type { ClientRef } from '@/features/client-module/engine/types';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';

export interface AiRequest { by: string; at: string; comment: string | null }
export interface AiRequestState { lastAnalysisAt: string | null; freshCalls: number; pending: AiRequest | null; canRequest: boolean }

export class AiRequestError extends Error {}

async function lastDoneAt(ref: string): Promise<Date | null> {
  const r = await systemDb().query<{ at: Date }>(
    `SELECT max(created_at) AS at FROM ai_analyses WHERE client_ref = $1 AND status = 'done' AND NOT is_test AND kind = 'client'`, [ref]);
  return r.rows[0]?.at ?? null;
}

async function pendingFor(ref: string, after: Date | null): Promise<AiRequest | null> {
  const r = await systemDb().query<{ by: string; at: Date; comment: string | null }>(
    `SELECT coalesce(requested_by_name, requested_by) AS by, requested_at AS at, comment FROM ai_analysis_requests
      WHERE client_ref = $1 AND ($2::timestamptz IS NULL OR requested_at > $2) ORDER BY requested_at DESC LIMIT 1`, [ref, after]);
  const x = r.rows[0];
  return x ? { by: x.by, at: new Date(x.at).toISOString(), comment: x.comment } : null;
}

export async function aiRequestState(ref: ClientRef): Promise<AiRequestState> {
  const last = await lastDoneAt(ref);
  const keys = await clientKeys(ref);
  const [calls, pending] = await Promise.all([
    analyticsDb().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM va.calls c
        WHERE c.failed_at_stage IS NULL AND c.result = 'completed'
          AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_SQL}) = ANY($1::text[]))
          AND c.called_at > coalesce($2::timestamptz, now() - make_interval(months => $3))`,
      [keys, last, HISTORY_MONTHS]),
    pendingFor(ref, last),
  ]);
  const freshCalls = Number(calls.rows[0]?.n ?? 0);
  return { lastAnalysisAt: last ? last.toISOString() : null, freshCalls, pending, canRequest: !pending && freshCalls > 0 };
}

export async function requestAnalysis(ref: ClientRef, actor: { id: string; name: string }, comment: string | null): Promise<AiRequestState> {
  const s = await aiRequestState(ref);
  if (s.pending) throw new AiRequestError(`Разбор уже запрошен: ${s.pending.by}`);
  if (!s.freshCalls) throw new AiRequestError(s.lastAnalysisAt ? 'После прошлого разбора новых разговоров нет' : 'Состоявшихся разговоров за год нет — разбирать нечего');
  await systemDb().query(
    `INSERT INTO ai_analysis_requests (client_ref, comment, requested_by, requested_by_name) VALUES ($1, $2, $3, $4)`,
    [ref, comment?.trim().slice(0, 500) || null, actor.id, actor.name]);
  return aiRequestState(ref);
}

/** Для доски: client_ref → активный запрос (нет готового разбора новее). Ключ x<id> доски = c<id>. */
export async function fetchPendingRequests(refs: string[]): Promise<Map<string, AiRequest>> {
  if (!refs.length) return new Map();
  const r = await systemDb().query<{ client_ref: string; by: string; at: Date; comment: string | null }>(
    `SELECT DISTINCT ON (q.client_ref) q.client_ref, coalesce(q.requested_by_name, q.requested_by) AS by, q.requested_at AS at, q.comment
       FROM ai_analysis_requests q
      WHERE q.client_ref = ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM ai_analyses a WHERE a.client_ref = q.client_ref AND a.status = 'done' AND NOT a.is_test
                          AND a.kind = 'client' AND a.created_at > q.requested_at)
      ORDER BY q.client_ref, q.requested_at DESC`, [refs],
  ).catch(e => { console.warn('[ai requests]', e instanceof Error ? e.message : e); return { rows: [] as never[] }; });
  return new Map(r.rows.map(x => [x.client_ref, { by: x.by, at: new Date(x.at).toISOString(), comment: x.comment }]));
}
