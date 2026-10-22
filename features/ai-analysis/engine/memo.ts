// Памятка менеджеру из отчёта ИИ-анализа, БЕЗ оценки менеджера и нарушений (это для РОПа). С промпта
// v5 модель пишет её сама — раздел 8, 3–5 коротких строк (владелец 23.10: «менеджер такую кучу читать
// заебётся»); в старых отчётах раздела нет — собираем из «что предложить» + «риски» (длинно).
// Чистые функции — и сервер (описание задачи, BB-код), и вкладка (карточка памятки, копирование).

/** Отчёт моложе — вставляем в задачу автоматически; старше — уже мог устареть. */
export const MEMO_FRESH_DAYS = 14;

function section(md: string, n: number): string | null {
  const parts = md.split(/^#{2,4}\s*(\d)\.\s*[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) if (Number(parts[i]) === n) return parts[i + 1].trim() || null;
  return null;
}

const fmtD = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' });

/** Строки раздела без markdown-разметки, пункты — «— ». */
function plainLines(md: string | null): string[] {
  if (!md) return ['—'];
  return md.split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => l.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*\n]+)\*/g, '$1').replace(/^[-*•]\s+/, '— '));
}

/** Строки памятки: раздел 8 (короткая), нет — null (старый отчёт). */
export function memoLines(reportMd: string): string[] | null {
  const s8 = section(reportMd, 8);
  return s8 ? plainLines(s8) : null;
}

export function memoPlain(reportMd: string, createdAt: string): string {
  const short = memoLines(reportMd);
  if (short) return [`Памятка ИИ (анализ звонков от ${fmtD(createdAt)}):`, ...short].join('\n');
  return [
    `Памятка ИИ (анализ звонков от ${fmtD(createdAt)}):`, '',
    'Что предложить:', ...plainLines(section(reportMd, 3)), '',
    'Риски и обещания:', ...plainLines(section(reportMd, 4)),
  ].join('\n');
}

// ── BB-коды Битрикса (проверено владельцем 23.10 в чате бота и чате задачи): работают [B] [I] [U] [S]
// [COLOR] [SIZE] [URL] [USER] и строка «>>» (цитата); НЕ работают [LIST]/[*], [QUOTE], [TABLE] —
// поэтому списки строками с «•», акценты — жирным и цветом.
const RED = '#cc0000';
/** #888 на тёмной теме мобильного Битрикса почти не виден (разбор Fable 23.10). */
const GRAY = '#999999';
/** Модель пишет «[компания]» и т.п. — квадратные скобки не должны съедаться как тег. */
const safe = (t: string) => t.replace(/\[(?=\/?(?:B|I|U|S|COLOR|SIZE|URL|USER|CODE)\b)/gi, '［').replace(/\*\*/g, '');

/** Префиксы памятки (промпт v7) — жирным выделяется только он, не полстроки. */
const PREFIX = /^(Зайти с|Предложить|Уточнить|Когда|Сроки|Не забыть|Риск|Важно):\s*/i;

/** Строка памятки → BB: «•» и жирный префикс; «Не забыть/риск» — ⚠️ и красный ТОЛЬКО префикс
 *  (красная строка целиком читается как «ошибка»). Старые отчёты без префиксов — просто «•». */
function bbLine(line: string): string {
  const t = safe(line.replace(/^—\s*/, '').trim());
  const m = t.match(PREFIX);
  if (!m) return `• ${t}`;
  const rest = t.slice(m[0].length);
  if (/^(не забыть|риск|важно)/i.test(m[1])) return `⚠️ [COLOR=${RED}][B]${m[1]}:[/B][/COLOR] ${rest}`;
  return `• [B]${m[1]}:[/B] ${rest}`;
}

const DAY = 86_400_000;
function bbHeader(createdAt: string, updated?: boolean): string {
  const old = Date.now() - new Date(createdAt).getTime() > MEMO_FRESH_DAYS * DAY;
  const when = old ? `[COLOR=${RED}]анализ ${fmtD(createdAt)} — проверь актуальность[/COLOR]` : `[COLOR=${GRAY}]· ИИ, анализ ${fmtD(createdAt)}${updated ? ' · обновлено' : ''}[/COLOR]`;
  return `🧠 [B]Перед звонком[/B] ${when}`;
}

/** Памятка в BB-коде — для описания задачи и комментария в её чат (там `updated` — «обновлено»). */
export function memoBbcode(reportMd: string, createdAt: string, opts: { updated?: boolean } = {}): string {
  const short = memoLines(reportMd);
  const body = short
    ? short.map(bbLine)
    : [
      '[B]Что предложить:[/B]', ...plainLines(section(reportMd, 3)).map(bbLine),
      '[B]Риски и обещания:[/B]', ...plainLines(section(reportMd, 4)).map(l => `⚠️ ${safe(l.replace(/^—\s*/, ''))}`),
    ];
  return [bbHeader(createdAt, opts.updated), ...body].join('\n');
}
