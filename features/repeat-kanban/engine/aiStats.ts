// «Аналитика канбана повторных» → вкладка «ИИ-разборы» (владелец 26.10: «где-то хочу видеть, что там по ИИ-разборам,
// какая статистика»). За период: разборы заказчиков (сколько, по скольким заказчикам, кто запускал, средний балл
// проработки, нарушения, отзывы «полезно/неточно», памятка ушла в задачу), проверки звонка по задаче (вердикты),
// запросы менеджеров «Запросить разбор» (миграция 257: сколько, сколько ждут, за сколько выполняют). Сейчас —
// кандидаты: разбора не было, звонков с расшифровкой ≥ AI_CANDIDATE_MIN. Стоимость не показываем (владелец 23.10).
// Разрез по менеджеру — основной менеджер разбора (main_manager, имя → оргструктура), дерево — на клиенте.
import { systemDb } from '@/lib/db/clients';
import { AI_CANDIDATE_MIN } from './config';
import { fetchTranscribedCounts } from './aiMarks';
import { fetchManagerDirectory, periodBounds, type Period } from './saLookups';

export interface AiStatsMgr { managerId: string; analyses: number; scoreSum: number; scoreN: number; violations: number; requests: number }
export interface AiStats {
  fromDate: string; period: Period;
  analyses: number; clients: number; errors: number; useful: number; inaccurate: number; memoInTask: number;
  avgScore: number | null; violations: number;
  checks: number; verdicts: Record<string, number>;
  requests: number; requestsPending: number; requestsDone: number; requestHours: number[];
  candidates: number; analysedEver: number;
  runners: { name: string; analyses: number; clients: number; checks: number }[];
  days: { date: string; analyses: number; checks: number }[];
  mgr: AiStatsMgr[];
  /** Разборы, у которых основной менеджер не нашёлся в оргструктуре. */
  noManager: number;
}

export async function fetchAiStats(opts: { date: string; period: Period; managerIds: string[] | null }): Promise<AiStats> {
  const { fromDate, from, to } = periodBounds(opts.date, opts.period);
  const db = systemDb();
  const [rows, reqs, everRefs, directory, transcribed] = await Promise.all([
    db.query<{ kind: string; status: string; client_ref: string; created_by_name: string | null; created_by: string; main_manager: string | null;
      score: string | null; violations: number | null; feedback: string | null; memo: boolean; verdict: string | null; day: string }>(
      `SELECT kind, status, client_ref, created_by_name, created_by, main_manager, score::text AS score,
              coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(parsed->'violations') = 'array' THEN parsed->'violations' END), 0) AS violations,
              feedback, memo_inserted_at IS NOT NULL AS memo, parsed->'taskCheck'->>'verdict' AS verdict,
              to_char(created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day
         FROM ai_analyses WHERE NOT is_test AND created_at BETWEEN $1::timestamptz AND $2::timestamptz`, [from, to]).then(r => r.rows),
    db.query<{ requested_by_name: string | null; requested_at: Date; done_at: Date | null }>(
      `SELECT q.requested_by_name, q.requested_at,
              (SELECT min(a.created_at) FROM ai_analyses a WHERE a.client_ref = q.client_ref AND a.status = 'done' AND NOT a.is_test
                 AND a.kind = 'client' AND a.created_at > q.requested_at) AS done_at
         FROM ai_analysis_requests q WHERE q.requested_at BETWEEN $1::timestamptz AND $2::timestamptz`, [from, to]).then(r => r.rows)
      .catch(() => []),
    db.query<{ client_ref: string }>(`SELECT DISTINCT client_ref FROM ai_analyses WHERE NOT is_test AND kind = 'client' AND status = 'done'`).then(r => r.rows),
    fetchManagerDirectory(),
    fetchTranscribedCounts().catch(() => new Map<string, number>()),
  ]);
  const idByName = new Map<string, string>();
  for (const [id, m] of directory) if (m.name) idByName.set(m.name.trim().toLowerCase(), id);
  const scope = opts.managerIds ? new Set(opts.managerIds) : null;
  const mgrOf = (name: string | null) => (name ? idByName.get(name.trim().toLowerCase()) ?? null : null);
  const inScope = (name: string | null) => !scope || (!!mgrOf(name) && scope.has(mgrOf(name)!));

  const out: AiStats = {
    fromDate, period: opts.period, analyses: 0, clients: 0, errors: 0, useful: 0, inaccurate: 0, memoInTask: 0, avgScore: null, violations: 0,
    checks: 0, verdicts: {}, requests: 0, requestsPending: 0, requestsDone: 0, requestHours: [], candidates: 0, analysedEver: everRefs.length,
    runners: [], days: [], mgr: [], noManager: 0,
  };
  const clients = new Set<string>(), runners = new Map<string, { name: string; analyses: number; clients: Set<string>; checks: number }>();
  const days = new Map<string, { analyses: number; checks: number }>(), mgr = new Map<string, AiStatsMgr>();
  const M = (id: string) => { let m = mgr.get(id); if (!m) { m = { managerId: id, analyses: 0, scoreSum: 0, scoreN: 0, violations: 0, requests: 0 }; mgr.set(id, m); } return m; };
  let scoreSum = 0, scoreN = 0;
  for (const r of rows) {
    if (!inScope(r.main_manager) && r.kind === 'client') continue;
    const who = r.created_by_name ?? r.created_by;
    const ru = runners.get(who) ?? { name: who, analyses: 0, clients: new Set<string>(), checks: 0 };
    runners.set(who, ru);
    const d = days.get(r.day) ?? { analyses: 0, checks: 0 };
    days.set(r.day, d);
    if (r.status === 'error') { out.errors++; continue; }
    if (r.status !== 'done') continue;
    if (r.kind === 'task_check') {
      out.checks++; ru.checks++; d.checks++;
      if (r.verdict) out.verdicts[r.verdict] = (out.verdicts[r.verdict] ?? 0) + 1;
      continue;
    }
    out.analyses++; ru.analyses++; ru.clients.add(r.client_ref); d.analyses++; clients.add(r.client_ref);
    if (r.feedback === 'useful') out.useful++; else if (r.feedback === 'inaccurate') out.inaccurate++;
    if (r.memo) out.memoInTask++;
    out.violations += Number(r.violations ?? 0);
    const score = r.score === null ? null : Number(r.score);
    if (score !== null) { scoreSum += score; scoreN++; }
    const id = mgrOf(r.main_manager);
    if (!id) { out.noManager++; continue; }
    const m = M(id);
    m.analyses++; m.violations += Number(r.violations ?? 0);
    if (score !== null) { m.scoreSum += score; m.scoreN++; }
  }
  out.clients = clients.size;
  out.avgScore = scoreN ? scoreSum / scoreN : null;
  for (const q of reqs) {
    const id = mgrOf(q.requested_by_name);
    if (scope && (!id || !scope.has(id))) continue;
    out.requests++;
    if (q.done_at) { out.requestsDone++; out.requestHours.push(Math.round((new Date(q.done_at).getTime() - new Date(q.requested_at).getTime()) / 3_600_000)); }
    else out.requestsPending++;
    if (id) M(id).requests++;
  }
  // Кандидаты — сейчас: ключи доски (x<id> = c<id> разбора) с ≥ AI_CANDIDATE_MIN расшифровками и без готового разбора.
  const analysed = new Set(everRefs.map(r => r.client_ref));
  for (const [k, n] of transcribed) if (n >= AI_CANDIDATE_MIN && !analysed.has(k.startsWith('x') ? `c${k.slice(1)}` : k)) out.candidates++;
  out.runners = [...runners.values()].filter(r => r.analyses + r.checks > 0)
    .map(r => ({ name: r.name, analyses: r.analyses, clients: r.clients.size, checks: r.checks })).sort((a, b) => b.analyses - a.analyses || b.checks - a.checks);
  out.days = [...days.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));
  out.mgr = [...mgr.values()];
  return out;
}
