'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ExternalLink, ArrowDownLeft, ArrowUpRight, Mic } from 'lucide-react';
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

// Таб «Звонки» (задача КОЛСТАТ, п.B, 10.07) — список звонков сделки, va.calls.
interface DealCall {
  id: string;
  calledAt: string;
  direction: 'inbound' | 'outbound';
  result: 'completed' | 'missed' | 'voicemail' | 'operator_error';
  durationSeconds: number | null;
  managerId: string | null;
  managerName: string | null;
  hasRecording: boolean;
}

const CALL_RESULT_LABEL: Record<DealCall['result'], string> = {
  completed: 'Разговор',
  missed: 'Недозвон',
  voicemail: 'Автоответчик',
  operator_error: 'Ошибка оператора',
};
// Бейдж результата — зелёный (успех) / красный (недозвон, отказ) / серый (автоответчик,
// нейтрально — звонок формально состоялся, просто без живого собеседника).
const CALL_RESULT_CLASS: Record<DealCall['result'], string> = {
  completed: 'bg-[color-mix(in_srgb,var(--color-positive,#2f9e44)_12%,white)] text-[var(--color-positive,#2f9e44)]',
  missed: 'bg-[color-mix(in_srgb,var(--color-negative,#e03131)_12%,white)] text-[var(--color-negative,#e03131)]',
  operator_error: 'bg-[color-mix(in_srgb,var(--color-negative,#e03131)_12%,white)] text-[var(--color-negative,#e03131)]',
  voicemail: 'bg-[var(--color-bg)] text-[var(--color-text-muted)]',
};

function fmtDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDateTimeMsk(iso: string): string {
  // called_at приходит как timestamptz (UTC) из PG-драйвера в виде Date-строки;
  // toLocaleString с явной МСК-таймзоной — тот же приём, что и остальные
  // МСК-отображения в приложении (владелец всегда смотрит время в МСК).
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
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

// Табы карточки (правка собрания 09.07/2, п.1) — «как в Битриксе»: раньше вся
// карточка была одной вертикальной простынёй, при большом числе товарных позиций
// превращавшейся в бесконечный скролл. Теперь «Основное» (хронология + товарные
// группы + менеджер + источник + служебное, 2 колонки без вертикального скролла
// панели), «Товары» (список позиций + итого) и «Звонки» (задача КОЛСТАТ, 10.07 —
// история звонков сделки, va.calls, грузится лениво только при открытии таба).
type DealCardTab = 'main' | 'products' | 'calls';

export function DealCard({ dealId, onClose }: { dealId: number; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['deal-card', dealId],
    queryFn: () => fetch(`/api/reports/deal?id=${dealId}`).then(r => r.json()) as Promise<{ deal: DealFull; manager: ManagerInfo | null; source: SourceInfo | null; callsCount: number }>,
    staleTime: 60_000,
  });
  const deal = data?.deal;
  const products = deal?.products ?? [];
  const productsTotal = products.reduce((s, p) => s + (Number(p.sum) || 0), 0);
  const isLostDeal = !!deal?.lost_at;
  const { closing, requestClose } = useSlideClose(onClose);
  const [tab, setTab] = useState<DealCardTab>('main');

  // Список звонков — лениво, только когда таб «Звонки» реально открыт (enabled),
  // чтобы не бить va.calls на каждое открытие карточки (счётчик N в лейбле таба
  // приходит дёшево вместе с основным запросом, см. /api/reports/deal callsCount).
  const { data: callsData, isLoading: callsLoading } = useQuery({
    queryKey: ['deal-card-calls', dealId],
    queryFn: () => fetch(`/api/reports/deal/calls?id=${dealId}`).then(r => r.json()) as Promise<{ calls: DealCall[] }>,
    enabled: tab === 'calls',
    staleTime: 60_000,
  });
  const calls = callsData?.calls ?? [];
  const callsCount = data?.callsCount ?? 0;

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
      {/* Ширина ~70vw (п.1 правок 09.07/2, было 48vw) — при большом числе товарных
          позиций панели банально не хватало места по горизонтали для двух колонок
          «Основного» без сжатия текста. */}
      <div className={`fixed inset-y-0 right-0 z-[70] w-full sm:w-[70vw] sm:min-w-[860px] sm:max-w-[1400px] bg-[var(--color-bg-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
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
          <>
            {/* Табы «Основное»/«Товары»/«Звонки» (п.1 правок 09.07/2, «как в Битриксе» +
                КОЛСТАТ п.B 10.07): шапка выше остаётся общей для всех табов,
                переключатель — сразу под ней. Стиль пилюль — вариант C, тот же
                паттерн, что и переключатель режима подсветки в HighlightEditor
                (единый визуальный язык табов приложения). max-w-md (было max-w-xs) —
                третья пилюля «Звонки N» иначе не помещалась на 375px без переноса. */}
            <div className="shrink-0 px-6 sm:px-9 pt-4 pb-1 border-b border-[var(--color-border)]">
              <div className="flex bg-[var(--color-bg)] rounded-xl p-1 gap-1 max-w-md">
                {([
                  { v: 'main', label: 'Основное' },
                  { v: 'products', label: `Товары${products.length ? ` · ${products.length}` : ''}` },
                  { v: 'calls', label: `Звонки${callsCount ? ` · ${callsCount}` : ''}` },
                ] as { v: DealCardTab; label: string }[]).map(o => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setTab(o.v)}
                    className={`flex-1 text-center px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      tab === o.v ? 'bg-[var(--color-accent)] text-white shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {tab === 'main' && (
              // «Основное»: хронология + товарные группы слева, менеджер + источник +
              // служебное справа — 2 колонки специально скомпонованы так, чтобы обычная
              // сделка помещалась БЕЗ вертикального скролла панели (скролл — только у
              // «Товаров», см. ниже). overflow-y-auto оставлен предохранителем на случай
              // очень маленького окна/длинных значений — не основной сценарий.
              <div className="flex-1 overflow-y-auto px-6 sm:px-9 py-5 sm:py-7">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-9 gap-y-7">
                  <div className="flex flex-col gap-7 min-w-0">
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

                    <Section title="Товарные группы">
                      <Row label="Категория КЦ" value={deal.product_group_name ?? 'Без группы'} />
                      <Row label="По наибольшему" value={deal.head_group_name ?? 'Без группы'} />
                    </Section>
                  </div>

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

            {tab === 'products' && (
              // «Товары»: единственный таб, где вертикальный скролл ожидаем и допустим
              // (список позиций может быть длинным) — итог по товарам прибит снизу
              // контейнера секции, как и раньше.
              <div className="flex-1 overflow-y-auto px-6 sm:px-9 py-5 sm:py-7">
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
              </div>
            )}

            {tab === 'calls' && (
              // «Звонки» (задача КОЛСТАТ, п.B, 10.07): плоский список, новые сверху
              // (called_at DESC) — в отличие от «Хронологии» это НЕ связанные точки
              // жизненного цикла сделки, а независимые события одного типа, для
              // которых «последнее сверху» интуитивнее «по порядку с начала».
              <div className="flex-1 overflow-y-auto px-6 sm:px-9 py-5 sm:py-7">
                <Section title={`Звонки · ${calls.length}`}>
                  {callsLoading ? (
                    <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-14 bg-[var(--color-border)] rounded-xl animate-pulse" />)}</div>
                  ) : calls.length === 0 ? (
                    <div className="text-sm text-[var(--color-text-muted)]">Звонков по сделке нет</div>
                  ) : (
                    <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
                      {calls.map((c, i) => (
                        <div key={c.id} className={`px-4 py-2.5 flex items-center gap-3 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
                          {c.direction === 'inbound' ? (
                            <ArrowDownLeft size={16} className="shrink-0 text-[var(--color-accent)]" aria-label="Входящий" />
                          ) : (
                            <ArrowUpRight size={16} className="shrink-0 text-[var(--color-text-muted)]" aria-label="Исходящий" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="text-sm text-[var(--color-text)] tabular-nums">{fmtDateTimeMsk(c.calledAt)}</span>
                              <span className="text-sm font-medium tabular-nums text-[var(--color-text)] shrink-0">{fmtDuration(c.durationSeconds)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-2 mt-1">
                              <span className="text-xs text-[var(--color-text-muted)] truncate">{c.managerName ?? '—'}</span>
                              <span className="flex items-center gap-1.5 shrink-0">
                                {c.hasRecording && (
                                  <Mic size={12} className="text-[var(--color-text-muted)]" aria-label="Есть запись разговора" />
                                )}
                                <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ${CALL_RESULT_CLASS[c.result]}`}>
                                  {CALL_RESULT_LABEL[c.result]}
                                </span>
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
