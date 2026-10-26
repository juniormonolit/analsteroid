// Разбор звонков для менеджера (владелец 26.10: «показывать менеджеру вкладку ИИ-анализа, если он есть; кнопку
// запуска — нет; ТОЛЬКО перечисленные пункты, транскрибации менеджер не видит»). Отдаём из последнего готового
// разбора только разделы про заказчика: 1 «Кто заказчик», 2 «Объекты», 3 «Что нужно дальше», 4 «Риски и
// договорённости», 8 «Памятка». Оценка менеджера (5), нарушения (6), качество данных (7), звонки, расшифровки,
// проверка цитат, история разборов — не уходят с сервера вовсе. РОПу (право ИИ-анализа) — полная вкладка, как была.
import { systemDb } from '@/lib/db/clients';

export const MANAGER_SECTIONS = [1, 2, 3, 4, 8] as const;
export interface ManagerBrief { createdAt: string; sections: { n: number; title: string; md: string }[] }

export async function fetchManagerBrief(clientRef: string): Promise<ManagerBrief | null> {
  const r = await systemDb().query<{ report_md: string | null; created_at: Date }>(
    `SELECT report_md, created_at FROM ai_analyses
      WHERE client_ref = $1 AND status = 'done' AND NOT is_test AND kind = 'client' AND report_md IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`, [clientRef]);
  const row = r.rows[0];
  if (!row?.report_md) return null;
  // Заголовки «### N. Название» — как splitSections во вкладке РОПа.
  const parts = row.report_md.split(/^#{2,4}\s*(\d{1,2})\.\s*([^\n]*)$/m);
  const sections: ManagerBrief['sections'] = [];
  for (let i = 1; i < parts.length; i += 3) {
    const n = Number(parts[i]);
    if ((MANAGER_SECTIONS as readonly number[]).includes(n)) sections.push({ n, title: parts[i + 1].trim(), md: (parts[i + 2] ?? '').trim() });
  }
  return sections.length ? { createdAt: new Date(row.created_at).toISOString(), sections } : null;
}
