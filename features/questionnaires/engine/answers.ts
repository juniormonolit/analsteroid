// Ответы на анкеты по товарным группам (миграция 249, владелец 23.10: ответы заполняет ИИ по разговорам
// «с пометкой, что заполнено автоматом» ИЛИ менеджер в карточке клиента (в т.ч. внутри Битрикса); «сохраняться и
// выводиться должны оба варианта»). Источники не затирают друг друга; новый ответ того же источника гасит прежний
// (superseded_at) — история остаётся для самообучения (согласие «по разговорам» ↔ менеджер по вопросу).
//
// saveAiAnswers — контракт для разбора звонков (features/ai-analysis): вызывать ПОСЛЕ проверки ответа модели кодом
// (вопрос — из выданных, варианты — из списка, цитата найдена в расшифровке).
import { systemDb } from '@/lib/db/clients';
import { COMMON_GROUP, type GroupQuestion } from './types';

export class AnswerError extends Error {}

export interface StoredAnswer {
  text: string | null;
  options: string[] | null;
  /** Кто ответил: менеджер — логин/имя; по разговорам — null. */
  by: string | null;
  at: string;
  /** Только «по разговорам»: дословная цитата и звонок. */
  quote: string | null;
  calledAt: string | null;
  confidence: number | null;
}
export interface ClientQuestion extends GroupQuestion { group: string; manager: StoredAnswer | null; ai: StoredAnswer | null }

const REF_RE = /^[ck]\d{1,12}$/;

/** Вопросы анкет групп (+ общие) с актуальными ответами обоих источников. */
export async function fetchClientQuestionnaire(clientRef: string, groups: string[]): Promise<ClientQuestion[]> {
  if (!REF_RE.test(clientRef)) throw new AnswerError('Некорректный заказчик');
  const want = [COMMON_GROUP, ...new Set(groups.filter(g => g && g !== COMMON_GROUP))].slice(0, 60);
  const db = systemDb();
  const q = await db.query<{ id: number; group_name: string; question: string; hint: string | null; kind: GroupQuestion['kind']; options: string[]; required: boolean }>(
    `SELECT id, group_name, question, hint, kind, options, required FROM group_questions
      WHERE archived_at IS NULL AND group_name = ANY($1::text[])
      ORDER BY array_position($1::text[], group_name), position, id`, [want],
  );
  if (!q.rows.length) return [];
  const a = await db.query<{ question_id: number; source: 'ai' | 'manager'; answer_text: string | null; answer_options: string[] | null; quote: string | null;
    called_at: Date | null; confidence: string | null; answered_by_name: string | null; answered_by: string | null; created_at: Date }>(
    `SELECT question_id, source, answer_text, answer_options, quote, called_at, confidence, answered_by_name, answered_by, created_at
       FROM questionnaire_answers WHERE client_ref = $1 AND superseded_at IS NULL AND question_id = ANY($2::int[])`,
    [clientRef, q.rows.map(r => r.id)],
  );
  const ans = new Map(a.rows.map(r => [`${r.question_id}:${r.source}`, {
    text: r.answer_text, options: r.answer_options, by: r.source === 'manager' ? r.answered_by_name ?? r.answered_by : null,
    at: new Date(r.created_at).toISOString(), quote: r.quote, calledAt: r.called_at ? new Date(r.called_at).toISOString() : null,
    confidence: r.confidence !== null ? Number(r.confidence) : null,
  } satisfies StoredAnswer]));
  return q.rows.map(r => ({
    id: r.id, group: r.group_name, question: r.question, hint: r.hint, kind: r.kind, options: r.options ?? [], required: r.required,
    manager: ans.get(`${r.id}:manager`) ?? null, ai: ans.get(`${r.id}:ai`) ?? null,
  }));
}

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Ответ «по разговорам» из разбора: вопрос — по id; для single/multi варианты только из списка вопроса. */
export interface AiAnswerInput {
  questionId: number;
  text?: string | null;
  options?: string[] | null;
  /** Дословная цитата клиента (проверенная по расшифровке), id звонка, когда звонили (ISO), уверенность 0..1. */
  quote?: string | null; callId?: string | null; calledAt?: string | null; confidence?: number | null;
}

/** Нормализация ответа по типу вопроса: варианты — только из списка; пусто — null (ответ снят). */
function normalize(q: { kind: GroupQuestion['kind']; options: string[] }, raw: { text?: unknown; options?: unknown }): { text: string | null; options: string[] | null } | null {
  if (q.kind === 'text') {
    const t = clean(raw.text, 2000);
    return t ? { text: t, options: null } : null;
  }
  const list = (Array.isArray(raw.options) ? raw.options : []).map(o => clean(o, 200)).filter(o => q.options.includes(o));
  const opts = q.kind === 'single' ? list.slice(0, 1) : [...new Set(list)];
  const extra = clean(raw.text, 500); // «другое» — свободным текстом рядом с вариантами
  return opts.length || extra ? { text: extra || null, options: opts.length ? opts : null } : null;
}

async function save(clientRef: string, source: 'ai' | 'manager', items: { questionId: number; text?: unknown; options?: unknown; quote?: unknown; callId?: unknown; calledAt?: unknown; confidence?: unknown }[],
  meta: { by: string | null; byName: string | null; analysisId: number | null }): Promise<number> {
  if (!REF_RE.test(clientRef)) throw new AnswerError('Некорректный заказчик');
  const ids = [...new Set(items.map(i => Number(i.questionId)).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) return 0;
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const qs = await client.query<{ id: number; question: string; kind: GroupQuestion['kind']; options: string[] }>(
      `SELECT id, question, kind, options FROM group_questions WHERE id = ANY($1::int[])`, [ids]);
    const byId = new Map(qs.rows.map(r => [r.id, r]));
    const cur = await client.query<{ question_id: number; answer_text: string | null; answer_options: string[] | null }>(
      `SELECT question_id, answer_text, answer_options FROM questionnaire_answers
        WHERE client_ref = $1 AND source = $2 AND superseded_at IS NULL AND question_id = ANY($3::int[]) FOR UPDATE`, [clientRef, source, ids]);
    const curBy = new Map(cur.rows.map(r => [r.question_id, r]));
    let changed = 0;
    for (const it of items) {
      const q = byId.get(Number(it.questionId));
      if (!q) continue;
      const v = normalize(q, it);
      const old = curBy.get(q.id);
      const same = old ? JSON.stringify([old.answer_text, old.answer_options]) === JSON.stringify([v?.text ?? null, v?.options ?? null]) : !v;
      if (same) continue;
      if (old) await client.query(`UPDATE questionnaire_answers SET superseded_at = now() WHERE client_ref = $1 AND source = $2 AND question_id = $3 AND superseded_at IS NULL`, [clientRef, source, q.id]);
      if (v) {
        const conf = typeof it.confidence === 'number' && it.confidence >= 0 && it.confidence <= 1 ? Math.round(it.confidence * 100) / 100 : null;
        const calledAt = typeof it.calledAt === 'string' && !Number.isNaN(Date.parse(it.calledAt)) ? it.calledAt : null;
        await client.query(
          `INSERT INTO questionnaire_answers (client_ref, question_id, question_text, source, answer_text, answer_options, quote, call_id, called_at, confidence, analysis_id, answered_by, answered_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [clientRef, q.id, q.question, source, v.text, v.options, clean(it.quote, 500) || null, clean(it.callId, 64) || null, calledAt, conf, meta.analysisId, meta.by, meta.byName]);
      }
      changed++;
    }
    await client.query('COMMIT');
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Ответы менеджера (карточка клиента в Монолитике или вкладка в Битриксе). Пустой ответ — снять. */
export function saveManagerAnswers(clientRef: string, items: { questionId: number; text?: unknown; options?: unknown }[], by: string, byName: string | null): Promise<number> {
  return save(clientRef, 'manager', items, { by, byName, analysisId: null });
}

/** Ответы «по разговорам» из разбора звонков. Ответы менеджера не трогает. */
export function saveAiAnswers(clientRef: string, analysisId: number, items: AiAnswerInput[]): Promise<number> {
  return save(clientRef, 'ai', items, { by: null, byName: null, analysisId });
}
