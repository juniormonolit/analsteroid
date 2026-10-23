// Расшифровка звонков по кнопке перед ИИ-разбором (владелец 23.10: «если не все звонки транскрибированы — сначала
// принудительно отправить на транскрибацию, а потом уже на разбор, предупредив пользователя»). Контракт — ТЗ
// разработчиков транскрибации (n8n webhook transcribe-on-demand): POST ≤ 50 uuid va.calls.id → 202 accepted/skipped,
// готовность — опросом va.calls / va.transcriptions раз в 10 с, таймаут 10 мин, лимит 300 звонков в час на всех.
// Секрет — TRANSCRIBE_ONDEMAND_SECRET (start.sh читает файл на сервере); нет секрета — функция выключена.
// Секрет и ответ сервиса целиком в лог не пишем.
import { analyticsDb } from '@/lib/db/clients';
import type { ClientRef } from '@/features/client-module/engine/types';
import { clientKeys, HISTORY_MONTHS } from './collect';
import { CLIENT_KEY_SQL } from '@/features/customers/engine/clientKey';

const URL_DEFAULT = 'https://n8n-ghjlfriy.mlt-it.com/webhook/transcribe-on-demand';
/** Звонков за один запуск — одна пачка ТЗ; у остальных текст появится ночью сам (решение владельца 23.10). */
export const TRANSCRIBE_MAX_CALLS = 50;
/** Короче — текста нет (ТЗ, раздел 5). */
const MIN_SEC = 15;
export const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
export const TRANSCRIBE_POLL_MS = 10_000;

export const transcribeEnabled = () => !!process.env.TRANSCRIBE_ONDEMAND_SECRET;

/** Состояние ожидания в ai_analyses.transcribe. */
export interface TranscribeState {
  startedAt: string; until: string;
  /** Ждём текста по этим звонкам (отправленные + уже стоявшие в работе). */
  wait: string[];
  ready: number; failed: number;
  /** Не отправлены: not_found / too_short_or_missed / ошибка сервиса. */
  skipped: number;
  /** 429 — когда можно отправить снова; ids — что ещё не отправили. */
  retryAt?: string | null; pendingSend?: string[];
  pollErrors?: number;
  /** Ошибка сервиса (код), разбор идёт по тем звонкам, что уже с текстом. */
  serviceError?: string | null;
  done?: boolean;
}

/** Звонки заказчика без текста, которые стоит расшифровать (за HISTORY_MONTHS, свежие первыми, ≤ 50):
 *  send — отправить, inWork — уже расшифровываются (не слать, только ждать). */
export async function transcribeCandidates(ref: ClientRef): Promise<{ send: string[]; inWork: string[]; total: number; older: number }> {
  const keys = await clientKeys(ref);
  // Разговоры без текста старше окна разбора: их не шлём (у старых звонков записи, как правило, уже нет —
  // сервис отвечает no_recording, проверено 23.10), но вкладка объясняет, почему кнопки нет.
  const older = analyticsDb().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM va.calls c
      WHERE c.failed_at_stage IS NULL AND c.result = 'completed' AND coalesce(c.duration_seconds, 0) > $3
        AND c.called_at < now() - make_interval(months => $2)
        AND NOT EXISTS (SELECT 1 FROM va.transcriptions t WHERE t.call_id = c.id)
        AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_SQL}) = ANY($1::text[]))`,
    [keys, HISTORY_MONTHS, MIN_SEC],
  ).then(x => x.rows[0]?.n ?? 0).catch(() => 0);
  const r = await analyticsDb().query<{ id: string; in_work: boolean; total: number }>(
    `SELECT c.id::text, (c.status::text = 'transcribing' AND c.updated_at >= now() - interval '30 minutes') AS in_work, count(*) OVER ()::int AS total
       FROM va.calls c
      WHERE c.failed_at_stage IS NULL AND c.result = 'completed' AND coalesce(c.duration_seconds, 0) > $3
        AND c.called_at >= now() - make_interval(months => $2)
        AND coalesce(c.transcribe_error, '') <> 'no_recording'
        AND NOT EXISTS (SELECT 1 FROM va.transcriptions t WHERE t.call_id = c.id)
        AND c.deal_id IN (SELECT d.deal_id FROM sa.deals d WHERE d.funnel_id IN (0,1,2,3) AND (${CLIENT_KEY_SQL}) = ANY($1::text[]))
      ORDER BY c.called_at DESC LIMIT $4`,
    [keys, HISTORY_MONTHS, MIN_SEC, TRANSCRIBE_MAX_CALLS],
  );
  return { send: r.rows.filter(x => !x.in_work).map(x => x.id), inWork: r.rows.filter(x => x.in_work).map(x => x.id), total: r.rows[0]?.total ?? 0, older: await older };
}

export type SendResult =
  | { kind: 'accepted'; accepted: string[]; inProgress: string[]; done: string[]; dropped: number }
  | { kind: 'rate_limited'; retryAfterSec: number }
  | { kind: 'error'; code: string };

export async function requestTranscription(ids: string[], requestedBy: string, source: string): Promise<SendResult> {
  const secret = process.env.TRANSCRIBE_ONDEMAND_SECRET;
  if (!secret) return { kind: 'error', code: 'no_secret' };
  let res: Response;
  try {
    res = await fetch(process.env.TRANSCRIBE_ONDEMAND_URL || URL_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Transcribe-Secret': secret },
      body: JSON.stringify({ call_ids: ids.slice(0, TRANSCRIBE_MAX_CALLS), requested_by: requestedBy, source }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    console.warn('[aiTranscribe] сеть:', e instanceof Error ? e.name : 'error');
    return { kind: 'error', code: 'network' };
  }
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return { kind: 'rate_limited', retryAfterSec: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 60 };
  }
  if (res.status !== 202) {
    console.warn(`[aiTranscribe] ответ ${res.status} на ${ids.length} звонков`);
    return { kind: 'error', code: String(res.status) };
  }
  const j = await res.json().catch(() => ({})) as { accepted?: unknown; skipped?: { id?: unknown; reason?: unknown }[] };
  const accepted = Array.isArray(j.accepted) ? j.accepted.map(String) : [];
  const skipped = Array.isArray(j.skipped) ? j.skipped : [];
  const by = (reason: string) => skipped.filter(s => s?.reason === reason).map(s => String(s.id));
  const dropped = skipped.filter(s => s?.reason !== 'in_progress' && s?.reason !== 'already_transcribed');
  for (const s of dropped) console.log(`[aiTranscribe] пропущен ${String(s?.id)}: ${String(s?.reason)}`);
  return { kind: 'accepted', accepted, inProgress: by('in_progress'), done: by('already_transcribed'), dropped: dropped.length };
}

/** Готовность (ТЗ, раздел 6): текст есть → ready; status failed → failed; иначе в работе. */
export async function transcriptionState(ids: string[]): Promise<{ ready: string[]; failed: string[]; pending: string[] }> {
  if (!ids.length) return { ready: [], failed: [], pending: [] };
  const r = await analyticsDb().query<{ id: string; status: string | null; err: string | null; has_text: boolean }>(
    `SELECT c.id::text, c.status::text, c.transcribe_error AS err,
            EXISTS (SELECT 1 FROM va.transcriptions t WHERE t.call_id = c.id) AS has_text
       FROM va.calls c WHERE c.id = ANY($1::uuid[])`,
    [ids],
  );
  const out = { ready: [] as string[], failed: [] as string[], pending: [] as string[] };
  const seen = new Set<string>();
  for (const x of r.rows) {
    seen.add(x.id);
    if (x.has_text) out.ready.push(x.id);
    else if (x.status === 'failed') { out.failed.push(x.id); console.log(`[aiTranscribe] ${x.id}: ${x.err ?? 'failed'}`); }
    else out.pending.push(x.id);
  }
  for (const id of ids) if (!seen.has(id)) out.failed.push(id); // звонка нет в базе
  return out;
}
