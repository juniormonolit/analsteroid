// Форматирование канбана запросов логистам (клиент).
import type { RequestCard, RequestStatus, RequestType, SlaInfo } from '../engine/requests/contract';

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

export const money = (v: number | null | undefined) => (v == null ? '—' : `${rub.format(v)} ₽`);
export const qty = (v: number | null | undefined) => (v == null ? '—' : num.format(v));

/** 1 250 000 → «1,25 млн», 85 000 → «85 тыс.» — для плиток и шапок колонок. */
export function moneyShort(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} млн ₽`;
  if (v >= 1e3) return `${Math.round(v / 1e3).toLocaleString('ru-RU')} тыс. ₽`;
  return `${rub.format(v)} ₽`;
}

const MSK = { timeZone: 'Europe/Moscow' } as const;
export const fmtDT = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { ...MSK, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { ...MSK, hour: '2-digit', minute: '2-digit' });
export const fmtDate = (ymd: string | null | undefined) => {
  if (!ymd) return '—';
  const [y, m, d] = ymd.slice(0, 10).split('-');
  return `${d}.${m}.${y.slice(2)}`;
};

/** Рабочие часы: 0.4 → «24 мин», 2.5 → «2,5 ч», 30 → «30 ч». */
export function hours(h: number | null | undefined): string {
  if (h == null) return '—';
  const a = Math.abs(h);
  if (a < 1) return `${Math.round(a * 60)} мин`;
  return `${a.toLocaleString('ru-RU', { maximumFractionDigits: a < 10 ? 1 : 0 })} ч`;
}

export function slaText(s: SlaInfo): string | null {
  if (s.leftHours == null) return null;
  return s.leftHours < 0 ? `просрочен на ${hours(s.leftHours)}` : `осталось ${hours(s.leftHours)}`;
}

export const SLA_CLS: Record<SlaInfo['state'], string> = {
  none: 'text-[var(--color-text-muted)]',
  ok: 'text-[var(--color-text-secondary)]',
  hot: 'font-semibold text-[var(--color-warning)]',
  overdue: 'font-semibold text-[var(--color-negative)]',
};

export const TYPE_META: Record<RequestType, { short: string; cls: string }> = {
  supply: { short: 'Снабженцу', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  cheaper: { short: 'Дешевле', cls: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]' },
};

export const STATUS_CLS: Record<RequestStatus, string> = {
  draft: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]',
  new: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  in_work: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
  answered: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]',
  accepted: 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]',
  cancelled: 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]',
};

/** Короткое имя «Иванов Пётр» → «Иванов П.». */
export function shortName(name: string | null | undefined): string {
  if (!name) return '—';
  const [a, b] = name.trim().split(/\s+/);
  return b ? `${a} ${b[0]}.` : a;
}

export const cardTitle = (c: Pick<RequestCard, 'client' | 'deal' | 'id'>) =>
  c.client.name || c.deal?.title || `Запрос № ${c.id}`;
