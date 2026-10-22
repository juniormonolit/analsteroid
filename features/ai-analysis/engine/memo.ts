// Памятка менеджеру из отчёта ИИ-анализа: «что предложить дальше» + «риски и обещания», БЕЗ оценки
// менеджера и нарушений (это для РОПа, не для исполнителя задачи). Чистые функции — используются и
// сервером (текст задачи Битрикса, BB-код), и вкладкой (копирование в буфер).

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

export function memoPlain(reportMd: string, createdAt: string): string {
  return [
    `Памятка ИИ (анализ звонков от ${fmtD(createdAt)}):`, '',
    'Что предложить:', ...plainLines(section(reportMd, 3)), '',
    'Риски и обещания:', ...plainLines(section(reportMd, 4)),
  ].join('\n');
}

/** Тот же текст в BB-коде Битрикса — для описания задачи. */
export function memoBbcode(reportMd: string, createdAt: string): string {
  return [
    `[B]Памятка ИИ по звонкам с заказчиком (анализ от ${fmtD(createdAt)}):[/B]`,
    '[I]Что предложить:[/I]', ...plainLines(section(reportMd, 3)),
    '[I]Риски и обещания:[/I]', ...plainLines(section(reportMd, 4)),
  ].join('\n');
}
