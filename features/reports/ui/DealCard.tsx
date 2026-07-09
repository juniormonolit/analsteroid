'use client';
import { useQuery } from '@tanstack/react-query';
import { X, ExternalLink } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { branchLabel } from '@/lib/org/branchLabel';

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
      <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">{title}</div>
      {children}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  if (value === null || value === undefined || value === '—') return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-sm text-[var(--color-text-muted)] shrink-0">{label}</span>
      <span className={`text-sm text-right text-[var(--color-text)] ${strong ? 'font-semibold' : ''}`}>{value}</span>
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
  const isLostDeal = !!deal?.lost_at;
  const { closing, requestClose } = useSlideClose(onClose);

  // Хронология — только заполненные этапы (+ ожидаемое закрытие, если сделка ещё
  // открыта), в порядке жизненного цикла. Собираем один раз здесь, чтобы вертикальная
  // соединительная линия между точками (макет deal-card-redesign-mock.html) знала,
  // какой пункт последний, не считая null-этапы.
  const timelineItems: { key: string; label: string; date: string; isLost?: boolean; future?: boolean }[] = [];
  if (deal) {
    for (const s of STAGES) {
      const v = deal[s.key] as string | null;
      if (!v) continue;
      timelineItems.push({ key: s.key, label: s.label, date: fmtDate(v)!, isLost: s.key === 'lost_at' });
    }
    if (deal.expected_close_date && !deal.sold_at && !deal.lost_at) {
      timelineItems.push({ key: 'expected_close_date', label: 'Ожид. закрытие', date: fmtDate(deal.expected_close_date)!, future: true });
    }
  }

  return (
    <>
      {/* Затемнение: клик мимо карточки закрывает её. z-[65] — выше z-50 дрилл-дауна
          (карточка может открываться поверх него), ниже z-[70] самой карточки. */}
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[65]" />
      <div className={`fixed inset-y-0 right-0 z-[70] w-full sm:w-[48vw] sm:min-w-[760px] sm:max-w-[1080px] bg-[var(--color-bg-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        {/* Header — на всю ширину панели */}
        <div className="shrink-0 border-b border-[var(--color-border)]">
          <div className="flex items-start justify-between gap-3 px-6 sm:px-9 pt-5 sm:pt-6 pb-4 sm:pb-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span>Сделка #{dealId}</span>
                {deal?.funnel_name && (
                  <span className="px-1.5 py-0.5 rounded bg-[var(--color-bg)] border border-[var(--color-border)]">
                    {deal.funnel_name}{deal.funnel_is_repeat ? ' · повторная' : ''}
                  </span>
                )}
              </div>
              {deal && (
                <a
                  href={`https://td.monolit-crm.ru/crm/deal/details/${deal.deal_id}/`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-semibold text-base leading-snug text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline inline-flex items-start gap-1.5 mt-1.5"
                >
                  <span>{deal.deal_name || 'Без названия'}</span>
                  <ExternalLink size={14} className="shrink-0 mt-1 opacity-60" />
                </a>
              )}
              {deal && (
                <div className="flex items-baseline gap-3 mt-2">
                  <span className="text-2xl font-bold tabular-nums text-[var(--color-text)]">{fmtMoney(deal.amount)}</span>
                  {deal.stage_name && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${isLostDeal
                      ? 'bg-[color-mix(in_srgb,var(--color-negative,#e03131)_12%,white)] text-[var(--color-negative,#e03131)]'
                      : 'bg-[color-mix(in_srgb,var(--color-accent)_12%,white)] text-[var(--color-accent)]'}`}>
                      {deal.stage_name}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button onClick={requestClose} className="sm:hidden p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors shrink-0"><X size={18} /></button>
          </div>
        </div>

        {isLoading && (
          <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
        )}

        {deal && (
          <div className="flex-1 overflow-y-auto px-6 sm:px-9 py-5 sm:py-7">
            {/* 2 колонки (макет deal-card-redesign-mock.html): слева — Товары (главное) +
                Хронология; справа — компактные карточки ключ→значение. На мобиле —
                схлопывается в одну колонку (grid-cols-1 → sm:grid-cols-[1.35fr_1fr]). */}
            <div className="grid grid-cols-1 sm:grid-cols-[1.35fr_1fr] gap-x-9 gap-y-7">
              {/* Левая колонка */}
              <div className="flex flex-col gap-7 min-w-0">
                <Section title={`Товары · ${products.length}`}>
                  {products.length === 0 ? (
                    <div className="text-sm text-[var(--color-text-muted)]">Нет позиций</div>
                  ) : (
                    <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
                      {products.map((p, i) => (
                        <div key={i} className={`px-4 py-2.5 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                          <div className="text-sm text-[var(--color-text)] leading-snug" title={p.name}>{p.name}</div>
                          <div className="flex items-baseline justify-between mt-1">
                            <span className="text-xs text-[var(--color-text-muted)]">
                              {p.quantity} × {fmtMoney(p.price)}
                              {p.head_group_name ? ` · ${p.head_group_name}` : ''}
                            </span>
                            <span className="text-sm font-medium tabular-nums text-[var(--color-text)]">{fmtMoney(p.sum)}</span>
                          </div>
                        </div>
                      ))}
                      <div className="px-4 py-2.5 border-t border-[var(--color-border)] bg-[var(--color-bg)] flex items-baseline justify-between">
                        <span className="text-sm text-[var(--color-text-muted)]">Итого по товарам</span>
                        <span className="text-sm font-bold tabular-nums text-[var(--color-accent)]">{fmtMoney(productsTotal)}</span>
                      </div>
                    </div>
                  )}
                </Section>

                <Section title="Хронология">
                  <div className="border border-[var(--color-border)] rounded-xl p-4">
                    <div className="flex flex-col">
                      {timelineItems.map((it, i) => (
                        <div key={it.key} className="relative flex items-center gap-3 py-1.5">
                          {i < timelineItems.length - 1 && (
                            <span className="absolute left-[4px] top-[18px] bottom-[-6px] w-px bg-[var(--color-border)]" />
                          )}
                          <span className={`relative z-[1] w-2.5 h-2.5 rounded-full shrink-0 ${
                            it.future ? 'bg-transparent border-2 border-[var(--color-text-muted)]' : it.isLost ? 'bg-[var(--color-negative,#e03131)]' : 'bg-[var(--color-accent)]'
                          }`} />
                          <span className={`text-sm flex-1 ${it.future ? 'text-[var(--color-text-muted)]' : it.isLost ? 'text-[var(--color-negative,#e03131)] font-medium' : 'text-[var(--color-text)]'}`}>
                            {it.label}
                          </span>
                          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{it.date}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Section>
              </div>

              {/* Правая колонка */}
              <div className="flex flex-col gap-7 min-w-0">
                <Section title="Менеджер">
                  {data?.manager ? (
                    <>
                      <Row label="Имя" value={`${data.manager.name}${data.manager.login ? ` ${data.manager.login}` : ''}`} strong />
                      <Row label="Отдел" value={data.manager.department} />
                      <Row label="Филиал" value={branchLabel(data.manager.branch)} />
                    </>
                  ) : (
                    <div className="text-sm text-[var(--color-text-muted)]">{deal.manager_id ? `#${deal.manager_id} (вне активной оргструктуры)` : 'Не назначен'}</div>
                  )}
                </Section>

                <Section title="Товарные группы">
                  <Row label="Категория КЦ" value={deal.product_group_name ?? 'Без группы'} />
                  <Row label="По наибольшему" value={deal.head_group_name ?? 'Без группы'} />
                </Section>

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
                    <div className="text-sm text-[var(--color-text-muted)]">{deal.source_id ? `Неизвестный источник (${deal.source_id})` : 'Без источника'}</div>
                  )}
                </Section>

                <Section title="Служебное">
                  <Row label="Лид" value={deal.lead_id ? `#${deal.lead_id}` : null} />
                  <Row label="Контакт" value={deal.contact_id ? `#${deal.contact_id}` : null} />
                  <Row label="Компания" value={deal.company_id ? `#${deal.company_id}` : null} />
                  <Row label="Обновлена" value={fmtDate(deal.updated_at)} />
                </Section>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
