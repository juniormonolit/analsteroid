// Общие утилиты «Моих заказчиков» (вынесены при редизайне 01.08, чтобы карточка
// клиента (CustomerCard.tsx) и список (CustomersTab.tsx) не плодили копий и не
// образовывали циклический импорт).
import type { ActiveDealInfo, CallSignal, CustomerSection, ManagerHistoryItem, CustomerMark, CustomerBucket, NoCallReason } from '@/features/customers/engine/customers';
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
}

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
