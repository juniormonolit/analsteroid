// Шаблоны вопросов РОПа (РОП Осипов 18.11): шаблон = название + несколько вопросов; одна кнопка вставляет в чат
// все вопросы списком. РОП сам создаёт, правит, удаляет и упорядочивает свои шаблоны. Хранение — как у своих колонок
// (customColumns.ts), без миграции: users.ui_prefs.bigDealsTemplates. Ключа нет — стартовый набор (DEFAULT_TEMPLATES);
// сохранённый пустой массив — «удалил всё», стартовый набор не возвращаем.
import { systemDb } from '@/lib/db/clients';

import { DEFAULT_TEMPLATES, MAX_QUESTIONS, MAX_TEMPLATES, type BigQuestionTemplate } from './templateDefaults';

export { DEFAULT_TEMPLATES, MAX_QUESTIONS, MAX_TEMPLATES, type BigQuestionTemplate };

export class BigTemplateError extends Error {}

/** Чистка входа: мусор отбрасывается, пустые шаблоны — ошибка с понятным текстом. */
export function cleanTemplates(raw: unknown): BigQuestionTemplate[] {
  if (!Array.isArray(raw)) throw new BigTemplateError('Некорректный список шаблонов');
  if (raw.length > MAX_TEMPLATES) throw new BigTemplateError(`Не больше ${MAX_TEMPLATES} шаблонов`);
  const ids = new Set<string>();
  return raw.map((x, i) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
    if (name.length < 2) throw new BigTemplateError(`Шаблон ${i + 1}: назовите его`);
    const qs = (Array.isArray(r.questions) ? r.questions : [])
      .map(q => (typeof q === 'string' ? q.trim().replace(/\s+/g, ' ').slice(0, 300) : ''))
      .filter(Boolean);
    if (!qs.length) throw new BigTemplateError(`«${name}»: добавьте хотя бы один вопрос`);
    if (qs.length > MAX_QUESTIONS) throw new BigTemplateError(`«${name}»: не больше ${MAX_QUESTIONS} вопросов`);
    let id = typeof r.id === 'string' && /^[a-z0-9]{2,20}$/i.test(r.id) ? r.id : '';
    if (!id || ids.has(id)) id = `t${Date.now().toString(36)}${i}`;
    ids.add(id);
    return { id, name, questions: qs };
  });
}

export async function listTemplates(userId: string): Promise<BigQuestionTemplate[]> {
  try {
    const r = await systemDb().query<{ t: unknown }>(`SELECT ui_prefs->'bigDealsTemplates' AS t FROM users WHERE id = $1`, [userId]);
    const v = r.rows[0]?.t;
    if (v === null || v === undefined) return DEFAULT_TEMPLATES;
    try { return cleanTemplates(v); } catch { return DEFAULT_TEMPLATES; }
  } catch (e) {
    console.warn('[big-deals templates]', e instanceof Error ? e.message : e);
    return DEFAULT_TEMPLATES;
  }
}

export async function saveTemplates(userId: string, raw: unknown): Promise<BigQuestionTemplate[]> {
  const list = cleanTemplates(raw);
  await systemDb().query(
    `UPDATE users SET ui_prefs = jsonb_set(COALESCE(ui_prefs, '{}'::jsonb), '{bigDealsTemplates}', $2::jsonb) WHERE id = $1`,
    [userId, JSON.stringify(list)]);
  return list;
}
