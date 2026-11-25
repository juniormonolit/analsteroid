// Раздел Монолитики по пути: первый сегмент ('/tasker/12' → 'tasker', '/' → 'home').
// Два сегмента — там, где за вторым стоит самостоятельный экран:
//   встроенные страницы Битрикса '/bx/manager' → 'bx/manager';
//   отчёты '/sales/by-managers' → 'sales/by-managers', '/marketing/general' → 'marketing/general',
//          '/realizations/logists' → 'realizations/logists';
//   сохранённые отчёты — три сегмента: '/sales/saved/<uuid>' → 'sales/saved/<uuid>' (имя — saved_reports.name).
// До 26.11 отчёты писались одним 'sales' (путь — в payload.path); выборки «Обзора» достают slug оттуда.
const TWO_SEGMENT = new Set(['bx', 'sales', 'marketing', 'realizations']);

export function sectionOfPath(path: string): string {
  const seg = path.split(/[?#]/)[0].split('/').filter(Boolean);
  if (!seg.length) return 'home';
  if (seg[0] === 'sales' && seg[1] === 'saved' && seg[2]) return `sales/saved/${seg[2]}`.slice(0, 60);
  if (TWO_SEGMENT.has(seg[0]) && seg[1]) return `${seg[0]}/${seg[1]}`.slice(0, 60);
  return seg[0].slice(0, 60);
}

/** Раздел — отчёт (для блока «Отчёты» на «Обзоре» и записи report_load). */
export function isReportSection(section: string): boolean {
  return /^(sales\/(?!unsell-deal$)|marketing\/|realizations\/)/.test(section);
}

/** SQL-выражение «раздел события с учётом старых записей» (section='sales' + payload.path) — для выборок. */
export const SECTION_SQL = `CASE WHEN section = 'sales' AND payload->>'path' IS NOT NULL
  THEN COALESCE(substring(payload->>'path' from '^/(sales/saved/[0-9a-zA-Z-]+|sales/[^/?#]+)'), 'sales')
  ELSE section END`;
