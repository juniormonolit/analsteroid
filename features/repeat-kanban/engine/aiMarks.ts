// Значок разбора звонков на карточке канбана (владелец 23.10: «на карточках, в которых есть ИИ-разбор, — иконка;
// при наличии новой пищи для анализа (свежие звонки) — красный кружочек с числом непроанализированных звонков»).
// Только для РОПов (видят доску; менеджеры канбаном не пользуются). Анализ запускают вручную — бюджет.
//
// Ключи: ai_analyses.client_ref — ClientRef карточки клиента: c<контакт> (все его сделки, и юр без компании) |
// k<компания>; на доске — c/x/k + склейка (memberKeys). x<id> → c<id>, как memoStore.refsOfClientKey.
// «Новые звонки» — расшифрованные звонки по сделкам заказчика, сделанные ПОСЛЕ запуска последнего разбора
// (то, чего модель ещё не видела; звонки без расшифровки анализу всё равно не нужны).
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';
import { MEMO_FRESH_DAYS } from '@/features/ai-analysis/engine/memo';

export interface AiMark { id: number; at: string; fresh: boolean; newCalls: number }

const refOf = (k: string) => (k.startsWith('x') ? `c${k.slice(1)}` : k);
/** Счёт новых звонков — скан сделок ~1,2 с (индекса по контакту в копии нет), доска опрашивается раз в
 *  минуту: держим результат 3 мин на тот же набор «заказчик + момент разбора». */
const COUNT_TTL = 3 * 60_000;
let countCache: { sig: string; at: number; counts: Map<string, number> } | null = null;

/** primary → AiMark по последнему готовому разбору любого из исходных ключей заказчика. */
export async function fetchAiMarks(members: Map<string, string[]>): Promise<Map<string, AiMark>> {
  const out = new Map<string, AiMark>();
  if (!members.size) return out;
  const refs = [...new Set([...members.values()].flat().map(refOf))];
  let rows: { client_ref: string; id: string; created_at: Date }[] = [];
  try {
    rows = (await systemDb().query<{ client_ref: string; id: string; created_at: Date }>(
      `SELECT DISTINCT ON (client_ref) client_ref, id::text, created_at FROM ai_analyses
        WHERE status = 'done' AND NOT is_test AND client_ref = ANY($1::text[])
        ORDER BY client_ref, created_at DESC`, [refs])).rows;
  } catch (e) {
    console.warn('[repeat-kanban] разборы звонков:', e instanceof Error ? e.message : e);
    return out;
  }
  if (!rows.length) return out;
  const byRef = new Map(rows.map(r => [r.client_ref, r]));
  const freshMs = Date.now() - MEMO_FRESH_DAYS * 86_400_000;
  // Заказчик доски → последний разбор среди его ключей; новые звонки — по всем его ключам после этого разбора.
  const since: { primary: string; keys: string[]; at: Date; id: number }[] = [];
  for (const [primary, keys] of members) {
    const best = keys.map(k => byRef.get(refOf(k))).filter(Boolean).sort((a, b) => +b!.created_at - +a!.created_at)[0];
    if (best) since.push({ primary, keys, at: new Date(best.created_at), id: Number(best.id) });
  }
  const flatKeys = since.flatMap(s => s.keys), flatSince = since.flatMap(s => s.keys.map(() => s.at.toISOString())), flatPrimary = since.flatMap(s => s.keys.map(() => s.primary));
  const sig = since.map(x => `${x.primary}@${x.id}`).sort().join(',');
  let counts = countCache && countCache.sig === sig && Date.now() - countCache.at < COUNT_TTL ? countCache.counts : null;
  if (!counts && flatKeys.length) {
    counts = new Map<string, number>();
    // Звонок считается один раз на заказчика, даже если его сделка — у двух исходных карточек склейки.
    const r = await analyticsDb().query<{ primary_key: string; n: string }>(
      `WITH a AS (SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[]) AS a(key, since, primary_key))
       SELECT a.primary_key, count(DISTINCT c.id)::text AS n
         FROM sa.deals d
         JOIN a ON a.key = (${CLIENT_KEY_SQL})
         JOIN va.calls c ON c.deal_id = d.deal_id AND c.called_at > a.since
         JOIN va.transcriptions t ON t.call_id = c.id
        WHERE d.funnel_id IN (0, 1, 2, 3) AND coalesce(nullif(trim(coalesce(t.formatted_dialogue::text, t.raw_text)), ''), 'null') <> 'null'
        GROUP BY a.primary_key`, [flatKeys, flatSince, flatPrimary],
    ).catch(e => { console.warn('[repeat-kanban] новые звонки после разбора:', e instanceof Error ? e.message : e); return { rows: [] as { primary_key: string; n: string }[] }; });
    for (const x of r.rows) counts.set(x.primary_key, Number(x.n));
    countCache = { sig, at: Date.now(), counts };
  }
  for (const s of since) {
    out.set(s.primary, { id: s.id, at: s.at.toISOString(), fresh: s.at.getTime() >= freshMs, newCalls: counts?.get(s.primary) ?? 0 });
  }
  return out;
}
