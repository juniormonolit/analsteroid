// Форматтеры экрана «Канбана больших чеков» (общие для доски, «Сегодня» и карточки).
import type { BigTaskCard, BigTaskState } from '../engine/types';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const money = (n: number) => `${rub.format(n)} ₽`;
/** Компактно для шапок колонок: 1,2 млн / 850 тыс. */
export const moneyShort = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} тыс. ₽`;
  return money(n);
};

/** 1 звонок / 2 звонка / 5 звонков. */
export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export const cardAmount = (c: BigTaskCard): number | null => c.deal?.amount || c.taskAmount || null;

/** Короткое имя для карточки: «Фамилия И.». Битрикс отдаёт «Имя Фамилия» (две части) — меняем местами;
 *  три части — это «Фамилия Имя Отчество» из БД, фамилия уже первая. */
export function shortName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? name;
  const [last, first] = parts.length === 2 ? [parts[1], parts[0]] : [parts[0], parts[1]];
  return `${last} ${first[0]}.`;
}

/** «17.11» — дата без года (МСК). */
export const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' }) : '—');

export const STATE_META: Record<BigTaskState, { label: string; cls: string }> = {
  unread: { label: 'не просмотрена', cls: 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]' },
  pending: { label: 'ждёт выполнения', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
  in_progress: { label: 'в работе', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  control: { label: 'ждёт контроля', cls: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' },
  done: { label: 'завершена', cls: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]' },
  deferred: { label: 'отложена', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
};

export const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
