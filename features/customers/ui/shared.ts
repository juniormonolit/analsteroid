// Общие утилиты «Моих заказчиков» (вынесены при редизайне 01.08, чтобы карточка
// клиента (CustomerCard.tsx) и список (CustomersTab.tsx) не плодили копий и не
// образовывали циклический импорт).
import type { ActiveDealInfo, CallSignal, CustomerSection, ManagerHistoryItem, CustomerMark, CustomerBucket, NoCallReason, CustomerCategory, CustomerModifier } from '@/features/customers/engine/customers';
import type { Recommendation } from '@/features/customers/engine/crossSell';

export const REASON_LABELS: Record<NoCallReason, string> = {
  nothing_needed: 'Ничего не нужно',
  competitor: 'Ушёл к конкуренту',
  negative: 'Негатив',
  other: 'Прочее',
};

export interface ApiRow {
  clientKey: string; clientType: 'contact' | 'company'; clientId: number; name: string | null;
  dealsTotal: number; dealsSold: number; sumSold: number;
  lastSoldAt: string | null; lastSoldAmount: number | null; lastSoldGroups: string[];
  lastCallAt: string | null; lastActivityAt: string | null;
  activeCount: number; activeDeals: ActiveDealInfo[];
  refusedNoCall: boolean; cycleDays: number; cycleSource: 'own' | 'global';
  signals: CallSignal[]; urgency: number;
  section: CustomerSection; atRisk: boolean; sleeping: boolean;
  bucket: CustomerBucket; snoozedActive: boolean; mark: CustomerMark | null;
  managerHistory: ManagerHistoryItem[]; prevManagerNames: string[];
  recommend: Recommendation | null;
  // Категории клиентов (дополнение Серёги 01.08)
  category: CustomerCategory; modifiers: CustomerModifier[];
  dealsDelivered: number; sumDelivered: number; distinctGroups: number;
}

export const CATEGORY_LABELS: Record<CustomerCategory, string> = {
  key: 'Ключевой', large: 'Крупный', regular: 'Постоянный',
  once: 'Разовый', potential: 'Потенциальный', none: '—',
};
/** Цвета чипов категорий: ключевой — золото, крупный — фиолет, постоянный — зелёный. */
export const CATEGORY_STYLE: Record<CustomerCategory, { color: string; bg: string }> = {
  key:       { color: '#8a6d00', bg: 'color-mix(in srgb, #eab308 22%, transparent)' },
  large:     { color: '#6741d9', bg: 'color-mix(in srgb, #7950f2 14%, transparent)' },
  regular:   { color: 'var(--color-positive, #2f9e44)', bg: 'color-mix(in srgb, var(--color-positive, #2f9e44) 12%, transparent)' },
  once:      { color: 'var(--color-text-muted)', bg: 'var(--color-bg-hover)' },
  potential: { color: 'var(--color-accent)', bg: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' },
  none:      { color: 'var(--color-text-muted)', bg: 'transparent' },
};
export const MODIFIER_LABELS: Record<CustomerModifier, { icon: string; label: string; hint: string }> = {
  complex:  { icon: '🧩', label: 'комплексный', hint: 'Покупал 3+ разных товарных групп (по отгрузкам, шкала by_max — как «комплексные» в «Повторных»)' },
  frequent: { icon: '⚡', label: 'частый', hint: 'Собственный цикл повторки заметно чаще медианы базы (16 дн.)' },
  fading:   { icon: '📉', label: 'затухающий', hint: 'Частота падает: последний интервал (или текущая тишина) больше 2× его среднего интервала покупок' },
};

export function fmtMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10).split('-').reverse().join('.');
}
export function daysAgo(iso: string | null): string {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return 'сегодня';
  if (d === 1) return 'вчера';
  return `${d} дн. назад`;
}
export function clientBitrixUrl(r: Pick<ApiRow, 'clientType' | 'clientId'>): string {
  return r.clientType === 'contact'
    ? `https://td.monolit-crm.ru/crm/contact/details/${r.clientId}/`
    : `https://td.monolit-crm.ru/crm/company/details/${r.clientId}/`;
}
export function dealBitrixUrl(dealId: number): string {
  return `https://td.monolit-crm.ru/crm/deal/details/${dealId}/`;
}
export function clientDisplayName(r: Pick<ApiRow, 'name' | 'clientType' | 'clientId'>): string {
  return r.name ?? (r.clientType === 'contact' ? `Контакт #${r.clientId}` : `Компания #${r.clientId}`);
}
