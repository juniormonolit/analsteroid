'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ArrowLeft, Copy, Check, MessageCircle } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { DateRange } from '@/lib/period';
import { recomputeComparison } from '@/lib/period';
import type { Metric, ComparisonDisplay, DealScope, ClientType, ProductGroupMode, AccountType, TotalsMetricValue, BorderMode, Grouping } from '@/lib/metrics/types';
import type { MetricHighlightConfig } from '@/lib/saved-reports/types';
import { DEAL_FIELDS, DEFAULT_DEAL_FIELDS } from '@/lib/reports/dealFields';
import { ENTITY_COLOR } from '@/lib/metrics/entity-colors';
import { dealsCountLabel } from '@/lib/format/pluralize';
import { DRILLDOWN_DIMENSIONS, dimensionLabel, UNDEFINED_LABEL, NO_SOURCE_LABEL, type SourceDimension, type DrilldownDimension } from '@/lib/marketing/dimensions';
import { branchLabel } from '@/lib/org/branchLabel';
import { computeCalculated } from '@/features/reports/engine/calculated';
import { ReportTable, type RowDeltas } from './ReportTable';
import { DealCard } from './DealCard';
import { DealChatPanel } from './DealChatPanel';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SLIDE_BACKDROP_BG } from '@/components/ui/SlideBackdrop';
import { PeriodRangeControls, DepartmentPicker, GroupingSelector } from './FilterBar';
import { FiltersMenu } from './FiltersMenu';

export interface Deal {
  deal_id: number;
  deal_name: string;
  amount: string;
  created_at: string;
  sold_at: string | null;
  delivered_at: string | null;
  lost_at: string | null;
  expected_close_date: string | null;
  source_id: string | null;
  source_name: string | null;
  reserved_at: string | null;
  confirmed_at: string | null;
  manager_id: string;
  manager_name: string;
  stage_name: string | null;
  stage_event_type: string | null;
  product_group_display: string;
  funnel_name: string | null;
  // Задача #2385: группировка списка сделок drill-down «По отделу/По филиалу» — те
  // же поля, что и в byManagers.ts (ReportRow.teamId/teamName/branchName), только
  // резолвятся сервером по менеджеру КАЖДОЙ сделки (см. app/api/reports/deals/route.ts).
  team_id: string | null;
  team_name: string | null;
  branch_name: string | null;
}

export interface DrilldownTarget {
  id: string;
  name: string;
  metricId?: string;
  metricName?: string;
  // Групповые цели: подытог отдела/филиала или строка «Итого» — открывают
  // плоский список сделок всего среза (мини-отчёт по одной сущности не имеет смысла)
  kind?: 'team' | 'branch' | 'total';
}

// Суб-дрилл из мини-отчёта: клик по цифре «строка × метрика» → сделки,
// отфильтрованные по ОБОИМ измерениям и метрике.
interface SubDrill {
  rowName: string;
  metricId: string;
  metricName?: string;
  managerId?: string;
  productGroup?: string;
  sourceDim?: SourceDimension;
  sourceVal?: string;
}

interface Props {
  target: DrilldownTarget;
  dimensionType: 'manager' | 'product-group' | 'source';
  period: DateRange;
  comparison?: DateRange;
  dealScope: DealScope;
  clientType?: ClientType;
  productGroupMode: ProductGroupMode;
  metricIds: string[];
  departmentIds?: string[];
  accountType?: AccountType;
  dealFields?: string[];
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc';
  // Report-level «Группировка в drilldown» setting (true = grouped mini-report, false = flat deals)
  grouped?: boolean;
  onGroupedChange?: (v: boolean) => void;
  // Marketing (by-sources): main dimension of the report + second dimension for the mini-report
  sourceDimension?: SourceDimension;
  drilldownDimension?: DrilldownDimension;
  onDrilldownDimensionChange?: (d: DrilldownDimension) => void;
  // Extra header controls (Фильтры / Вид buttons mirroring the main toolbar)
  toolbarExtras?: React.ReactNode;
  // Клик по строке сделки → карточка (проставляется обёрткой DrilldownDrawer)
  onDealOpen?: (id: number) => void;
  onClose: () => void;
  // Настройки отображения метрик — те же, что в основном отчёте (тепловая карта,
  // подсветки, режим сравнения и т.д.); мини-отчёт рендерится тем же ReportTable.
  comparisonDisplay?: ComparisonDisplay;
  metricDisplayModes?: Record<string, ComparisonDisplay>;
  comparisonThreshold?: number;
  highlights?: Record<string, MetricHighlightConfig>;
  metricDecimalOverrides?: Record<string, number>;
  metricThresholdOverrides?: Record<string, number>;
  accentedMetricIds?: string[];
  barMetricIds?: string[];
  heatmapMetricIds?: string[];
  heatmapInvertedIds?: string[];
  colorizeMetrics?: boolean;
  // «Зебра» (правка владельца 09.07): та же настройка «Вид», что и в основном отчёте
  // (общее состояние SalesReportPage) — мини-отчёт рендерится тем же ReportTable.
  zebra?: boolean;
  // «Границы» (п.4 правок 09.07) — та же общая настройка «Вид», что и в основном отчёте.
  borderMode?: BorderMode;
  numberAlign?: 'left' | 'center' | 'right';
  pinnedMetricIds?: string[];
  columnGroups?: { name: string; metricIds: string[] }[];
  density?: 'compact' | 'normal' | 'relaxed';
  // «Масштаб таблиц» ЛК (бриф 09.07, п.3) — глобальный per-user множитель, применяется
  // и к мини-отчёту (ReportTable), и к списку сделок (DealsTable) внутри дрилл-дауна.
  tableScale?: number;
}

function fmt(s: string | null) {
  if (!s) return '—';
  return format(new Date(s), 'd MMM', { locale: ru });
}
function fmtMoney(v: number | string | null) {
  const n = Number(v);
  if (!v || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}

type DealSort = { key: string; dir: 'asc' | 'desc' } | null;

// ── Стадия сделки (полоска слева в списке + дефолтная сортировка, правка владельца) ──
// Тип стадии, используемый И для цвета полоски, И для группировки при дефолтной
// сортировке — источник истины один (см. dealStage ниже).
type DealStage = 'shipment' | 'sale' | 'reservationConfirmed' | 'reservation' | 'inProgress' | 'refusal';

// Определение ТЕКУЩЕЙ стадии сделки (задача #2367, фикс «шрамов»: раньше цвет
// красился по факту НАЛИЧИЯ lost_at — навсегда, даже если сделку потом вернули
// в работу и продали/отгрузили; 14–25% реально проданных сделок красились
// красным). Источник истины теперь — event_type ТЕКУЩЕЙ стадии сделки
// (sa.stages.event_type через d.stage_id, JOIN уже был в SELECT): lost —
// красный, ТОЛЬКО если сделка СЕЙЧАС на стадии с event_type='lost'. Проигрыш
// по-прежнему терминален для стадии 'lost' (проверяется первым), но перестал
// быть терминальным для цвета — если стадию откатили дальше, lost_at в прошлом
// уже не красит строку.
// Для стадий 'created'/'called' (ещё не дошла ни до брони, ни до отказа) —
// нейтрально, КРОМЕ случая «продана/отгружена, потом стадию отвели обратно в
// работу» (sold_at/delivered_at есть, event_type сейчас 'created'/'called'):
// в этом случае красим по последней ДОСТИГНУТОЙ вехе (milestone-даты), а не в
// нейтральный серый — иначе теряется сигнал «уже была продажа», это менее
// инвазивно, чем городить отдельное состояние «шрам», и симметрично тому, как
// стадия трактуется везде в приложении (см. STAGE_SNAPSHOT_GROUPS).
function dealStage(deal: Deal): DealStage {
  switch (deal.stage_event_type) {
    case 'lost': return 'refusal';
    case 'shipped': return 'shipment';
    case 'sold': return 'sale';
    case 'confirmed': return 'reservationConfirmed';
    case 'reserved': return 'reservation';
    default:
      // 'created' | 'called' | null (event_type не пришёл/стадия не резолвилась)
      if (deal.delivered_at) return 'shipment';
      if (deal.sold_at) return 'sale';
      if (deal.confirmed_at) return 'reservationConfirmed';
      if (deal.reserved_at) return 'reservation';
      return 'inProgress';
  }
}

// Цвет полоски строки — та же палитра, что у автоцвета метрик (entity-colors.ts),
// НЕ хардкодим новые оттенки. «В работе» — без цвета (null → полоска не рисуется).
function dealStageColor(deal: Deal): string | null {
  const stage = dealStage(deal);
  if (stage === 'inProgress') return null;
  return ENTITY_COLOR[stage];
}

// Порядок групп для ДЕФОЛТНОЙ сортировки списка сделок (когда сортировка по
// колонке не выбрана юзером): Отгрузки → Продажи → Подтв. брони → Брони →
// В работе → Отказы (отказы — в самый низ, несмотря на то что при определении
// стадии выше «проигрыш» проверяется первым — это два разных порядка).
const DEAL_STAGE_SORT_ORDER: Record<DealStage, number> = {
  shipment: 0,
  sale: 1,
  reservationConfirmed: 2,
  reservation: 3,
  inProgress: 4,
  refusal: 5,
};

// Дефолтный порядок (сортировка по колонке не выбрана): группы по стадии сверху
// вниз, внутри группы — по сумме убыванием.
function sortDealsDefault(arr: Deal[]): Deal[] {
  return [...arr].sort((a, b) => {
    const ga = DEAL_STAGE_SORT_ORDER[dealStage(a)];
    const gb = DEAL_STAGE_SORT_ORDER[dealStage(b)];
    if (ga !== gb) return ga - gb;
    return (Number(b.amount) || 0) - (Number(a.amount) || 0);
  });
}

function sortDealsBy(arr: Deal[], dealSort: DealSort): Deal[] {
  // Ручная сортировка по клику на заголовок колонки ПЕРЕКРЫВАЕТ дефолтный
  // порядок по стадии; без неё — группировка по стадии (см. sortDealsDefault).
  if (!dealSort) return sortDealsDefault(arr);
  const def = DEAL_FIELDS.find(f => f.key === dealSort.key);
  const m = dealSort.dir === 'asc' ? 1 : -1;
  return [...arr].sort((a, b) => {
    if (dealSort.key === 'deal_id') return m * (a.deal_id - b.deal_id);
    const av = (a as unknown as Record<string, string | null>)[dealSort.key];
    const bv = (b as unknown as Record<string, string | null>)[dealSort.key];
    if (def?.kind === 'money') return m * ((Number(av) || 0) - (Number(bv) || 0));
    if (def?.kind === 'date') return m * ((av ? +new Date(av) : 0) - (bv ? +new Date(bv) : 0));
    return m * String(av ?? '').localeCompare(String(bv ?? ''), 'ru');
  });
}

// ── Чаты по сделкам: статусы тредов текущего пользователя (индикация кнопки) ──
// null = права action.deal_chats нет (эндпоинт вернул 403) — кнопка не рендерится.
type ChatStatusMap = Record<number, { status: 'sent' | 'replied'; unread: boolean }>;

// Кнопки справа от названия (задача владельца 20.07): копировать ссылку CRM (всем)
// и «Сообщение менеджеру» (право action.deal_chats). Прячутся до hover строки
// (.row-reveal-item — на таче видны всегда, правило CLAUDE.md №5), НО кнопка
// сообщения с существующим тредом видна всегда: зелёная — отправлено, красная —
// есть непрочитанный ответ менеджера.
function DealNameCell({ deal, chat }: {
  deal: Deal;
  chat: { map: ChatStatusMap; onOpen: (d: Deal) => void } | null;
}) {
  const [copied, setCopied] = useState(false);
  const url = `https://td.monolit-crm.ru/crm/deal/details/${deal.deal_id}/`;
  const st = chat?.map[deal.deal_id];
  return (
    <span className="flex items-center gap-0.5 max-w-[460px]">
      <a href={url} target="_blank" rel="noopener noreferrer"
         onClick={e => e.stopPropagation()}
         className="truncate hover:text-[var(--color-accent)] hover:underline transition-colors" title={deal.deal_name}>
        {deal.deal_name || '—'}
      </a>
      <button
        onClick={e => {
          e.stopPropagation();
          navigator.clipboard.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
        }}
        className="row-reveal-item tap-target shrink-0 p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        title="Копировать ссылку на сделку в Битриксе"
      >
        {copied ? <Check size={13} className="text-[var(--color-positive,#2f9e44)]" /> : <Copy size={13} />}
      </button>
      {chat && (
        <button
          onClick={e => { e.stopPropagation(); chat.onOpen(deal); }}
          className={`${st ? '' : 'row-reveal-item '}tap-target shrink-0 p-0.5 transition-colors ${
            st?.unread ? 'text-[var(--color-negative,#e03131)]'
              : st ? 'text-[var(--color-positive,#2f9e44)]'
              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
          }`}
          title={st?.unread ? 'Есть ответ менеджера' : st ? 'Сообщение отправлено — открыть переписку' : 'Написать менеджеру через бота'}
        >
          <MessageCircle size={13} fill={st ? 'currentColor' : 'none'} />
        </button>
      )}
    </span>
  );
}

// ── Deal sub-table (row expansion in the mini-report / flat list) ───────────
function dealCell(deal: Deal, key: string) {
  const def = DEAL_FIELDS.find(f => f.key === key);
  const v = (deal as unknown as Record<string, unknown>)[key] as string | null;
  if (key === 'stage_name') {
    // Бейдж стадии (п.4 правок 09.07/2) — тот же цвет, что и полоска слева
    // (dealStageColor/ENTITY_COLOR, см. ниже). «В работе» — нейтральный серый бейдж
    // (не «голый текст»), чтобы плашка была единообразно у всех строк колонки.
    const color = dealStageColor(deal);
    const text = deal.stage_name ?? '—';
    return (
      <span
        className="inline-block px-1.5 py-0.5 rounded whitespace-nowrap"
        style={color
          ? { backgroundColor: `color-mix(in srgb, ${color} var(--color-highlight-pct, 68%), var(--color-mix-base, white))`, color: 'var(--color-num, #000)' }
          : { backgroundColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}
      >
        {text}
      </span>
    );
  }
  if (def?.kind === 'money') return fmtMoney(v);
  if (def?.kind === 'date') return fmt(v);
  return v ?? '—';
}

function SortHead({ label, col, align, sortKey, sortDir, onSort }: {
  label: string; col: string; align?: 'left' | 'right'; sortKey?: string; sortDir?: 'asc' | 'desc'; onSort?: (k: string) => void;
}) {
  const active = sortKey === col;
  return (
    <th className={`px-3 py-2 font-medium text-[var(--color-text-muted)] whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'} ${onSort ? 'cursor-pointer select-none hover:text-[var(--color-text)]' : ''}`}
        onClick={onSort ? () => onSort(col) : undefined}>
      {label}{active && <span className="ml-0.5 text-[var(--color-accent)]">{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </th>
  );
}

function DealsTable({ deals, fields, sortKey, sortDir, onSort, stickyHead, onDealOpen, tableScale = 1 }: {
  deals: Deal[]; fields: string[]; sortKey?: string; sortDir?: 'asc' | 'desc'; onSort?: (k: string) => void; stickyHead?: boolean;
  onDealOpen?: (id: number) => void; tableScale?: number;
}) {
  // Column order follows the configured `fields` order.
  const cols = fields.map(k => DEAL_FIELDS.find(f => f.key === k)).filter(Boolean) as typeof DEAL_FIELDS;

  // Статусы чатов по видимым сделкам (индикация кнопки «Сообщение»). 403 = права
  // нет — statuses остаётся null и кнопка не рендерится вовсе; refetchInterval
  // держит красную индикацию живой, пока дрилл-даун открыт.
  const chatIdsKey = useMemo(() => deals.map(d => d.deal_id).sort((a, b) => a - b).join(','), [deals]);
  const { data: chatData } = useQuery({
    queryKey: ['deal-chat-statuses', chatIdsKey],
    queryFn: async () => {
      const res = await fetch(`/api/deal-chats?dealIds=${chatIdsKey}`);
      if (!res.ok) return { statuses: null };
      return res.json() as Promise<{ statuses: ChatStatusMap }>;
    },
    enabled: deals.length > 0,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const chatStatuses: ChatStatusMap | null = chatData?.statuses ?? null;
  const [chatDeal, setChatDeal] = useState<Deal | null>(null);
  // «Масштаб таблиц» ЛК (бриф 09.07, п.3): базовые 7px/12px (text-xs) масштабируются
  // ОБА на tableScale — тот же приём, что basePy/fontSize в ReportTable.tsx (line-height
  // text-xs — унитарный множитель, значит масштабируется вместе с fontSize сам), поэтому
  // 7px*2 + 16px(line-height) = 30px при tableScale=1 масштабируется пропорционально.
  const rowPy = `${7 * tableScale}px`;
  return (
    <div className={`overflow-x-auto bg-[var(--color-bg)] pl-6 py-1 ${stickyHead ? 'overflow-y-auto h-full' : ''}`}>
      {/* fontSize — инлайн-стиль НА САМОЙ <table> (не на обёртке div): именно так
          ReportTable.tsx перебивает text-xs класс тем же приёмом (инлайн-стиль на
          одном элементе с классом побеждает класс независимо от специфичности). */}
      <table
        className="w-full text-xs border-collapse"
        style={{ fontSize: `${12 * tableScale}px`, ['--deals-row-py' as string]: rowPy } as React.CSSProperties}
      >
        <thead className={stickyHead ? 'sticky top-0 z-10 bg-[var(--color-table-header)]' : undefined}>
          <tr className="bg-[var(--color-table-header)]">
            {/* Колонка «№» (п.6 правок 09.07/2) — порядковый номер видимой строки,
                отдельно от ID сделки (колонка «#» ниже — реальный ID из CRM). */}
            <th className="px-2 py-2 font-medium text-[var(--color-text-muted)] text-right whitespace-nowrap">№</th>
            <SortHead label="#" col="deal_id" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            {cols.map(c => (
              <SortHead key={c.key} label={c.label} col={c.key} align={c.align} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
            ))}
            {/* Filler: absorbs remaining width so data columns pack left */}
            <th className="p-0 w-full" />
          </tr>
        </thead>
        <tbody>
          {deals.map((deal, i) => {
            const stageColor = dealStageColor(deal);
            return (
            <tr key={deal.deal_id}
                onClick={onDealOpen ? () => onDealOpen(deal.deal_id) : undefined}
                title={onDealOpen ? 'Открыть карточку сделки' : undefined}
                className={`row-reveal border-t border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${onDealOpen ? 'cursor-pointer' : ''} ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
              {/* py-[var(--deals-row-py)] (база 7px, не py-1.5=6px, правка 09.07 «строка →
                  30px»): text-xs (12px) даёт line-height ~16px (Tailwind
                  --text-xs--line-height: 1/0.75), 7+16+7=30 — та же высота строки, что и в
                  основной таблице отчёта (ReportTable.tsx). Масштабируется «Масштабом
                  таблиц» (см. rowPy выше) вместе с fontSize контейнера. */}
              <td className="px-2 py-[var(--deals-row-py)] text-right text-[11px] text-[var(--color-text-muted)] tabular-nums whitespace-nowrap">
                {i + 1}
              </td>
              <td className="px-5 py-[var(--deals-row-py)] text-[var(--color-text-muted)] whitespace-nowrap">
                {/* Полоска слева по текущей стадии сделки (тот же приём, что у строки
                    «Итого» основного отчёта — w-1 h-4 rounded-full); «в работе» — без
                    цвета, полоска прозрачна (сознательно, см. dealStageColor). */}
                <span className="flex items-center gap-1.5">
                  <span className="w-1 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: stageColor ?? 'transparent' }} />
                  {deal.deal_id}
                </span>
              </td>
              {cols.map(c => (
                <td key={c.key}
                    className={`px-3 py-[var(--deals-row-py)] whitespace-nowrap ${c.align === 'right' ? 'text-right tabular-nums' : ''} ${c.kind !== 'text' ? 'text-[var(--color-text-muted)]' : ''} ${c.key === 'amount' ? 'font-medium !text-[var(--color-num,#000)]' : ''}`}>
                  {c.key === 'deal_name'
                    ? <DealNameCell deal={deal} chat={chatStatuses !== null ? { map: chatStatuses, onOpen: setChatDeal } : null} />
                    : dealCell(deal, c.key)}
                </td>
              ))}
              <td className="p-0" />
            </tr>
            );
          })}
        </tbody>
      </table>
      {chatDeal && (
        <DealChatPanel
          dealId={chatDeal.deal_id}
          dealName={chatDeal.deal_name}
          managerName={chatDeal.manager_name}
          onClose={() => setChatDeal(null)}
        />
      )}
    </div>
  );
}

// ── Плоский список сделок по готовому набору query-параметров ───────────────
// `fetchOverride` (задача 2546, дрилл-даун из графиков — features/charts/ui/*):
// когда список сделок выбирается не dimension-фильтром (`managerId`/
// `productGroup`/...), а явным набором deal_id, вычисленным на сервере (кривые
// «Вероятность продажи»/когорта «Созвонился→продажа» строятся по deal_events,
// не выразимы через query-параметры /api/reports/deals) — вместо GET по `query`
// используется переданный fetcher. `query` тогда не нужен; `fetchOverride.key`
// обязан включать всё, от чего зависит результат (иначе react-query не
// перезапросит список при смене корзины/фильтра).
export function DealsListBody({ query, fetchOverride, dealFields, onDealOpen, tableScale, emptyLabel }: {
  query?: URLSearchParams;
  fetchOverride?: { key: unknown[]; fn: () => Promise<{ deals: Deal[]; total_count: number; total_amount: number }> };
  dealFields?: string[]; onDealOpen?: (id: number) => void; tableScale?: number; emptyLabel?: string;
}) {
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const [dealSort, setDealSort] = useState<DealSort>(null);
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }
  const qs = query?.toString() ?? '';
  const { data, isLoading } = useQuery({
    queryKey: fetchOverride ? ['drill-deals-override', ...fetchOverride.key] : ['drill-deals-flat', qs],
    queryFn: fetchOverride ? fetchOverride.fn : () => fetch(`/api/reports/deals?${qs}`).then(r => r.json()),
  });
  const deals: Deal[] = data?.deals ?? [];
  // Задача #2369: «Итого» должно отражать ПОЛНУЮ выборку, а не только пришедший
  // список (бэк режет его LIMIT 1000, см. app/api/reports/deals/route.ts). Роут
  // теперь всегда отдаёт total_count/total_amount отдельным безлимитным агрегатом —
  // берём их. Фолбэк на reduce по списку — только если ответ старый (без полей),
  // например если фронт не успел обновиться синхронно с бэком.
  const hasTotals = data?.total_count != null && data?.total_amount != null;
  const totalCount  = hasTotals ? Number(data.total_count)  : deals.length;
  const totalAmount = hasTotals ? Number(data.total_amount) : deals.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const isTruncated = totalCount > deals.length;

  if (isLoading) {
    return <div className="p-6 space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}</div>;
  }
  if (deals.length === 0) {
    return <div className="p-10 text-center text-[var(--color-text-muted)] text-sm">{emptyLabel ?? 'Нет сделок за выбранный период'}</div>;
  }
  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-2 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)] shrink-0">
        {/* «Итого: N сделок» (п.7 правок 09.07/2) вместо голого счётчика — склонение
            см. dealsCountLabel. Итог теперь из безлимитного агрегата (total_count/
            total_amount), не из reduce по обрезанному списку (#2369). */}
        {`Итого: ${dealsCountLabel(totalCount)}`} · {fmtMoney(totalAmount)}
        {isTruncated && (
          <span className="ml-2 text-[var(--color-text-muted)]">
            (показаны первые {deals.length} из {totalCount})
          </span>
        )}
      </div>
      <div className="flex-1 overflow-hidden">
        <DealsTable deals={sortDealsBy(deals, dealSort)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} stickyHead onDealOpen={onDealOpen} tableScale={tableScale} />
      </div>
    </div>
  );
}

// Общие query-параметры дрилл-даун сделок. ВАЖНО: фильтр отделов передаётся всегда
// (отчёт применяет его к цифрам — сделки обязаны совпадать); тип аккаунтов — только
// для отчёта по менеджерам (в остальных отчётах движок его игнорирует).
function baseDealParams(p: Pick<Props, 'period' | 'dealScope' | 'clientType' | 'productGroupMode' | 'departmentIds' | 'accountType' | 'dimensionType'>): Record<string, string> {
  return {
    from: p.period.from.toISOString(),
    to: p.period.to.toISOString(),
    scope: p.dealScope,
    productGroupMode: p.productGroupMode,
    ...(p.clientType ? { clientType: p.clientType } : {}),
    ...(p.dimensionType !== 'source' && p.departmentIds?.length ? { departmentIds: p.departmentIds.join(',') } : {}),
    ...(p.dimensionType === 'manager' && p.accountType && p.accountType !== 'all' ? { accountType: p.accountType } : {}),
  };
}

// ── Flat deals view (grouping off / metric-filtered drill / group targets) ──
function FlatDealsView({ target, dimensionType, period, dealScope, clientType, productGroupMode, dealFields, sourceDimension, departmentIds, accountType, onDealOpen, tableScale }: Props) {
  // Групповые цели: отдел → teamId; филиал → менеджерское измерение branch;
  // «Итого» → весь срез (фильтры отчёта по отделам/типу аккаунтов — в baseDealParams)
  const dimensionParams: Record<string, string> =
    target.kind === 'team'   ? { teamId: target.id }
    : target.kind === 'branch' ? { sourceDim: 'branch', sourceVal: target.id }
    : target.kind === 'total'  ? { all: '1' }
    : dimensionType === 'manager' ? { managerId: target.id }
    : dimensionType === 'source' ? { sourceDim: sourceDimension ?? 'brand', sourceVal: target.id }
    : { productGroup: target.id };
  const params = new URLSearchParams({
    ...baseDealParams({ period, dealScope, clientType, productGroupMode, departmentIds, accountType, dimensionType }),
    ...dimensionParams,
    ...(target.metricId ? { metricFilter: target.metricId } : {}),
  });
  return <DealsListBody query={params} dealFields={dealFields} onDealOpen={onDealOpen} tableScale={tableScale} />;
}

// ── Суб-дрилл: сделки по паре «цель × строка мини-отчёта» + метрика ─────────
function SubDealsView(props: Props & { sub: SubDrill; onBack: () => void }) {
  const { sub, onBack, period, dealScope, clientType, productGroupMode, departmentIds, accountType, dimensionType, dealFields, onDealOpen, tableScale } = props;
  const params = new URLSearchParams({
    ...baseDealParams({ period, dealScope, clientType, productGroupMode, departmentIds, accountType, dimensionType }),
    ...(sub.managerId ? { managerId: sub.managerId } : {}),
    ...(sub.productGroup !== undefined ? { productGroup: sub.productGroup } : {}),
    ...(sub.sourceDim && sub.sourceVal !== undefined ? { sourceDim: sub.sourceDim, sourceVal: sub.sourceVal } : {}),
    metricFilter: sub.metricId,
  });
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
        <button onClick={onBack} className="tap-target flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors">
          <ArrowLeft size={14} /> Назад
        </button>
        <span className="text-sm font-medium text-[var(--color-text)] truncate">{sub.rowName}</span>
        <span className="px-2 py-0.5 text-[11px] rounded-full bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)] shrink-0">
          {sub.metricName ?? sub.metricId}
        </span>
      </div>
      <div className="flex-1 overflow-hidden">
        <DealsListBody query={params} dealFields={dealFields} onDealOpen={onDealOpen} tableScale={tableScale} />
      </div>
    </div>
  );
}

// ── Мини-отчёт дрилл-дауна ───────────────────────────────────────────────────
// Одна таблица на все три типа цели (менеджер / товарная группа / источник):
// рендерится тем же ReportTable, что и основной отчёт, — со всеми настройками
// метрик (тепловая карта, подсветки, режимы сравнения, десятичные, акценты).
interface SourceInfoLite { source_id: string; contact_type: string | null; branch: string | null; platform: string | null; brand: string | null; ad_channel: string | null; channel_group: string | null }

// Тип сортировки мини-отчёта (2-й уровень drill-down) — поднят в DrilldownDrawer
// (см. MiniReportSort ниже), чтобы переживать переход на суб-дрилл (3-й уровень,
// задача #2388: клик по цифре размонтирует MiniReport — sub ? <SubDealsView/> :
// <MiniReport/> — и локальный useState сортировки терялся при возврате «назад»).
type MiniReportSort = { key: string | null; dir: 'asc' | 'desc' };

// ── Группировка мини-отчёта дрилл-дауна (задача #2390, переделка #2385) ─────
// #2385 ошибочно применил переключатель «Без групп./По отделу/По филиалу/Итого» к
// ПЛОСКОМУ списку сделок (см. DealsListBody выше — та группировка убрана, список
// сделок снова как до #2385). Правильный уровень — ТАБЛИЦА МЕНЕДЖЕРОВ мини-отчёта:
// секции отделов/филиалов, свёрнутые по умолчанию, разворачиваются в строки
// менеджеров, строка менеджера дальше разворачивается в сделки (как уже было).
// Логика честной агрегации 1-в-1 зеркалит applyClientGrouping/aggregateGroupDeltas
// из SalesReportPage.tsx (верхний уровень отчёта) — тот же фолбэк 'Без отдела'/'СПб',
// тот же порядок групп «по первому появлению» в уже отсортированных строках (группы
// естественно идут по убыванию активной колонки сортировки — см. compareRows/
// sortGroupChildren в ReportTable.tsx, они пересортировывают И группы, И их children
// той же колонкой). Рендерится тем же ReportTable, что и верхний уровень (isGroup/
// children уже поддержаны компонентом, включая свёрнутость по умолчанию — grouping
// prop, needCollapseRef).
interface MiniGroupRow extends RowDeltas {
  teamId?: string | null;
  branchName?: string | null;
}

function aggregateMiniGroupDeltas(members: MiniGroupRow[], metrics: Metric[]): MiniGroupRow['deltas'] {
  const ids = new Set<string>();
  for (const r of members) for (const id of Object.keys(r.deltas)) ids.add(id);
  const byId = new Map(metrics.map(m => [m.id, m]));

  const sumsCur: Record<string, number | null> = {};
  const sumsCmp: Record<string, number | null> = {};
  for (const id of ids) {
    if (byId.get(id)?.metricType === 'calculated') continue;
    let cur: number | null = null, cmp: number | null = null;
    for (const r of members) {
      const d = r.deltas[id];
      if (!d) continue;
      if (d.current !== null) cur = (cur ?? 0) + d.current;
      if (d.comparison !== null) cmp = (cmp ?? 0) + d.comparison;
    }
    sumsCur[id] = cur;
    sumsCmp[id] = cmp;
  }

  const calc = metrics.filter(m => m.metricType === 'calculated' && ids.has(m.id));
  const cur = computeCalculated(sumsCur, calc);
  const cmp = computeCalculated(sumsCmp, calc);

  const deltas: MiniGroupRow['deltas'] = {};
  for (const id of ids) {
    const c = cur[id] ?? null, p = cmp[id] ?? null;
    const delta = c !== null && p !== null ? c - p : null;
    const deltaPct = delta === null || p === null || p === 0 ? null : (delta / p) * 100;
    deltas[id] = { current: c, comparison: p, delta, deltaPct };
  }
  return deltas;
}

function applyMiniGrouping(rows: MiniGroupRow[], grouping: Grouping, metrics: Metric[]): MiniGroupRow[] {
  if (grouping === 'none') return rows;

  if (grouping === 'total') {
    return [{
      dimensionId: '__total__', dimensionName: 'Итого', teamName: null,
      deltas: aggregateMiniGroupDeltas(rows, metrics), isGroup: true, children: rows,
    }];
  }

  if (grouping === 'branch') {
    // Задача #2390 (AC1): секция филиала разворачивается СРАЗУ в строки менеджеров
    // (не через промежуточный подытог отдела, как это сделано на верхнем уровне
    // отчёта в SalesReportPage.applyClientGrouping, — там branch→team-подытог→[конец],
    // без раскрытия до менеджера; для мини-отчёта дрилл-дауна ТЗ требует именно
    // «секция→менеджеры→сделки», поэтому структура здесь плоская: branch→managers).
    const order: string[] = [];
    const groups = new Map<string, MiniGroupRow[]>();
    for (const row of rows) {
      const key = row.branchName ?? 'СПб'; // правило: не Москва и не Краснодар → СПб
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key)!.push(row);
    }
    return order.map(branch => {
      const members = groups.get(branch)!;
      return {
        dimensionId: `__branch__${branch}`,
        // Display-слой: «СПб»→«Санкт-Петербург» и т.п. — ключ dimensionId/branchName
        // остаётся сырым.
        dimensionName: branchLabel(branch),
        teamId: null,
        teamName: null,
        branchName: branch,
        deltas: aggregateMiniGroupDeltas(members, metrics),
        isGroup: true,
        children: members,
      };
    });
  }

  // grouping === 'team'
  const order: string[] = [];
  const groups = new Map<string, MiniGroupRow[]>();
  for (const row of rows) {
    const key = row.teamId ?? '__no_team__';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key)!.push(row);
  }
  return order.map(key => {
    const members = groups.get(key)!;
    const name = members[0]?.teamName ?? 'Без отдела';
    return {
      dimensionId: `__team__${key}`,
      dimensionName: name,
      teamId: key,
      teamName: name,
      deltas: aggregateMiniGroupDeltas(members, metrics),
      isGroup: true,
      children: members,
    };
  });
}

function MiniReport(props: Props & { onCellDrill: (s: SubDrill) => void; sort: MiniReportSort; onSortChange: (s: MiniReportSort) => void }) {
  const {
    target, dimensionType, period, comparison, dealScope, clientType, productGroupMode,
    metricIds, departmentIds, dealFields, sourceDimension, drilldownDimension,
    onDealOpen, onCellDrill, sort, onSortChange,
  } = props;
  const dealCols = dealFields ?? DEFAULT_DEAL_FIELDS;
  const mainDim = sourceDimension ?? 'brand';
  const dim: DrilldownDimension = drilldownDimension ?? 'contact_type';

  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // all collapsed by default
  const [dealSort, setDealSort] = useState<DealSort>(null);
  function onDealSort(k: string) {
    setDealSort(p => (p && p.key === k ? { key: k, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
  }

  // Группировка секций мини-отчёта (задача #2390) — «Без групп.» по умолчанию,
  // поведение таблицы менеджеров не меняется, пока пользователь явно не переключит.
  // Применимо только там, где строки мини-отчёта — МЕНЕДЖЕРЫ: отчёт «по товарным
  // группам» (target=товарная группа, rows=менеджеры) и маркетинговый дрилл-даун с
  // разбивкой «Менеджер» (dim==='manager', reportSlug 'by-managers'); в остальных
  // случаях (target=менеджер → rows=товарные группы; прочие маркетинговые разбивки)
  // у строк нет team/branch — селектор скрыт, поведение как раньше.
  const [miniGrouping, setMiniGrouping] = useState<Grouping>('none');
  const rowsAreManagers = dimensionType === 'product-group' || (dimensionType === 'source' && dim === 'manager');

  const fromIso = period.from.toISOString();
  const toIso   = period.to.toISOString();
  // Реальный период сравнения — чтобы режимы сравнения (компакт/полный) показывали
  // настоящие дельты, как в основном отчёте.
  const cmpFromIso = (comparison ?? period).from.toISOString();
  const cmpToIso   = (comparison ?? period).to.toISOString();

  const runBody =
    dimensionType === 'manager' ? {
      reportSlug: 'by-product-groups',
      managerId: target.id,
      productGroupMode,
    } : dimensionType === 'product-group' ? {
      reportSlug: 'by-managers',
      productGroupId: target.id,
      productGroupMode,
      departmentIds: departmentIds?.length ? departmentIds : undefined,
    } : {
      reportSlug: dim === 'manager' ? 'by-managers' : 'by-sources',
      sourceDimension: dim === 'manager' ? undefined : dim,
      sourceFilter: { dimension: mainDim, value: target.id },
    };

  const { data: runData, isLoading } = useQuery({
    queryKey: ['drill-mini', dimensionType, dim, target.id, fromIso, toIso, cmpFromIso, cmpToIso, dealScope, clientType, productGroupMode, metricIds, departmentIds],
    queryFn: async () => {
      const res = await fetch('/api/reports/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...runBody,
          period: { from: fromIso, to: toIso },
          comparisonPeriod: { from: cmpFromIso, to: cmpToIso },
          metricIds,
          dealScope,
          clientType,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  // Сделки цели (без фильтра по метрике) — для раскрытия строк мини-отчёта
  const dealParams = new URLSearchParams({
    ...baseDealParams(props),
    ...(dimensionType === 'manager' ? { managerId: target.id }
      : dimensionType === 'product-group' ? { productGroup: target.id }
      : { sourceDim: mainDim, sourceVal: target.id }),
  });
  const { data: dealData } = useQuery({
    queryKey: ['drill-mini-deals', dimensionType, mainDim, target.id, fromIso, toIso, dealScope, clientType, productGroupMode, departmentIds],
    queryFn: () => fetch(`/api/reports/deals?${dealParams}`).then(r => r.json()),
  });

  // Справочник источников + карта менеджер→филиал — раскладка сделок по второй
  // сущности маркетингового дрилл-дауна
  const { data: srcCatalog } = useQuery({
    queryKey: ['marketing-sources'],
    queryFn: () => fetch('/api/catalog/marketing-sources').then(r => r.json()) as Promise<{ sources: SourceInfoLite[]; managerBranches: Record<string, string> }>,
    staleTime: 10 * 60 * 1000,
    enabled: dimensionType === 'source' && dim !== 'manager',
  });
  const srcMap = useMemo(() => new Map((srcCatalog?.sources ?? []).map(s => [s.source_id, s])), [srcCatalog]);
  const mgrBranches = useMemo(() => srcCatalog?.managerBranches ?? {}, [srcCatalog]);

  const metrics: Metric[] = runData?.metrics ?? [];
  const rawRows: MiniGroupRow[] = runData?.rows ?? [];
  const totals: Record<string, TotalsMetricValue> | null = runData?.totals ?? null;
  const deals: Deal[] = dealData?.deals ?? [];

  // Ключ бакета сделки = dimensionId (или dimensionName для товарных групп) строки
  const bucketKey = (row: { dimensionId: string; dimensionName: string }) =>
    dimensionType === 'manager' ? row.dimensionName : row.dimensionId;

  const dealsByRow = useMemo(() => {
    const m = new Map<string, Deal[]>();
    for (const d of deals) {
      let key: string;
      if (dimensionType === 'manager') key = d.product_group_display;          // строки = товарные группы
      else if (dimensionType === 'product-group') key = d.manager_id;          // строки = менеджеры
      else if (dim === 'manager') key = d.manager_id;
      else if (dim === 'branch') key = mgrBranches[d.manager_id] ?? UNDEFINED_LABEL; // филиал = по менеджеру сделки
      else if (dim === 'source') key = d.source_id ?? '__null__';
      else if (!d.source_id) key = NO_SOURCE_LABEL;
      else {
        const info = srcMap.get(d.source_id);
        key = info ? (info[dim] ?? UNDEFINED_LABEL) : UNDEFINED_LABEL;
      }
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(d);
    }
    return m;
  }, [deals, dimensionType, dim, srcMap, mgrBranches]);

  // Счётчик сделок строки — в подзаголовок измерения
  const rows = useMemo(() => rawRows.map(r => {
    const n = (dealsByRow.get(bucketKey(r)) ?? []).length;
    return { ...r, dimensionSubtitle: [r.dimensionSubtitle, `${n} сд.`].filter(Boolean).join(' · ') };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [rawRows, dealsByRow, dimensionType]);

  function toggle(id: string) {
    setExpanded(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  // Клик по цифре мини-отчёта: сделки пары «цель × строка», отфильтрованные по метрике.
  // Для маркетингового дрилл-дауна вторая сущность фильтруема только когда это менеджер.
  const canCellDrill = dimensionType !== 'source' || dim === 'manager';
  function handleCellClick(dimensionId: string, dimensionName: string, metricId: string) {
    // Секция группировки (отдел/филиал, задача #2390) — синтетический dimensionId
    // (__team__.../__branch__...), не соответствует ни одной реальной строке; клик по
    // её метрике не должен уходить в суб-дрилл с мусорным managerId/productGroup.
    // '__total__' сюда НЕ попадает (см. isTotal ниже) — это легитимный клик по строке
    // «Итого» (уже существовавшее поведение, независимое от #2390).
    if (dimensionId.startsWith('__team__') || dimensionId.startsWith('__branch__')) return;
    const m = metrics.find(x => x.id === metricId);
    const isTotal = dimensionId === '__total__';
    const base: SubDrill = {
      rowName: isTotal ? `${target.name} · Итого` : dimensionName,
      metricId,
      metricName: m?.nameRu,
    };
    if (dimensionType === 'manager') {
      onCellDrill({ ...base, managerId: target.id, ...(isTotal ? {} : { productGroup: dimensionId }) });
    } else if (dimensionType === 'product-group') {
      onCellDrill({ ...base, productGroup: target.id, ...(isTotal ? {} : { managerId: dimensionId }) });
    } else {
      onCellDrill({ ...base, sourceDim: mainDim, sourceVal: target.id, ...(isTotal ? {} : { managerId: dimensionId }) });
    }
  }

  const label = dimensionType === 'manager' ? 'Товарная группа'
    : dimensionType === 'product-group' ? 'Менеджер'
    : dimensionLabel(dim);

  // Группировка секций (задача #2390) — только когда строки реально менеджеры
  // (rowsAreManagers, см. выше); иначе селектор скрыт, rows идут как есть.
  const effectiveGrouping: Grouping = rowsAreManagers ? miniGrouping : 'none';
  const groupedRows: MiniGroupRow[] = effectiveGrouping !== 'none' ? applyMiniGrouping(rows, effectiveGrouping, metrics) : rows;

  return (
    <div className="h-full flex flex-col">
      {rowsAreManagers && (
        <div className="px-3 sm:px-6 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0 flex items-center justify-end">
          <GroupingSelector grouping={miniGrouping} onGroupingChange={setMiniGrouping} />
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ReportTable
          rows={groupedRows}
          totals={totals}
          metrics={metrics}
          comparisonDisplay={props.comparisonDisplay ?? 'current'}
          metricDisplayModes={props.metricDisplayModes}
          comparisonThreshold={props.comparisonThreshold}
          isLoading={isLoading}
          grouping={effectiveGrouping}
          dimensionLabel={label}
          highlights={props.highlights}
          metricDecimalOverrides={props.metricDecimalOverrides}
          metricThresholdOverrides={props.metricThresholdOverrides}
          accentedMetricIds={props.accentedMetricIds}
          barMetricIds={props.barMetricIds}
          heatmapMetricIds={props.heatmapMetricIds}
          heatmapInvertedIds={props.heatmapInvertedIds}
          colorizeMetrics={props.colorizeMetrics}
          zebra={props.zebra}
          borderMode={props.borderMode}
          numberAlign={props.numberAlign}
          pinnedMetricIds={props.pinnedMetricIds}
          columnGroups={props.columnGroups}
          density={props.density}
          tableScale={props.tableScale}
          sortBy={sort.key}
          sortDir={sort.dir}
          onSortChange={(by, dir) => onSortChange({ key: by, dir })}
          onRowClick={id => toggle(id)}
          onCellClick={canCellDrill ? handleCellClick : undefined}
          expandedRowIds={expanded}
          renderExpandedRow={row => {
            const rowDeals = dealsByRow.get(bucketKey(row)) ?? [];
            return rowDeals.length
              ? <DealsTable deals={sortDealsBy(rowDeals, dealSort)} fields={dealCols} sortKey={dealSort?.key} sortDir={dealSort?.dir} onSort={onDealSort} onDealOpen={onDealOpen} tableScale={props.tableScale} />
              : <div className="px-6 py-3 text-xs text-[var(--color-text-muted)]">Нет сделок за период</div>;
          }}
        />
      </div>
    </div>
  );
}

export function DrilldownDrawer(props: Props) {
  const { target, dimensionType, grouped, onGroupedChange, toolbarExtras, drilldownDimension, onDrilldownDimensionChange, onClose } = props;
  // Карточка сделки (клик по строке в любом списке сделок)
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  // Суб-дрилл из мини-отчёта (клик по цифре)
  const [sub, setSub] = useState<SubDrill | null>(null);
  // Сортировка мини-отчёта (2-й уровень) — задача #2388: живёт в DrilldownDrawer
  // (который не размонтируется при переходе на суб-дрилл/3-й уровень и обратно),
  // а не в MiniReport (который размонтируется, см. `sub ? <SubDealsView/> :
  // <MiniReport/>` ниже). Дефолт берётся из сортировки основного отчёта РОВНО
  // один раз — при монтировании drawer'а (новый target = новый drawer, см. key={...}
  // в SalesReportPage), так что первое открытие не меняет поведение.
  const [miniSort, setMiniSort] = useState<MiniReportSort>({ key: props.sortBy ?? null, dir: props.sortDir ?? 'desc' });

  // ── Собственные фильтры дрилл-дауна (п. Н4 спеки) ──────────────────────────
  // При открытии дрилл-даун наследует период/фильтры основного отчёта (значения
  // props на момент монтирования — новый target всегда монтирует новый компонент,
  // см. key={...} в SalesReportPage). Дальше пользователь может их менять здесь;
  // это состояние ЛОКАЛЬНО и не пробрасывается обратно в основной отчёт.
  const [localPeriod, setLocalPeriod] = useState<DateRange>(() => props.period);
  const [localComparison, setLocalComparison] = useState<DateRange>(() => props.comparison ?? recomputeComparison(props.period));
  const [localDepartmentIds, setLocalDepartmentIds] = useState<string[]>(() => props.departmentIds ?? []);
  const [localDealScope, setLocalDealScope] = useState<DealScope>(() => props.dealScope);
  const [localClientType, setLocalClientType] = useState<ClientType>(() => props.clientType ?? 'all');
  const [localProductGroupMode, setLocalProductGroupMode] = useState<ProductGroupMode>(() => props.productGroupMode);
  const [localAccountType, setLocalAccountType] = useState<AccountType>(() => props.accountType ?? 'managers');

  // Смена любого локального фильтра сбрасывает открытый суб-дрилл (иначе он
  // остаётся отфильтрован под уже неактуальную комбинацию «строка × метрика»).
  function updateLocalPeriod(p: DateRange) { setSub(null); setLocalPeriod(p); }
  function updateLocalComparison(p: DateRange) { setSub(null); setLocalComparison(p); }
  function updateLocalDepartmentIds(ids: string[]) { setSub(null); setLocalDepartmentIds(ids); }
  function updateLocalDealScope(v: DealScope) { setSub(null); setLocalDealScope(v); }
  function updateLocalClientType(v: ClientType) { setSub(null); setLocalClientType(v); }
  function updateLocalProductGroupMode(v: ProductGroupMode) { setSub(null); setLocalProductGroupMode(v); }
  function updateLocalAccountType(v: AccountType) { setSub(null); setLocalAccountType(v); }

  const viewProps: Props = {
    ...props,
    onDealOpen: setOpenDealId,
    period: localPeriod,
    comparison: localComparison,
    departmentIds: localDepartmentIds,
    dealScope: localDealScope,
    clientType: localClientType,
    productGroupMode: localProductGroupMode,
    accountType: localAccountType,
  };
  // Групповые цели (отдел/филиал/итого) всегда открываются плоским списком сделок
  const isGroupTarget = !!target.kind;
  // Local grouping state: metric-click opens flat automatically; otherwise report setting.
  const [localGrouped, setLocalGrouped] = useState<boolean>(target.metricId || isGroupTarget ? false : (grouped ?? true));
  // Follow external changes of the report setting (e.g. from «Вид» inside the drawer),
  // without overriding the initial metric-click auto-flat.
  const prevGrouped = useRef(grouped);
  useEffect(() => {
    if (prevGrouped.current !== grouped) {
      prevGrouped.current = grouped;
      setLocalGrouped(grouped ?? true);
    }
  }, [grouped]);
  function handleToggle(v: boolean) {
    setLocalGrouped(v);
    setSub(null);
    // Explicit toggle is a report setting (saved with the report); the automatic
    // metric-click "нет" above is transient and doesn't touch it.
    onGroupedChange?.(v);
  }
  const { closing, requestClose } = useSlideClose(onClose);
  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Полоска-подложка для закрытия — только там, где есть место (sm+). Цвет/прозрачность
          — общий эталон затемнения (SLIDE_BACKDROP_BG, правка 09.07). */}
      <div
        className={`hidden sm:block w-[10%] shrink-0 ${SLIDE_BACKDROP_BG} cursor-pointer slide-backdrop-fade ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={requestClose}
      />
      {/* Язычок-таб на границе подложки и панели — только там, где подложка вообще есть (sm+);
          на мобиле панель фуллскрин (подложки нет, некуда цеплять таб) — там остаётся обычный
          крестик в шапке (см. кнопку ниже, sm:hidden). */}
      <PanelCloseTab onClick={requestClose} style={{ left: '10%', transform: 'translateX(-100%)' }} />
      <div className={`flex-1 min-w-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <div className="flex items-center justify-between flex-wrap gap-y-2 px-3 sm:px-6 py-3 sm:py-4 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-[var(--color-text)] text-base truncate">
              {target.name}
              {target.metricId && (
                <span className="ml-2 align-middle inline-block px-2 py-0.5 text-[11px] font-normal rounded-full bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]">
                  {target.metricName ?? target.metricId}
                </span>
              )}
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {format(localPeriod.from, 'd MMM', { locale: ru })} — {format(localPeriod.to, 'd MMM yyyy', { locale: ru })}
              {localGrouped && (dimensionType === 'manager' ? ' · по товарным группам'
                : dimensionType === 'source' ? ` · по: ${dimensionLabel(drilldownDimension ?? 'contact_type').toLowerCase()}`
                : ' · по менеджерам')}
              {!localGrouped && ' · все сделки'}
            </p>
          </div>
          <div className="flex items-center flex-wrap gap-2 sm:gap-3 shrink-0 ml-auto pl-2">
            {toolbarExtras}
            {dimensionType === 'source' && onDrilldownDimensionChange && (
              <>
                <span className="text-xs text-[var(--color-text-muted)]">Разбивка</span>
                <select
                  value={drilldownDimension ?? 'contact_type'}
                  onChange={e => { setSub(null); onDrilldownDimensionChange(e.target.value as DrilldownDimension); }}
                  className="px-2 py-1 text-xs border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                >
                  {DRILLDOWN_DIMENSIONS.map(d => (
                    <option key={d.key} value={d.key}>{d.label}</option>
                  ))}
                </select>
              </>
            )}
            {!isGroupTarget && (
              <>
                <span className="text-xs text-[var(--color-text-muted)]">Группировка</span>
                <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs">
                  {([true, false] as const).map(v => (
                    <button
                      key={String(v)}
                      onClick={() => handleToggle(v)}
                      className={`px-2.5 py-1 transition-colors ${localGrouped === v ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
                    >
                      {v ? 'Да' : 'Нет'}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={requestClose} className="sm:hidden p-2 hover:bg-[var(--color-bg-hover)] rounded-lg transition-colors"><X size={18} /></button>
          </div>
        </div>
        {/* Собственные фильтры дрилл-дауна: период + весь набор фильтров основного
            отчёта (отделы, тип сделок/клиента/аккаунтов, товарные группы). Наследуются
            при открытии, дальше независимы от основного отчёта (см. localXxx выше). */}
        <div className="flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0 flex-wrap">
          <PeriodRangeControls
            period={localPeriod}
            comparison={localComparison}
            onPeriodChange={updateLocalPeriod}
            onComparisonChange={updateLocalComparison}
          />
          {dimensionType !== 'source' && (
            <DepartmentPicker departmentIds={localDepartmentIds} onDepartmentIdsChange={updateLocalDepartmentIds} />
          )}
          <FiltersMenu
            dealScope={localDealScope}
            onDealScopeChange={updateLocalDealScope}
            clientType={localClientType}
            onClientTypeChange={updateLocalClientType}
            productGroupMode={localProductGroupMode}
            onProductGroupModeChange={updateLocalProductGroupMode}
            showProductGroupPicker
            accountType={dimensionType === 'manager' ? localAccountType : undefined}
            onAccountTypeChange={dimensionType === 'manager' ? updateLocalAccountType : undefined}
          />
        </div>
        <div className="flex-1 overflow-hidden">
          {localGrouped && !isGroupTarget
            ? (sub
                ? <SubDealsView {...viewProps} sub={sub} onBack={() => setSub(null)} />
                : <MiniReport {...viewProps} onCellDrill={setSub} sort={miniSort} onSortChange={setMiniSort} />)
            : <FlatDealsView {...viewProps} />}
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}
