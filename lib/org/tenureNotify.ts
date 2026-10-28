// Задача 11110 (план п.5): синк оргструктуры увидел, что на учётке сменилось ФИО
// на настоящего человека, → РОПу этого отдела пуш ботом «Аналитик»: «учётка
// сменила хозяина, проставь дату начала». Без даты стаж нового человека в
// «Сотрудниках» — «не заполнено», в профиле — с момента смены.
//
// Правила Серёги: Аналитик — кореш, не надзиратель (это подсказка РОПу по его же
// отделу, без оценок); пачку однотипных схлопываем в одно сообщение на РОПа;
// отправка best-effort после коммита синка, в try/catch — синк не падает.
// Рубильники: bot_settings.dry_run_managers (при dry-run только лог в
// bot_outbound_log) + функция бота 'tenure_owner_change' (миграция 258, по
// умолчанию выключена — включает владелец в «Настройки → Боты»).
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { isPlaceholderName, samePerson } from '@/features/employees/engine/personSegment';

export interface OwnerChange { bitrixId: string; prevName: string; newName: string; ropId: string | null }

/** Смена ФИО = новый человек на учётке? Заглушка (уход) и косметика
 *  («Иванов (РОП)» → «Иванов») — нет. */
export function isOwnerChange(prevName: string, newName: string): boolean {
  if (isPlaceholderName(newName)) return false;
  return !samePerson(prevName, newName);
}

function baseUrl(): string {
  return (process.env.APP_BASE_URL || 'https://monolitika.mlt-it.com').replace(/\/$/, '');
}

/** Текст РОПу (чистая функция — покрыта тестом). */
export function ownerChangeText(changes: OwnerChange[]): string {
  const lines = changes.map(c => {
    const was = isPlaceholderName(c.prevName) ? 'была свободна' : `была за «${c.prevName}»`;
    return `• [b]${c.newName}[/b] — учётка ${c.bitrixId} (${was}): [url=${baseUrl()}/employees?q=${c.bitrixId}]проставить дату начала[/url]`;
  });
  const head = changes.length === 1
    ? 'У тебя в отделе учётка сменила хозяина.'
    : `У тебя в отделе ${changes.length} учётки сменили хозяина.`;
  return `[b]${head}[/b]\n${lines.join('\n')}\n\n`
    + 'Поставь дату, когда человек реально начал работать, — тогда стаж и опыт посчитаются по нему, а не по прошлому хозяину учётки.';
}

export async function notifyOwnerChanges(changes: OwnerChange[]): Promise<number> {
  const byRop = new Map<string, OwnerChange[]>();
  for (const c of changes) {
    if (!c.ropId || c.ropId === c.bitrixId) continue; // РОП сам себе — некому подсказывать
    const list = byRop.get(c.ropId) ?? [];
    list.push(c);
    byRop.set(c.ropId, list);
  }
  let queued = 0;
  for (const [ropId, list] of byRop) {
    try {
      await sendManagerBotMessage(Number(ropId), ownerChangeText(list), 'tenure_owner_change', 'org-sync: смена ФИО на учётке', {
        decisionTrace: { rule: 'org-sync renamed → новый человек (не заглушка)', changes: list },
      });
      queued++;
    } catch (e) {
      console.warn(`[org-sync] пуш РОПу ${ropId} о смене хозяина учётки не ушёл:`, e instanceof Error ? e.message : e);
    }
  }
  return queued;
}
