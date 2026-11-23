// Форматтеры и даты Задачника (общие для доски, недели, «Сегодня» и карточки). Время — МСК.
import type { TaskerMetric, TaskerTask, TaskerVerdict } from '../../types';

const TZ = 'Europe/Moscow';
const MSK_OFFSET_MS = 3 * 3600_000;

const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Значение метрики в её формате: 12,5 % / 85 000 ₽ / 42. */
export function fmtValue(v: number | null | undefined, format: TaskerMetric['format']): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${num.format(v)} %`;
  if (format === 'money') return `${rub.format(v)} ₽`;
  return num.format(v);
}

/** «Фамилия И.» — как в канбанах. */
export function shortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? name;
  const [last, first] = parts.length === 2 ? [parts[1], parts[0]] : [parts[0], parts[1]];
  return `${last} ${first[0]}.`;
}

/** Календарная дата МСК YYYY-MM-DD для ISO-времени или YYYY-MM-DD. */
export function mskDay(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Date(new Date(iso).getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

export const todayMsk = () => mskDay(new Date().toISOString());

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Понедельник недели, в которую попадает day (YYYY-MM-DD). */
export function mondayOf(day: string): string {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = вс
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

/** «11:00» по МСК. */
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
/** «17.11» */
export const fmtD = (iso: string | null) => (iso ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: TZ }) : '—');
/** «17.11, 11:00» */
export const fmtDT = (iso: string | null) => (iso ? `${fmtD(iso)}, ${fmtTime(iso)}` : '—');
/** «пн, 17 нояб.» */
export const fmtDayLong = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Задача ещё не сдана менеджером (для «просрочено»). */
export const isOpen = (t: TaskerTask) => t.status === 'new' || t.status === 'in_progress' || (t.status as string) === 'awaiting_control';

/** Срок прошёл, а задача не сдана. */
export const isOverdue = (t: TaskerTask, now = Date.now()) => isOpen(t) && new Date(t.deadline).getTime() < now;

export const VERDICT_CLS: Record<TaskerVerdict, string> = {
  achieved: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]',
  improved: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  no_change: 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]',
  not_enough_data: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]',
};


// ── Колонки доски (правки собрания 23.11) ────────────────────────────────────
// «Ждёт контроля» убрана: РОП закрывает задачу сам с «Что сделано». Старые задачи в статусе 4
// Битрикса (если ещё попадутся) показываем в «В работе» — подтверждать их больше некому.
// «Итог» разделён по знаку результата: «Вырос» (achieved/improved) и «Не вырос» (no_change,
// not_enough_data — серой пометкой).
export type BoardColumn = 'new' | 'in_progress' | 'done' | 'measuring' | 'grown' | 'not_grown';
export const BOARD_COLUMNS: BoardColumn[] = ['new', 'in_progress', 'done', 'measuring', 'grown', 'not_grown'];
export const BOARD_COLUMN_LABELS: Record<BoardColumn, string> = {
  new: 'Новая', in_progress: 'В работе', done: 'Завершена', measuring: 'На замере', grown: 'Вырос', not_grown: 'Не вырос',
};
/** Цвет полосы колонки — палитра Google Sheets (main_color_palette). */
export const STATUS_COLOR: Record<BoardColumn, string> = {
  new: '#4a86e8', in_progress: '#ff9900', done: '#6aa84f', measuring: '#45818e', grown: '#34a853', not_grown: '#ea4335',
};
export const isGrown = (v: TaskerVerdict | null) => v === 'achieved' || v === 'improved';

export function boardColumn(t: TaskerTask): BoardColumn {
  const s = t.status as string;
  if (s === 'result' || t.verdict) return isGrown(t.verdict) ? 'grown' : 'not_grown';
  if (s === 'awaiting_control') return 'in_progress';
  return s as BoardColumn;
}

/** Статусы, которые человек ставит сам (= смена статуса задачи в Битриксе). */
export type MoveTarget = 'new' | 'in_progress' | 'done';
export const MOVE_TARGETS: MoveTarget[] = ['new', 'in_progress', 'done'];

/** Куда задачу можно перевести вручную. Завершённую (в т.ч. «На замере») — обратно в работу,
 *  пока автозамер не поставил вердикт: ошибочное завершение откатывается. После итога — нет:
 *  плохой итог = новая задача (собрание 23.11). */
export function moveTargets(t: TaskerTask): MoveTarget[] {
  // canChangeStatus — с сервера: исполнитель или постановщик; менеджер видит задачу только для чтения.
  if (t.bitrixTaskId == null || t.verdict || t.canChangeStatus === false) return [];
  const col = boardColumn(t);
  if (col === 'new' || col === 'in_progress') return MOVE_TARGETS.filter(s => s !== col);
  if (col === 'done' || col === 'measuring') return ['in_progress'];
  return [];
}

export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

// ── Поля правок 23.11 — теперь в TaskerTask (миграция 279). Алиасы оставлены для ManagerTaskerBlock.
export { TASKER_KIND_LABELS as TASK_KIND_LABELS } from '../../types';
/** @deprecated поля kind/assignee/doneNote/doneAt есть в TaskerTask — читайте напрямую. */
export const taskExtras = (t: TaskerTask) => t;
