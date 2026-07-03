'use client';
import { useQuery } from '@tanstack/react-query';
import { X, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

interface Product {
  name: string; type?: string; price: number; quantity: number; sum: number;
  product_id?: number; head_group_id?: number; head_group_name?: string;
}

interface DealFull {
  deal_id: number; deal_name: string; amount: string | number; is_reserved: boolean | null;
  created_at: string | null; updated_at: string | null; reserved_at: string | null;
  confirmed_at: string | null; sold_at: string | null; delivered_at: string | null;
  lost_at: string | null; expected_close_date: string | null;
  manager_id: string | null; lead_id: number | null; contact_id: number | null; company_id: number | null;
  source_id: string | null; products: Product[] | null;
  product_group_id: number | null; product_group_name: string | null;
  head_group_id: number | null; head_group_name: string | null;
  stage_name: string | null; funnel_name: string | null; funnel_is_repeat: boolean | null;
}
interface ManagerInfo { name: string; login: string | null; branch: string; department: string | null }
interface SourceInfo {
  name: string; category: string; contact_type: string | null; branch: string | null;
  platform: string | null; brand: string | null; ad_channel: string | null; channel_group: string | null;
}

function fmtMoney(v: number | string | null | undefined) {
  const n = Number(v);
  if (v === null || v === undefined || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}
function fmtDate(s: string | null | undefined, withYear = true) {
  if (!s) return null;
  return format(new Date(s), withYear ? 'd MMM yyyy' : 'd MMM', { locale: ru });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  if (value === null || value === undefined || value === '—') return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-xs text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span className={`text-xs text-right text-[var(--color-text)] ${strong ? 'font-semibold' : ''}`}>{value}</span>
    </div>
  );
}

// Этапы жизни сделки в хронологии — заполненные подсвечены
const STAGES: { key: keyof DealFull; label: string }[] = [
  { key: 'created_at',   label: 'Создана' },
  { key: 'reserved_at',  label: 'Бронь' },
  { key: 'confirmed_at', label: 'Подтверждена' },
  { key: 'sold_at',      label: 'Продана' },
  { key: 'delivered_at', label: 'Отгружена' },
  { key: 'lost_at',      label: 'Проиграна' },
];

export function DealCard({ dealId, onClose }: { dealId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['deal-card', dealId],
    queryFn: () => fetch(`/api/reports/deal?id=${dealId}`).then(r => r.json()) as Promise<{ deal: DealFull; manager: ManagerInfo | null; source: SourceInfo | null }>,
    staleTime: 60_000,
  });
  const deal = data?.deal;
  const products = deal?.products ?? [];
  const productsTotal = products.reduce((s, p) => s + (Number(p.sum) || 0), 0);

  return (
    <div className="fixed inset-y-0 right-0 z-[70] w-[440px] bg-[var(--color-bg-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-[var(--color-border)] shrink-0">
        <div className="min-w-0">
          <div className="text-xs text-[var(--color-text-muted)]">Сделка #{dealId}</div>
          {deal && (
            <a
              href={`https://td.monolit-crm.ru/crm/deal/details/${deal.deal_id}/`}
              target="_blank" rel="noopener noreferrer"
              className="font-semibold text-sm text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline inline-flex items-start gap-1 mt-0.5"
            >
              <span>{deal.deal_name || 'Без названия'}</span>
              <ExternalLink size={12} className="shrink-0 mt-0.5 opacity-60" />
            </a>
          )}
          {deal && <div className="text-lg font-bold tabular-nums text-[var(--color-text)] mt-1">{fmtMoney(deal.amount)}</div>}
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors shrink-0"><X size={16} /></button>
      </div>

      {isLoading && (
        <div className="p-5 space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
      )}

      {deal && (
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* Статус */}
          <Section title="Статус">
            <Row label="Стадия" value={deal.stage_name ?? '—'} strong />
            <Row label="Воронка" value={deal.funnel_name ? `${deal.funnel_name}${deal.funnel_is_repeat ? ' (повторная)' : ''}` : null} />
          </Section>

          {/* Хронология */}
          <Section title="Хронология">
            <div className="flex flex-col gap-1">
              {STAGES.map(s => {
                const v = deal[s.key] as string | null;
                const isLost = s.key === 'lost_at';
                if (!v) return null;
                return (
                  <div key={s.key} className="flex items-center gap-2.5">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${isLost ? 'bg-[var(--color-negative,#e03131)]' : 'bg-[var(--color-accent)]'}`} />
                    <span className={`text-xs flex-1 ${isLost ? 'text-[var(--color-negative,#e03131)]' : 'text-[var(--color-text)]'}`}>{s.label}</span>
                    <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtDate(v)}</span>
                  </div>
                );
              })}
              {deal.expected_close_date && !deal.sold_at && !deal.lost_at && (
                <div className="flex items-center gap-2.5 opacity-60">
                  <span className="w-2 h-2 rounded-full border border-[var(--color-text-muted)] shrink-0" />
                  <span className="text-xs flex-1 text-[var(--color-text-muted)]">Ожид. закрытие</span>
                  <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtDate(deal.expected_close_date)}</span>
                </div>
              )}
            </div>
          </Section>

          {/* Товарные группы */}
          <Section title="Товарные группы">
            <Row label="Категория КЦ" value={deal.product_group_name ?? 'Без группы'} />
            <Row label="По наибольшему" value={deal.head_group_name ?? 'Без группы'} />
          </Section>

          {/* Товары */}
          <Section title={`Товары · ${products.length}`}>
            {products.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)]">Нет позиций</div>
            ) : (
              <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
                {products.map((p, i) => (
                  <div key={i} className={`px-3 py-2 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                    <div className="text-xs text-[var(--color-text)] leading-snug" title={p.name}>{p.name}</div>
                    <div className="flex items-baseline justify-between mt-1">
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {p.quantity} × {fmtMoney(p.price)}
                        {p.head_group_name ? ` · ${p.head_group_name}` : ''}
                      </span>
                      <span className="text-xs font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(p.sum)}</span>
                    </div>
                  </div>
                ))}
                <div className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] flex items-baseline justify-between">
                  <span className="text-xs text-[var(--color-text-muted)]">Итого по товарам</span>
                  <span className="text-xs font-semibold tabular-nums text-[var(--color-text)]">{fmtMoney(productsTotal)}</span>
                </div>
              </div>
            )}
          </Section>

          {/* Источник */}
          <Section title="Источник">
            {data?.source ? (
              <>
                <Row label="Название" value={data.source.name} strong />
                <Row label="Тип контакта" value={data.source.contact_type} />
                <Row label="Канал" value={data.source.channel_group === data.source.ad_channel ? data.source.ad_channel : [data.source.channel_group, data.source.ad_channel].filter(Boolean).join(' · ')} />
                <Row label="Бренд" value={data.source.brand} />
                <Row label="Витрина" value={data.source.platform} />
              </>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">{deal.source_id ? `Неизвестный источник (${deal.source_id})` : 'Без источника'}</div>
            )}
          </Section>

          {/* Менеджер */}
          <Section title="Менеджер">
            {data?.manager ? (
              <>
                <Row label="Имя" value={`${data.manager.name}${data.manager.login ? ` ${data.manager.login}` : ''}`} strong />
                <Row label="Отдел" value={data.manager.department} />
                <Row label="Филиал" value={data.manager.branch} />
              </>
            ) : (
              <div className="text-xs text-[var(--color-text-muted)]">{deal.manager_id ? `#${deal.manager_id} (вне активной оргструктуры)` : 'Не назначен'}</div>
            )}
          </Section>

          {/* Идентификаторы */}
          <Section title="Служебное">
            <Row label="Лид" value={deal.lead_id ? `#${deal.lead_id}` : null} />
            <Row label="Контакт" value={deal.contact_id ? `#${deal.contact_id}` : null} />
            <Row label="Компания" value={deal.company_id ? `#${deal.company_id}` : null} />
            <Row label="Обновлена" value={fmtDate(deal.updated_at)} />
          </Section>
        </div>
      )}
    </div>
  );
}
