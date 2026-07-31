'use client';
// ЛК менеджера («Карточка 10.0», задача владельца 29.07) — полностраничная карточка,
// заменившая слайд-панель ManagerCardPanel (сущность одна, решение владельца).
// Разделы: hero (аватар/рейтинг/ранги) → фильтры → профиль эффективности
// (шестиугольник + плитки) → звонки → товарные категории → график работы.
// mode='department' — те же разделы на агрегате отдела (managerId = uuid отдела | 'all').
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { ManagerActivityTab } from './ManagerActivityTab';
import { BadgeShelf, TeamBadgesBlock } from '@/features/badges/ui/BadgeShelf';
import { ManagerTabBar, ProfileTab, RewardsTab, ShopTab, type ManagerTabKey } from './ManagerTabs';
import { previousPeriodSameLength, type DateRange } from '@/lib/period';
import type { ProductGroupMode } from '@/lib/metrics/types';
import { ManagerCardRadar, type RadarAxisInput } from './ManagerCardRadar';
import { Avatar } from '@/components/ui/Avatar';
import { PlanFactStrip, usePlanFact } from './PlanFactStrip';
import { ManagerDailySalesCard } from './ManagerDailySalesCard';
import { buildManagerReportText } from '@/features/manager-card/engine/managerReportText';
import { Copy, Check } from 'lucide-react';
import type { CardSegment, ManagerCardResult, AxisUnit } from '@/features/manager-card/engine/managerCard';

// Ответ карточки: у отдела к нему добавляется deptComparison (peerCount/
// insufficientPeers из движка + aggregateOf от роута — сколько отделов объединено).
type CardResponse = ManagerCardResult & {
  deptComparison?: { peerCount: number; insufficientPeers: boolean; aggregateOf?: number };
};

// ── Форматирование (переехало из ManagerCardPanel без изменений) ────────────────────
function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} тыс ₽`;
  return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ₽`;
}
function fmtInt(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}
function fmtDeltaPct(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !isFinite(v)) return null;
  const rounded = Math.round(v);
  return `${rounded >= 0 ? '↑' : '↓'} ${Math.abs(rounded)}%`;
}
function fmtMinutes(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const m = Math.round(v);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtByUnit(v: number | null | undefined, unit: AxisUnit): string {
  if (v === null || v === undefined) return '—';
  switch (unit) {
    case 'money': return fmtMoney(v);
    case 'percent': return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
    case 'minutes': return fmtMinutes(v);
    case 'count': return fmtInt(v);
    case 'decimal':
    default: return v.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }
}
function fmtDateShort(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function DeltaBadge({ deltaPct }: { deltaPct: number | null | undefined }) {
  const label = fmtDeltaPct(deltaPct);
  if (label === null) return null;
  const up = (deltaPct ?? 0) >= 0;
  return (
    <span
      className="self-start text-[11px] font-bold px-1.5 py-0.5 rounded-full"
      style={up
        ? { color: 'var(--color-positive)', backgroundColor: 'color-mix(in srgb, var(--color-positive) 14%, transparent)' }
        : { color: 'var(--color-negative)', backgroundColor: 'color-mix(in srgb, var(--color-negative) 14%, transparent)' }}
    >
      {label}
    </span>
  );
}

// Плитка итогов — вариант Б аудита (подпись сверху, значение крупно), без изменений.
function Tile({ value, label, deltaPct }: { value: string; label: string; deltaPct: number | null | undefined }) {
  return (
    <div className="border border-[var(--color-border)] rounded-xl px-3.5 py-3 flex flex-col gap-1.5 min-w-0 bg-[var(--color-bg-surface)]">
      <span className="text-[11px] text-[var(--color-text-muted)]">{label}</span>
      <span className="text-xl font-extrabold text-[var(--color-text)] leading-tight whitespace-nowrap">{value}</span>
      <DeltaBadge deltaPct={deltaPct} />
    </div>
  );
}

function ChipGroup<T extends string>({ value, options, onChange }: {
  value: T; options: { key: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-xs shrink-0">
      {options.map(opt => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={`px-2.5 py-1.5 transition-colors whitespace-nowrap ${
            value === opt.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Дрилл-даун «клик по товарной группе» (без изменений, тот же /api/reports/deals) ──
interface CategoryDeal {
  deal_id: number;
  deal_name: string;
  amount: string;
  created_at: string;
  sold_at: string | null;
  delivered_at: string | null;
}

function CategoryDealsList({ managerId, mode, categoryId, productGroupMode, period, segment }: {
  managerId: string; mode: 'manager' | 'department'; categoryId: string;
  productGroupMode: ProductGroupMode; period: DateRange; segment: CardSegment;
}) {
  const clientType = segment === 'fl' ? 'b2c' : segment === 'ul' ? 'b2b' : 'all';
  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  const params = new URLSearchParams({
    from: fromIso, to: toIso, scope: 'all', productGroupMode, productGroup: categoryId, clientType,
    ...(mode === 'manager' ? { managerId } : { teamId: managerId }),
  });
  const qs = params.toString();
  const { data, isLoading } = useQuery({
    queryKey: ['manager-card-category-deals', mode, managerId, categoryId, productGroupMode, fromIso, toIso, segment],
    queryFn: () => fetch(`/api/reports/deals?${qs}`).then(r => r.json()),
  });
  const deals: CategoryDeal[] = data?.deals ?? [];

  if (isLoading) {
    return <div className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">Загрузка…</div>;
  }
  if (deals.length === 0) {
    return <div className="px-4 py-2.5 text-xs text-[var(--color-text-muted)]">Нет сделок-отгрузок за период</div>;
  }
  const shown = deals.slice(0, 50);
  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] max-h-56 overflow-y-auto">
      {shown.map(d => (
        <div key={d.deal_id} className="flex items-center gap-2.5 px-4 py-1.5 text-[11.5px] border-b border-[var(--color-border)] last:border-b-0">
          <span className="text-[var(--color-text-muted)] tabular-nums w-11 shrink-0">
            {fmtDateShort(new Date(d.sold_at ?? d.delivered_at ?? d.created_at))}
          </span>
          <span className="flex-1 truncate text-[var(--color-text)]" title={d.deal_name}>{d.deal_name || '—'}</span>
          <span className="tabular-nums font-medium text-[var(--color-text)] shrink-0">{fmtMoney(Number(d.amount))}</span>
        </div>
      ))}
      {deals.length > 50 && (
        <div className="px-4 py-1.5 text-[11px] text-[var(--color-text-muted)]">Показаны первые 50 из {deals.length}</div>
      )}
    </div>
  );
}

// Карточка-секция страницы — единый шелл (тот же канон, что карточки «Сводной»).
function SectionCard({ title, right, children, className = '' }: {
  title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4 ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          {title && <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export interface ManagerCardPageProps {
  managerId: string;
  mode: 'manager' | 'department';
  managerName?: string;
  /** Начальный период из query (?from&to) — например, из отчёта; дефолт — текущий месяц. */
  initialFrom?: string;
  initialTo?: string;
  /** Бейджи (задача 2655): полка трофеев (менеджер) / «Моя команда» (РОП).
   *  true — собственный ЛК (/manager/me, своя полка через /api/badges/me).
   *  Доп. Серёги 31.07: в ЧУЖОЙ карточке менеджера (/manager/[id], showBadges
   *  не передан) полка тоже показывается — BadgeShelf с managerId (батч-роут);
   *  права не расширяются, карточка уже гейтится страницей (canViewManager). */
  showBadges?: boolean;
}

export function ManagerCardPage({ managerId, mode, managerName, initialFrom, initialTo, showBadges = false }: ManagerCardPageProps) {
  const [period, setPeriod] = useState<DateRange>(() => {
    if (initialFrom && initialTo) {
      const from = new Date(initialFrom);
      const to = new Date(initialTo);
      if (!isNaN(+from) && !isNaN(+to)) return { from, to };
    }
    const now = new Date();
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
  });
  const [comparisonPeriod, setComparisonPeriod] = useState<DateRange>(() => previousPeriodSameLength(period));
  const [segment, setSegment] = useState<CardSegment>('all');
  const [productGroupMode, setProductGroupMode] = useState<ProductGroupMode>('kc');
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  // Табы ЛК (доп. Серёги 31.07): Профиль · Статистика · Награды · Магазин.
  // Только mode='manager'; дефолт — «Профиль». Отделу/РОПу табы не нужны —
  // там нет одной личности, прежняя структура с «Моей командой» сохраняется.
  const [tab, setTab] = useState<ManagerTabKey>('profile');
  const tabbed = mode === 'manager';
  const showStats = !tabbed || tab === 'stats';

  function handlePeriodChange(p: DateRange) {
    setPeriod(p);
    setOpenCategoryId(null);
  }
  function handleComparisonChange(p: DateRange) {
    setComparisonPeriod(p);
    setOpenCategoryId(null);
  }
  useEffect(() => { setOpenCategoryId(null); }, [productGroupMode, segment]);

  const fromIso = period.from.toISOString();
  const toIso = period.to.toISOString();
  const cmpFromIso = comparisonPeriod.from.toISOString();
  const cmpToIso = comparisonPeriod.to.toISOString();

  const { data, isLoading, error } = useQuery({
    queryKey: ['manager-card', mode, managerId, fromIso, toIso, cmpFromIso, cmpToIso, segment, productGroupMode],
    queryFn: async () => {
      const url = mode === 'department' ? '/api/manager-card/department-card' : '/api/manager-card';
      const body = mode === 'department'
        ? { departmentId: managerId, period: { from: fromIso, to: toIso }, comparisonPeriod: { from: cmpFromIso, to: cmpToIso }, segment, productGroupMode }
        : { managerId, period: { from: fromIso, to: toIso }, comparisonPeriod: { from: cmpFromIso, to: cmpToIso }, segment, productGroupMode };
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? await res.text());
      // deptComparison приходит только с department-card; aggregateOf добавляет роут
      // (сколько отделов объединено) — см. respondAggregate там же.
      return res.json() as Promise<CardResponse>;
    },
    staleTime: 60_000,
  });

  const aggregateOf = data?.deptComparison?.aggregateOf ?? 1;

  const radarAxes: RadarAxisInput[] = (data?.radar.axes ?? []).map(a => ({
    key: a.key, label: a.label, periodValue: a.period.normalized, comparisonValue: a.comparison.normalized, dataAvailable: a.dataAvailable,
  }));
  const tiles = data?.tiles ?? [];

  const rating = data?.rating.value ?? null;
  const RING_R = 33;
  const CIRC = 2 * Math.PI * RING_R;
  const ringOffset = rating === null ? CIRC : CIRC * (1 - rating / 10);

  // «Копировать для отчёта» — BB-текст в стиле ежедневного отчёта владельца,
  // собирается из тех же план/факт-данных, что и полоса ниже (запрос общий).
  const { data: planFact } = usePlanFact(managerId, mode);
  const [copied, setCopied] = useState(false);
  function copyReport() {
    if (!planFact) return;
    const text = buildManagerReportText({
      name: data?.profile.name ?? managerName ?? `#${managerId}`,
      department: data?.profile.department,
      pf: planFact,
    });
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-[var(--color-negative)]">
        Ошибка: {error instanceof Error ? error.message : 'Не удалось загрузить карточку менеджера'}
      </div>
    );
  }

  return (
    // <main> в AppShell — overflow-hidden: страница сама несёт скролл-контейнер
    // (тот же паттерн, что SummaryPage). Ширина резиновая — без max-w (правка владельца).
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
    <div className="p-4 sm:p-6 w-full flex flex-col gap-4 sm:gap-5">
      {/* ── Табы ЛК (только карточка менеджера) ── */}
      {tabbed && <ManagerTabBar active={tab} onChange={setTab} />}

      {tabbed && tab === 'profile' && (
        <ProfileTab managerId={managerId} isSelf={showBadges} card={data} onGoRewards={() => setTab('rewards')} />
      )}
      {tabbed && tab === 'rewards' && <RewardsTab managerId={managerId} isSelf={showBadges} />}
      {tabbed && tab === 'shop' && <ShopTab managerId={managerId} isSelf={showBadges} />}

      {showStats && (<>
      {/* ── Hero ── */}
      <SectionCard className="!py-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 min-w-0">
            {/* Фото из Битрикса (PERSONAL_PHOTO, кэш manager_avatars) — тот же Avatar,
                что в профиле/сайдбаре: битая ссылка сама падает в инициалы. */}
            <Avatar name={data?.profile.name ?? managerName ?? '?'} url={data?.profile.avatarUrl} size={64} />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <h1 className="text-xl font-extrabold text-[var(--color-text)] truncate">{data?.profile.name ?? managerName ?? '…'}</h1>
                {data?.profile.login && <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">{data.profile.login}</span>}
              </div>
              {/* В режиме отдела имя отдела уже стоит в заголовке («Отдел: X») —
                  второй раз строкой ниже это был просто дубль (скрин владельца 30.07). */}
              <div className="mt-1 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap">
                {mode !== 'department' && data?.profile.department && <span>{data.profile.department}</span>}
                {mode !== 'department' && data?.profile.department && data?.profile.branch && <span>·</span>}
                {data?.profile.branch && <span>{data.profile.branch}</span>}
              </div>
            </div>
          </div>

          {/* На узком экране (375px, в т.ч. мобильный Битрикс) содержимое этого
              блока — кнопка + кольцо + ранги — суммарно ~505px: с shrink-0 и без
              переноса оно уезжало за край и ОБРЕЗАЛОСЬ, ранги были не видны вовсе.
              Поэтому на мобильном блок занимает всю ширину и переносится, а с sm —
              прежнее поведение (нерастяжимая группа справа). */}
          <div className="flex items-center gap-3 sm:gap-4 flex-wrap w-full sm:w-auto sm:shrink-0">
            <button
              onClick={copyReport}
              disabled={!planFact}
              className="tap-target flex items-center gap-2 px-3.5 py-2 text-sm font-semibold border border-[var(--color-border)] rounded-xl text-[var(--color-text)] hover:border-[var(--color-border-focus)] disabled:opacity-40 transition-colors"
              title="Скопировать отчёт по менеджеру (BB-код для чата Битрикса)"
            >
              {copied ? <Check size={15} className="text-[var(--color-positive,#2f9e44)]" /> : <Copy size={15} />}
              {copied ? 'Скопировано' : 'Копировать для отчёта'}
            </button>
            <div className="flex flex-col items-center gap-1">
              <div className="relative w-[78px] h-[78px]">
                <svg width={78} height={78} viewBox="0 0 78 78" className="-rotate-90">
                  <circle cx={39} cy={39} r={RING_R} fill="none" stroke="var(--color-border)" strokeWidth={7} />
                  <circle
                    cx={39} cy={39} r={RING_R} fill="none" stroke="var(--color-accent)" strokeWidth={7}
                    strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={ringOffset}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[22px] font-extrabold text-[var(--color-text)]">{rating !== null ? rating.toFixed(1) : '—'}</span>
                </div>
              </div>
              <span className="text-[11px] font-bold tracking-wide uppercase text-[var(--color-text-muted)]">Рейтинг</span>
            </div>
            {data?.ranks?.length ? (
              <div
                className="flex flex-col gap-1 rounded-2xl px-3 py-2"
                style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
              >
                {data.ranks.map(r => (
                  <div key={r.key} className="flex items-baseline gap-1.5 whitespace-nowrap">
                    <span className="text-[12px] font-extrabold text-[var(--color-accent)] min-w-[30px] text-right">{r.rank ? `#${r.rank}` : '—'}</span>
                    <span className="text-[10px] text-[var(--color-text-muted)]">из {r.size} {r.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="flex flex-col items-center gap-0.5 rounded-2xl px-3.5 py-2"
                style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
              >
                <span className="text-[13px] font-extrabold text-[var(--color-accent)]">{data?.rating.rank ? `#${data.rating.rank}` : '—'}</span>
                <span className="text-[10px] text-[var(--color-text-muted)] text-center leading-tight">из {data?.rating.deptSize ?? '—'}<br />{mode === 'department' ? 'среди отделов' : 'в отделе'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Фильтры — общие для всех секций страницы */}
        <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center gap-2.5 flex-wrap">
          <PeriodRangeControls
            period={period}
            comparison={comparisonPeriod}
            onPeriodChange={handlePeriodChange}
            onComparisonChange={handleComparisonChange}
            manualComparisonFn={previousPeriodSameLength}
          />
          <div className="w-px h-5 bg-[var(--color-border)]" />
          <ChipGroup
            value={segment}
            onChange={setSegment}
            options={[
              { key: 'all', label: 'Все' },
              { key: 'fl', label: 'Физики' },
              { key: 'ul', label: 'Юрики' },
            ]}
          />
        </div>
      </SectionCard>

      {/* ── План/факт «прямо сейчас»: Сегодня · Неделя · Месяц (не зависит от фильтров) ── */}
      <PlanFactStrip managerId={managerId} mode={mode} />

      {/* ── Бейджи (задача 2655): у менеджера полка переехала в таб «Награды»
          (табы ЛК, доп. Серёги 31.07); у РОПа-департамента — по-прежнему своя
          полка + «Моя команда» с полками подчинённых (managed-depts). ── */}
      {showBadges && mode === 'department' && (<><BadgeShelf compactIfEmpty /><TeamBadgesBlock /></>)}

      {isLoading ? (
        <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 bg-[var(--color-border)] rounded-2xl animate-pulse" />)}</div>
      ) : (
        <>
          {/* ── Профиль эффективности: шестиугольник + плитки ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 sm:gap-5">
            <SectionCard title={`Профиль эффективности · ${radarAxes.length || 6} метрик`}>
              <div className="flex justify-center overflow-x-auto py-2">
                <ManagerCardRadar axes={radarAxes} />
              </div>
              {/* Честная оговорка (задача 30.07): объединение нескольких отделов
                  сравнивается с одиночными отделами компании. По относительным осям
                  (конверсии, средний чек, скорость) это корректно, а по абсолютным
                  сумма объединения закономерно выше — чтобы высокая оценка по ним не
                  читалась как заслуга, говорим об этом прямо. */}
              {aggregateOf > 1 && (
                <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
                  Объединено отделов: {aggregateOf}. Сравнение идёт с отдельными отделами
                  компании: по конверсиям и средним — корректно, по суммарным
                  показателям объединение закономерно выше, тут оценка условная.
                </p>
              )}
            </SectionCard>

            <SectionCard title="Итоги за период · к прошлому периоду">
              <div className="overflow-x-auto">
                <div className="grid grid-cols-2 gap-2.5 min-w-[260px]">
                  {tiles.length === 0 ? (
                    <div className="col-span-full text-sm text-[var(--color-text-muted)] py-2">Плитки не выбраны в шаблоне карточки</div>
                  ) : tiles.map(t => (
                    <Tile key={t.key} value={fmtByUnit(t.current, t.unit)} label={t.label} deltaPct={t.deltaPct} />
                  ))}
                </div>
              </div>
              {data?.calls && (
                <div className="mt-3 rounded-xl px-4 py-3 text-[12.5px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap"
                     style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' }}>
                  Звонки за период: <b className="text-[var(--color-text)]">{fmtInt(data.calls.count)}</b>
                  <span>· средний разговор <b className="text-[var(--color-text)]">{fmtDuration(data.calls.avgDurationSec)}</b></span>
                  <span>· первое касание <b className="text-[var(--color-text)]">{fmtMinutes(data.calls.medianFirstTouchMinutes)}</b></span>
                </div>
              )}
            </SectionCard>
          </div>

          {/* ── Товарные категории ── */}
          <SectionCard
            title="По товарным категориям · топ-5"
            right={
              <ChipGroup
                value={productGroupMode}
                onChange={setProductGroupMode}
                options={[
                  { key: 'kc', label: 'Категория КЦ' },
                  { key: 'by_max', label: 'По наибольшему' },
                ]}
              />
            }
          >
            <div className="border border-[var(--color-border)] rounded-2xl px-4 py-1 overflow-hidden">
              {(data?.categories.length ?? 0) === 0 ? (
                <div className="py-3 text-sm text-[var(--color-text-muted)]">Нет продаж за период</div>
              ) : data!.categories.map((c, i) => {
                const isOpen = openCategoryId === c.id;
                return (
                  <div key={c.id} className={i > 0 ? 'border-t border-[var(--color-border)]' : ''}>
                    <button
                      type="button"
                      onClick={() => setOpenCategoryId(isOpen ? null : c.id)}
                      className="w-full flex items-center gap-2.5 py-2 text-left hover:bg-[var(--color-bg-hover)] transition-colors -mx-4 px-4"
                      title="Показать сделки-отгрузки этой группы за период"
                    >
                      <span className="text-[12.5px] text-[var(--color-text)] w-28 shrink-0 truncate" title={c.name}>{c.name}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-[var(--color-border)] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, c.share)}%`, backgroundColor: 'var(--color-accent)', opacity: Math.max(0.4, 1 - i * 0.15) }}
                        />
                      </div>
                      <span className="text-[12.5px] font-bold text-[var(--color-text)] w-10 text-right shrink-0">{c.share.toFixed(0)}%</span>
                    </button>
                    {isOpen && (
                      <div className="-mx-4">
                        <CategoryDealsList
                          managerId={managerId} mode={mode} categoryId={c.id}
                          productGroupMode={productGroupMode} period={period} segment={segment}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </SectionCard>

          {/* ── Динамика продаж за выбранный период ── */}
          <SectionCard title="Динамика продаж за период">
            <ManagerDailySalesCard managerId={managerId} mode={mode} period={period} segment={segment} />
          </SectionCard>

          {/* ── График работы (только менеджер: у отдела нет единого профиля активности) ── */}
          {mode === 'manager' && (
            <SectionCard title="График работы">
              <div className="max-w-2xl">
                <ManagerActivityTab managerId={managerId} />
              </div>
            </SectionCard>
          )}
        </>
      )}
      </>)}
    </div>
    </div>
  );
}
