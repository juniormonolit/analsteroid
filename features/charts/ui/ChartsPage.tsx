'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endOfDay } from 'date-fns';
import { MainPeriodControl, DepartmentPicker, ProductGroupPicker, type ProductGroupOption } from '@/features/reports/ui/FilterBar';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { useAccountDepartments } from '@/lib/hooks/useAccountDepartments';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';
import type { SurvivalPreset, SurvivalResult, SurvivalBucket, CalledToSaleCohortResult, CalledToSaleCohortPoint } from '../engine/types';
import { SurvivalChart } from './SurvivalChart';
import { CalledToSaleCohortChart } from './CalledToSaleCohortChart';
import { ConstructorSection } from './ConstructorSection';
import { ChartDrilldownPanel, type ChartDrilldownTarget } from './ChartDrilldownPanel';

// Раздел «Графики» (задача владельца 28.07). Два режима:
//  * «Вероятность продажи» (дефолт) — кастомные кривые владельца: CR в продажу от
//    числа дней в стадии «Созвонился и озвучил цены» и в WORK-стадиях. Вопрос,
//    на который отвечает вкладка: «где вероятность продать реально падает».
//  * «Конструктор» — любые метрики каталога на осях поверх /api/reports/run.
type Tab = 'survival' | 'constructor';

// Старт сбора истории стадий (sa.deal_events) — раньше этой даты корзин не из чего
// строить. Значение = DEAL_EVENTS_DATA_START движка (серверная константа, сюда
// продублирована литералом: тянуть серверный модуль в клиент нельзя).
const EVENTS_START = new Date('2026-04-03T00:00:00');

function defaultSurvivalPeriod(): DateRange {
  return { from: EVENTS_START, to: endOfDay(new Date()) };
}

function SurvivalCard({
  preset, title, subtitle, period, dealScope, clientType, departmentIds, departmentsReady,
  productGroupMode, productGroupIds, amountFrom, amountTo, onDrilldown,
}: {
  preset: SurvivalPreset;
  title: string;
  subtitle: string;
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
  amountFrom?: number;
  amountTo?: number;
  onDrilldown: (target: ChartDrilldownTarget) => void;
}) {
  const { data, isLoading, isError } = useQuery<{ result: SurvivalResult | null }>({
    queryKey: ['stage-survival', preset, period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds, amountFrom, amountTo],
    queryFn: async () => {
      const res = await fetch('/api/charts/stage-survival', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset, period: { from: period.from, to: period.to }, dealScope, clientType, departmentIds,
          productGroupMode, productGroupIds, amountFrom, amountTo,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: departmentsReady,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const r = data?.result ?? null;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-0.5 mb-3 text-xs text-[var(--color-text-muted)]">{subtitle}</p>

      {isLoading || (!isError && data === undefined) ? (
        <div className="h-[240px] rounded-lg bg-[var(--color-border)] animate-pulse" />
      ) : isError ? (
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить график.</p>
      ) : !r ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Выбранный период целиком раньше 03.04.2026 — история стадий ещё не велась.
        </p>
      ) : r.cohortTotal === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет сделок под выбранные фильтры.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-[var(--color-text-muted)]">
            <span>Когорта: <b className="text-[var(--color-text)]">{r.cohortTotal.toLocaleString('ru-RU')}</b></span>
            <span>Продано: <b className="text-[var(--color-text)]">{r.soldTotal.toLocaleString('ru-RU')}</b></span>
            <span>CR общий: <b className="text-[var(--color-text)]">{r.overallPct === null ? '—' : `${r.overallPct}%`}</b></span>
            <span>Ещё в стадии: <b className="text-[var(--color-text)]">{r.stillInStage.toLocaleString('ru-RU')}</b></span>
          </div>
          <SurvivalChart
            buckets={r.buckets}
            onBucketClick={(bucket: SurvivalBucket) => onDrilldown({
              title: `${preset === 'priced' ? 'Дней в стадии' : 'Дней в работе'}: ${bucket.label}`,
              subtitle: title,
              allCount: bucket.total,
              soldCount: bucket.sold,
              request: {
                endpoint: '/api/charts/stage-survival/deals',
                baseBody: { preset, bucketLabel: bucket.label },
                period, dealScope, clientType, productGroupMode, productGroupIds, departmentIds,
                amountFrom, amountTo,
              },
            })}
          />
        </>
      )}
    </section>
  );
}

// Третий, четвёртый и пятый кастомные графики — все «life table» когорты дней
// (тот же визуальный язык, что CalledToSaleCohortChart.tsx): серые столбики
// «дожили минимум N дней, не продав раньше», линия «продано ровно на день N».
// Один компонент на все три — параметризован эндпоинтом/заголовком/подписью,
// чтобы не копировать карточку целиком (задача 2553, владелец: «не копируй
// логику дважды, если можно вынести общее»).
//  * «Созвонился → продажа по дням» (задача 2533, 29.07) — день = календарные
//    дни от входа в стадию «Созвонился и озвучил цены» до продажи.
//  * «В работе → продажа по дням» (задача 2553, 29.07 — скриншот ВТОРОГО
//    графика с подписью «по аналогии с третьим добавь ещё»): та же когорта и
//    те же «дни», что у SurvivalCard preset="work" выше (накопленное время в
//    WORK-стадиях), но в подаче life table вместо бакетов/CR%. Добавлен РЯДОМ
//    со вторым графиком, не вместо него.
//  * «В работе (без брони/подтв.) → продажа по дням» (задачи 2574/2599): та же
//    когорта, «день» — накопленное время в WORK-стадиях БЕЗ интервалов
//    reserved/confirmed. Подача менялась 4 раза (историю версий см.
//    engine/workExclReservedCohort.ts); v4 (2599) — снова одна линия life
//    table, как у 3-го/4-го, плюс разбивка тултипа по kc-группам (groups в
//    точках — рисует CohortTooltip по наличию).
interface LifeTableCardConfig {
  fetchUrl: string;
  dealsUrl: '/api/charts/called-to-sale-cohort/deals' | '/api/charts/work-days-cohort/deals' | '/api/charts/work-excl-reserved-cohort/deals';
  queryKeyPrefix: string;
  title: string;
  description: string;
  accent: string;
  axisLabel: string;
}

function LifeTableCard({
  config, period, dealScope, clientType, departmentIds, departmentsReady,
  productGroupMode, productGroupIds, amountFrom, amountTo, onDrilldown,
}: {
  config: LifeTableCardConfig;
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
  amountFrom?: number;
  amountTo?: number;
  onDrilldown: (target: ChartDrilldownTarget) => void;
}) {
  const { data, isLoading, isError } = useQuery<{ result: CalledToSaleCohortResult | null }>({
    queryKey: [config.queryKeyPrefix, period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds, amountFrom, amountTo],
    queryFn: async () => {
      const res = await fetch(config.fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: { from: period.from, to: period.to }, dealScope, clientType, departmentIds,
          productGroupMode, productGroupIds, amountFrom, amountTo,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: departmentsReady,
    staleTime: 2 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const r = data?.result ?? null;

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{config.title}</h2>
      <p className="mt-0.5 mb-3 text-xs text-[var(--color-text-muted)]">{config.description}</p>

      {isLoading || (!isError && data === undefined) ? (
        <div className="h-[240px] rounded-lg bg-[var(--color-border)] animate-pulse" />
      ) : isError ? (
        <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить график.</p>
      ) : !r ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          Выбранный период целиком раньше 03.04.2026 — история стадий ещё не велась.
        </p>
      ) : r.cohortTotal === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет сделок под выбранные фильтры.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs text-[var(--color-text-muted)]">
            <span>Когорта: <b className="text-[var(--color-text)]">{r.cohortTotal.toLocaleString('ru-RU')}</b></span>
            <span>Продано: <b className="text-[var(--color-text)]">{r.soldTotal.toLocaleString('ru-RU')}</b></span>
            <span>CR общий: <b className="text-[var(--color-text)]">{r.overallPct === null ? '—' : `${r.overallPct}%`}</b></span>
          </div>
          <CalledToSaleCohortChart
            points={r.points} accent={config.accent} axisLabel={config.axisLabel}
            onPointClick={(point: CalledToSaleCohortPoint) => onDrilldown({
              title: `День ${point.label}`,
              subtitle: config.title,
              allCount: point.cohort,
              soldCount: point.sold,
              request: {
                endpoint: config.dealsUrl,
                baseBody: { day: point.day },
                period, dealScope, clientType, productGroupMode, productGroupIds, departmentIds,
                amountFrom, amountTo,
              },
            })}
          />
        </>
      )}
    </section>
  );
}

const CALLED_TO_SALE_CONFIG: LifeTableCardConfig = {
  fetchUrl: '/api/charts/called-to-sale-cohort',
  dealsUrl: '/api/charts/called-to-sale-cohort/deals',
  queryKeyPrefix: 'called-to-sale-cohort',
  title: 'Когорта «Созвонился → продажа по дням»',
  description: 'Сделки, впервые вошедшие в стадию «Созвонился и озвучил цены» в выбранный период. День считается от входа '
    + 'в стадию до фактической продажи (sold_at) — не до выхода из стадии. Серые столбики — сколько сделок '
    + '«дожили» минимум N дней, не продав раньше; линия — сколько из них продалось ровно на день N.',
  accent: '#10b981',
  axisLabel: 'дней от входа в «Созвонился и озвучил цены» до продажи',
};

// Задача 2553 (29.07): владелец прислал скриншот второго графика («Вероятность
// продажи от дней в работе, стадии WORK») с подписью «по аналогии с третьим
// добавь ещё». Когорта та же, что у SurvivalCard preset="work" (сделки,
// впервые вошедшие в любую WORK-стадию), «день» — то же накопленное время в
// WORK-стадиях, что и ось X там (см. workDaysCohort.ts) — НЕ календарные дни,
// как у соседа выше.
const WORK_DAYS_CONFIG: LifeTableCardConfig = {
  fetchUrl: '/api/charts/work-days-cohort',
  dealsUrl: '/api/charts/work-days-cohort/deals',
  queryKeyPrefix: 'work-days-cohort',
  title: 'Когорта «В работе → продажа по дням»',
  description: 'Сделки, впервые вошедшие в любую WORK-стадию в выбранный период (та же когорта, что у графика '
    + '«…от дней в работе» выше). День — накопленное время во всех WORK-стадиях (не календарные дни — сделка могла '
    + 'выходить из работы и возвращаться). Серые столбики — сколько сделок «дожили» минимум N дней в работе, не '
    + 'продав раньше; линия — сколько из них продалось ровно на день N.',
  accent: '#f59e0b',
  axisLabel: 'дней в работе (накопленное время в WORK-стадиях)',
};

// Пятый график, v4 (задача 2599, 30.07 — владелец про v3 с тремя линиями:
// «переделай в 1 линию и он должен отражать не кол-во сделок, а конверсию.
// То есть аналогично этим двум графикам»): вернулся к общей LifeTableCard-форме
// 3-го/4-го. Отличия от WORK_DAYS_CONFIG — только ось дней (накопленное время
// в работе БЕЗ интервалов reserved/confirmed) и разбивка тултипа по kc-группам
// (движок кладёт groups в точки, CohortTooltip рисует по наличию).
const WORK_EXCL_RESERVED_CONFIG: LifeTableCardConfig = {
  fetchUrl: '/api/charts/work-excl-reserved-cohort',
  dealsUrl: '/api/charts/work-excl-reserved-cohort/deals',
  queryKeyPrefix: 'work-excl-reserved-cohort',
  title: 'Когорта «В работе (без брони/подтв.) → продажа по дням»',
  description: 'Та же когорта, что у графика «…в работе (WORK)» выше — сделки, впервые вошедшие в любую WORK-стадию. '
    + 'День — накопленное время в работе БЕЗ интервалов «Забронировано»/«Подтверждённая бронь» (event_type '
    + 'reserved/confirmed). Серые столбики — сколько сделок «дожили» минимум N дней, не продав раньше; линия — '
    + 'сколько из них продалось ровно на день N. В подсказке — разбивка проданных дня по группам «Категории КЦ».',
  accent: '#8b5cf6',
  axisLabel: 'дней в работе (без брони и подтверждения)',
};

export function ChartsPage() {
  const [tab, setTab] = useState<Tab>('survival');
  const [period, setPeriod] = useState<DateRange>(defaultSurvivalPeriod);
  // Сравнение графикам не нужно, но MainPeriodControl при клике по пресету зовёт
  // onComparisonChange — принимаем и игнорируем.
  const [dealScope, setDealScope] = useState<DealScope>('primary'); // дефолт владельца: первичные
  const [clientType, setClientType] = useState<ClientType>('all');
  const { departmentIds, ready: departmentsReady, setDepartmentIds } = useAccountDepartments();

  // Фильтр товарных групп (задача 29.07, дословно владельца: «Добавь к графикам
  // фильтр по товарным группам»). Шкала — дефолт СТРОГО 'kc' (тот же дефолт, что
  // у SalesReportPage.tsx), применяется к ОБЕИМ вкладкам. Переключение шкалы
  // сбрасывает выбранные группы — kc/by_max несовместимы, маппинга между ними в
  // БД нет (см. бриф задачи).
  const [productGroupMode, setProductGroupMode] = useState<ProductGroupMode>('kc');
  const [productGroupIds, setProductGroupIds] = useState<string[]>([]);

  // Фильтр «Чек от/до» по сумме сделки d.amount (задача 30.07, владелец:
  // «фильтр по сумме сделки, чтобы можно было выставить "Чек От или до"»).
  // Черновик (строки в инпутах) отделён от применённых чисел: применяем по
  // blur/Enter, а не на каждый ввод символа — каждый refetch здесь = тяжёлые
  // когорты по deal_events. from > to — мягкая подсветка, не применяем и не
  // роняем страницу (границы остаются прежними).
  const [amountFromStr, setAmountFromStr] = useState('');
  const [amountToStr, setAmountToStr] = useState('');
  const [amountFrom, setAmountFrom] = useState<number | undefined>(undefined);
  const [amountTo, setAmountTo] = useState<number | undefined>(undefined);
  const draftFrom = amountFromStr.trim() === '' ? undefined : Number(amountFromStr.replace(',', '.'));
  const draftTo = amountToStr.trim() === '' ? undefined : Number(amountToStr.replace(',', '.'));
  const amountInvalid =
    (draftFrom !== undefined && (!Number.isFinite(draftFrom) || draftFrom < 0)) ||
    (draftTo !== undefined && (!Number.isFinite(draftTo) || draftTo < 0)) ||
    (draftFrom !== undefined && draftTo !== undefined && Number.isFinite(draftFrom) && Number.isFinite(draftTo) && draftFrom > draftTo);
  const applyAmount = () => {
    if (amountInvalid) return; // невалидный диапазон не применяем
    setAmountFrom(draftFrom !== undefined && Number.isFinite(draftFrom) ? draftFrom : undefined);
    setAmountTo(draftTo !== undefined && Number.isFinite(draftTo) ? draftTo : undefined);
  };

  // Дрилл-даун списка сделок по клику на когорту (задача 2546, владелец 29.07) —
  // одна панель на все три кривые, открывается целью, которую собирает
  // SurvivalCard/LifeTableCard в onDrilldown ниже.
  const [drilldown, setDrilldown] = useState<ChartDrilldownTarget | null>(null);

  const { data: pgCatalog, isLoading: pgCatalogLoading } = useQuery<{ groups: ProductGroupOption[] }>({
    queryKey: ['catalog/product-groups', productGroupMode],
    queryFn: async () => {
      const res = await fetch(`/api/catalog/product-groups?mode=${productGroupMode}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    // Страница живёт внутри <main className="flex-1 overflow-hidden ...">
    // (components/layout/AppShell.tsx) — overflow-hidden там блокирует колёсико/тач,
    // поэтому страница обязана сама открыть свою скролл-область (как home/page.tsx,
    // metrics/page.tsx и т.д.). До третьего графика (задача 2533, 29.07) контент
    // всегда помещался по высоте и без этого — баг был скрыт, а не отсутствовал.
    <div className="h-full overflow-y-auto overflow-x-hidden">
    <div className="p-3 sm:p-6 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Графики</h1>
        <Seg<Tab>
          options={['survival', 'constructor']}
          value={tab}
          onChange={setTab}
          labels={{ survival: 'Вероятность продажи', constructor: 'Конструктор' }}
        />
      </div>

      {/* общие фильтры (как в отчётах: период, отделы, воронка, тип клиента, товарные группы) */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <MainPeriodControl period={period} onPeriodChange={setPeriod} onComparisonChange={() => {}} />
        <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={setDepartmentIds} />
        <Seg<DealScope>
          options={['primary', 'repeat', 'all']}
          value={dealScope}
          onChange={setDealScope}
          labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
        />
        <Seg<ClientType>
          options={['all', 'b2c', 'b2b']}
          value={clientType}
          onChange={setClientType}
          labels={{ all: 'Все клиенты', b2c: 'B2C', b2b: 'B2B' }}
        />
        <Seg<ProductGroupMode>
          options={['kc', 'by_max']}
          value={productGroupMode}
          onChange={m => { setProductGroupMode(m); setProductGroupIds([]); }}
          labels={{ kc: 'Категория КЦ', by_max: 'По наибольшему' }}
        />
        <ProductGroupPicker
          productGroupIds={productGroupIds}
          onProductGroupIdsChange={setProductGroupIds}
          options={pgCatalog?.groups ?? []}
          loading={pgCatalogLoading}
        />
        {tab === 'survival' && (
          <div
            className={`flex items-center gap-1.5 border rounded-lg px-2 py-1 text-sm bg-[var(--color-bg-surface)] ${amountInvalid ? 'border-[var(--color-negative)]' : 'border-[var(--color-border)]'}`}
            title={amountInvalid ? '«Чек от» больше, чем «до» — фильтр не применён' : 'Фильтр по сумме сделки (d.amount). Применяется по Enter или уходу из поля.'}
          >
            <span className="text-[var(--color-text-muted)] text-xs whitespace-nowrap">Чек от</span>
            <input
              inputMode="numeric"
              value={amountFromStr}
              onChange={e => setAmountFromStr(e.target.value)}
              onBlur={applyAmount}
              onKeyDown={e => { if (e.key === 'Enter') applyAmount(); }}
              placeholder="0"
              className="w-20 bg-transparent outline-none text-[var(--color-text)] tabular-nums placeholder:text-[var(--color-text-muted)]"
              aria-label="Чек от"
              aria-invalid={amountInvalid || undefined}
            />
            <span className="text-[var(--color-text-muted)] text-xs">до</span>
            <input
              inputMode="numeric"
              value={amountToStr}
              onChange={e => setAmountToStr(e.target.value)}
              onBlur={applyAmount}
              onKeyDown={e => { if (e.key === 'Enter') applyAmount(); }}
              placeholder="∞"
              className="w-20 bg-transparent outline-none text-[var(--color-text)] tabular-nums placeholder:text-[var(--color-text-muted)]"
              aria-label="Чек до"
              aria-invalid={amountInvalid || undefined}
            />
            {(amountFrom !== undefined || amountTo !== undefined) && (
              <button
                onClick={() => { setAmountFromStr(''); setAmountToStr(''); setAmountFrom(undefined); setAmountTo(undefined); }}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-0.5"
                aria-label="Сбросить фильтр по сумме"
              >×</button>
            )}
          </div>
        )}
      </div>

      {tab === 'survival' ? (
        <>
          {/* Кастомные кривые — одна ПОД другой на всю ширину (правка владельца 29.07:
              в две колонки графики мельчили, «чтобы было хорошо видно»). */}
          <div className="flex flex-col gap-4">
            <SurvivalCard
              preset="priced"
              title="Вероятность продажи от дней в «Созвонился и озвучил цены»"
              subtitle="Сделки, впервые вошедшие в стадию в выбранный период. Дни — от входа до перехода в другую стадию (или до сегодня, если сделка ещё там). CR — доля дошедших до продажи."
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              amountFrom={amountFrom} amountTo={amountTo}
              onDrilldown={setDrilldown}
            />
            <SurvivalCard
              preset="work"
              title="Вероятность продажи от дней в работе (стадии WORK)"
              subtitle="Сделки, впервые вошедшие в любую WORK-стадию в выбранный период. Дни — суммарное время во всех стадиях с разметкой WORK до продажи/отгрузки (стадии «Продано»/«Отгружено» не считаются, хотя тоже размечены WORK). CR — доля дошедших до продажи."
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              amountFrom={amountFrom} amountTo={amountTo}
              onDrilldown={setDrilldown}
            />
            {/* Пятый график (задачи 2574/2599, история версий — в
                engine/workExclReservedCohort.ts). v4: одна линия life table,
                как у 3-го/4-го, + разбивка тултипа по kc-группам. Та же
                когорта/шкала дней, что у графика «…в работе (WORK)» выше. */}
            <LifeTableCard
              config={WORK_EXCL_RESERVED_CONFIG}
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              amountFrom={amountFrom} amountTo={amountTo}
              onDrilldown={setDrilldown}
            />
            {/* Четвёртый график (задача 2553, 29.07) — сразу под своим «источником»
                (SurvivalCard preset="work" выше): та же WORK-когорта, подача life table. */}
            <LifeTableCard
              config={WORK_DAYS_CONFIG}
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              amountFrom={amountFrom} amountTo={amountTo}
              onDrilldown={setDrilldown}
            />
            <LifeTableCard
              config={CALLED_TO_SALE_CONFIG}
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              amountFrom={amountFrom} amountTo={amountTo}
              onDrilldown={setDrilldown}
            />
          </div>
          <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">
            История стадий ведётся с 03.04.2026 — периоды раньше не дадут данных. Сделки, которые ещё
            не вышли из стадии, учитываются с «днями по сегодня» — у свежих когорт хвост кривой занижен.
          </p>
        </>
      ) : (
        <ConstructorSection
          period={period}
          dealScope={dealScope}
          clientType={clientType}
          departmentIds={departmentIds}
          departmentsReady={departmentsReady}
          onApplyPageFilters={cfg => {
            // Загрузка сохранённого графика восстанавливает и пилюли страницы —
            // без них график «не тот» (сохранённые «первичные» на пилюле «все»
            // дали бы другие числа). Период не сохраняется сознательно.
            if (cfg.dealScope === 'primary' || cfg.dealScope === 'repeat' || cfg.dealScope === 'all') setDealScope(cfg.dealScope);
            if (cfg.clientType === 'all' || cfg.clientType === 'b2c' || cfg.clientType === 'b2b') setClientType(cfg.clientType);
            if (cfg.productGroupMode === 'kc' || cfg.productGroupMode === 'by_max') {
              setProductGroupMode(cfg.productGroupMode);
              setProductGroupIds(cfg.productGroupIds ?? []);
            }
          }}
          productGroupMode={productGroupMode}
          productGroupIds={productGroupIds}
        />
      )}
      {drilldown && <ChartDrilldownPanel target={drilldown} onClose={() => setDrilldown(null)} />}
    </div>
    </div>
  );
}
