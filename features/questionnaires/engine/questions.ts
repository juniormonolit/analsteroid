// Анкеты по товарным группам (миграция 244, владелец 22.10: «для каждой товарной группы —
// своего рода анкета/форма кастомная»). Редактор — «Что предложить» → «Анкеты». Дальше на них
// построится бриф менеджера в карточке клиента (ответы → закреплённый комментарий в сделку),
// поэтому вопрос не удаляется, а архивируется: на его id будут ссылаться ответы.
import { systemDb } from '@/lib/db/clients';

import { QUESTION_AUDIENCES, QUESTION_KINDS, MAX_OPTIONS, MAX_QUESTIONS, type GroupQuestion, type QuestionAudience, type QuestionKind } from './types';
export * from './types';

export class QuestionnaireError extends Error {}

/** Активные вопросы: группа → по порядку. */
export async function fetchQuestionnaires(groups?: string[]): Promise<Map<string, GroupQuestion[]>> {
  const r = await systemDb().query<{ id: number; group_name: string; question: string; hint: string | null; kind: QuestionKind; options: string[]; required: boolean; audience: QuestionAudience }>(
    `SELECT id, group_name, question, hint, kind, options, required, audience FROM group_questions
      WHERE archived_at IS NULL ${groups ? 'AND group_name = ANY($1::text[])' : ''}
      ORDER BY group_name, position, id`,
    groups ? [groups] : [],
  );
  const out = new Map<string, GroupQuestion[]>();
  for (const x of r.rows) {
    const l = out.get(x.group_name) ?? [];
    l.push({ id: x.id, question: x.question, hint: x.hint, kind: x.kind, options: x.options ?? [], required: x.required, audience: x.audience ?? 'client' });
    out.set(x.group_name, l);
  }
  return out;
}

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Проверка и нормализация присланной анкеты (без записи). */
export function normalizeQuestions(raw: unknown): GroupQuestion[] {
  if (!Array.isArray(raw)) throw new QuestionnaireError('Некорректный список вопросов');
  if (raw.length > MAX_QUESTIONS) throw new QuestionnaireError(`Не больше ${MAX_QUESTIONS} вопросов в анкете`);
  return raw.map((q: Record<string, unknown>, i) => {
    const n = i + 1;
    const question = clean(q?.question, 500);
    if (!question) throw new QuestionnaireError(`Вопрос ${n}: пустой текст`);
    const kind = QUESTION_KINDS.some(k => k.value === q?.kind) ? q.kind as QuestionKind : null;
    if (!kind) throw new QuestionnaireError(`Вопрос ${n}: не выбран тип ответа`);
    let options: string[] = [];
    if (kind !== 'text') {
      options = (Array.isArray(q?.options) ? q.options : []).map(o => clean(o, 200)).filter(Boolean);
      const seen = new Set<string>();
      for (const o of options) {
        if (seen.has(o.toLowerCase())) throw new QuestionnaireError(`Вопрос ${n}: вариант «${o}» повторяется`);
        seen.add(o.toLowerCase());
      }
      if (options.length < 2) throw new QuestionnaireError(`Вопрос ${n}: нужно хотя бы два варианта ответа`);
      if (options.length > MAX_OPTIONS) throw new QuestionnaireError(`Вопрос ${n}: не больше ${MAX_OPTIONS} вариантов`);
    }
    const id = Number.isInteger(q?.id) && (q.id as number) > 0 ? q.id as number : null;
    const audience: QuestionAudience = QUESTION_AUDIENCES.some(a => a.value === q?.audience) ? q.audience as QuestionAudience : 'client';
    return { id, question, hint: clean(q?.hint, 300) || null, kind, options, required: q?.required === true, audience };
  });
}

/** Сохранить анкету группы целиком: присланные id — обновить, новые — добавить, пропавшие — в архив. */
export async function saveQuestionnaire(group: string, questions: GroupQuestion[], by: string): Promise<GroupQuestion[]> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ id: number }>(
      `SELECT id FROM group_questions WHERE group_name = $1 AND archived_at IS NULL FOR UPDATE`, [group]);
    const own = new Set(cur.rows.map(r => r.id));
    const kept = new Set<number>();
    for (const [pos, q] of questions.entries()) {
      if (q.id !== null && own.has(q.id)) {
        kept.add(q.id);
        await client.query(
          `UPDATE group_questions SET position = $2, question = $3, hint = $4, kind = $5, options = $6, required = $7,
                  updated_by = $8, updated_at = now(), audience = $9
            WHERE id = $1`,
          [q.id, pos, q.question, q.hint, q.kind, q.options, q.required, by, q.audience]);
      } else {
        const r = await client.query<{ id: number }>(
          `INSERT INTO group_questions (group_name, position, question, hint, kind, options, required, created_by, updated_by, audience)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9) RETURNING id`,
          [group, pos, q.question, q.hint, q.kind, q.options, q.required, by, q.audience]);
        q.id = r.rows[0].id;
      }
    }
    const gone = [...own].filter(id => !kept.has(id));
    if (gone.length) {
      await client.query(`UPDATE group_questions SET archived_at = now(), updated_by = $2, updated_at = now() WHERE id = ANY($1::int[])`, [gone, by]);
    }
    await client.query('COMMIT');
    return questions;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
