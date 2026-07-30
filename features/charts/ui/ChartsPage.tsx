'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endOfDay } from 'date-fns';
import { MainPeriodControl, DepartmentPicker, ProductGroupPicker, type ProductGroupOption } from '@/features/reports/ui/FilterBar';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { useAccountDepartments } from '@/lib/hooks/useAccountDepartments';
import type { DateRange } from '@/lib/period';
import type { DealScope, ClientType, ProductGroupMode } from '@/lib/metrics/types';
import type { SurvivalPreset, SurvivalResult, SurvivalBucket, CalledToSaleCohortResult, CalledToSaleCohortPoint, MilestoneCohortResult, MilestoneCohortPoint } from '../engine/types';
import { SurvivalChart } from './SurvivalChart';
import { CalledToSaleCohortChart } from './CalledToSaleCohortChart';
import { MilestoneCohortChart } from './MilestoneCohortChart';
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
  productGroupMode, productGroupIds, onDrilldown,
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
  onDrilldown: (target: ChartDrilldownTarget) => void;
}) {
  const { data, isLoading, isError } = useQuery<{ result: SurvivalResult | null }>({
    queryKey: ['stage-survival', preset, period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds],
    queryFn: async () => {
      const res = await fetch('/api/charts/stage-survival', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset, period: { from: period.from, to: period.to }, dealScope, clientType, departmentIds,
          productGroupMode, productGroupIds,
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
//  * «В работе (без брони/подтв.) → продажа по дням» (задача 2574, доработка
//    29.07): та же когорта, что у графика выше, «день» — накопленное время в
//    WORK-стадиях БЕЗ интервалов reserved/confirmed. Первая версия (28.07)
//    была в подаче бакетов/CR% (как SurvivalCard) — владелец посмотрел и
//    попросил переделать «по аналогии с 3 и 4, то есть от общего количества
//    сделок» — заменили подачу на life table, это НЕ шестой график.
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
  productGroupMode, productGroupIds, onDrilldown,
}: {
  config: LifeTableCardConfig;
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
  onDrilldown: (target: ChartDrilldownTarget) => void;
}) {
  const { data, isLoading, isError } = useQuery<{ result: CalledToSaleCohortResult | null }>({
    queryKey: [config.queryKeyPrefix, period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds],
    queryFn: async () => {
      const res = await fetch(config.fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: { from: period.from, to: period.to }, dealScope, clientType, departmentIds,
          productGroupMode, productGroupIds,
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
              },
            })}
          />
        </>
      )}
    </section>
  );
}

// Пятый график, ТРЕТЬЯ версия подачи (задача 2574, доработка 30.07): вместо
// одной линии life table — три (бронь/продажа/отгрузка), собственный компонент
// (MilestoneCohortChart), не переиспользует LifeTableCard целиком (разная
// форма ответа/чарта), но фильтры/загрузка/каркас карточки — тот же паттерн.
function MilestoneCard({
  period, dealScope, clientType, departmentIds, departmentsReady,
  productGroupMode, productGroupIds, onDrilldown,
}: {
  period: DateRange;
  dealScope: DealScope;
  clientType: ClientType;
  departmentIds: string[];
  departmentsReady: boolean;
  productGroupMode: ProductGroupMode;
  productGroupIds: string[];
  onDrilldown: (target: ChartDrilldownTarget) => void;
}) {
  const { data, isLoading, isError } = useQuery<{ result: MilestoneCohortResult | null }>({
    queryKey: ['work-excl-reserved-cohort', period, dealScope, clientType, departmentIds, productGroupMode, productGroupIds],
    queryFn: async () => {
      const res = await fetch('/api/charts/work-excl-reserved-cohort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period: { from: period.from, to: period.to }, dealScope, clientType, departmentIds,
          productGroupMode, productGroupIds,
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
  const title = 'Когорта «В работе (без брони/подтв.) → бронь / продажа / отгрузка по дням»';

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-5">
      <h2 className="text-sm font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-0.5 mb-3 text-xs text-[var(--color-text-muted)]">
        Та же когорта, что у графика «…в работе (WORK)» и когорты «В работе → продажа по дням» выше — сделки,
        впервые вошедшие в любую WORK-стадию. День — накопленное время в работе БЕЗ интервалов «Забронировано»/
        «Подтверждённая бронь» (event_type reserved/confirmed). Три линии показывают, на какой день сделка обычно
        уходит в бронь, в продажу или в отгрузку — сделка, как правило, попадает на все три линии, но в РАЗНЫЕ
        дни (сначала бронь, потом продажа, потом отгрузка), поэтому линии не складываются в размер когорты и друг
        из друга не вычитаются.
      </p>

      {isLoading || (!isError && data === undefined) ? (
        <div className="h-[280px] rounded-lg bg-[var(--color-border)] animate-pulse" />
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
            <span>Ушли в бронь: <b className="text-[var(--color-text)]">{r.reservedTotal.toLocaleString('ru-RU')}</b></span>
            <span>Ушли в продажу: <b className="text-[var(--color-text)]">{r.soldTotal.toLocaleString('ru-RU')}</b></span>
            <span>Ушли в отгрузку: <b className="text-[var(--color-text)]">{r.shippedTotal.toLocaleString('ru-RU')}</b></span>
          </div>
          <MilestoneCohortChart
            points={r.points}
            axisLabel="дней в работе (без брони и подтверждения)"
            onPointClick={(point: MilestoneCohortPoint) => onDrilldown({
              title: `День ${point.label}`,
              subtitle: title,
              options: [
                { key: 'all', label: 'Все (дожили)', count: point.cohort },
                { key: 'reserved', label: 'Бронь', count: point.reserved },
                { key: 'sold', label: 'Продажа', count: point.sold },
                { key: 'shipped', label: 'Отгрузка', count: point.shipped },
              ],
              request: {
                endpoint: '/api/charts/work-excl-reserved-cohort/deals',
                baseBody: { day: point.day },
                period, dealScope, clientType, productGroupMode, productGroupIds, departmentIds,
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
    <div className="h-full overflow-y-auto">
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
              onDrilldown={setDrilldown}
            />
            <SurvivalCard
              preset="work"
              title="Вероятность продажи от дней в работе (стадии WORK)"
              subtitle="Сделки, впервые вошедшие в любую WORK-стадию в выбранный период. Дни — суммарное время во всех стадиях с разметкой WORK до продажи/отгрузки (стадии «Продано»/«Отгружено» не считаются, хотя тоже размечены WORK). CR — доля дошедших до продажи."
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              onDrilldown={setDrilldown}
            />
            {/* Пятый график (задача 2574). v2 (29.07): владелец попросил подачу
                «по аналогии с 3 и 4, то есть от общего количества сделок» —
                life table вместо бакетов/CR%. v3 (30.07, ДО показа v2): владелец
                дополнил — показать не только продажу, но и бронь/отгрузку, три
                линии вместо одной, чтобы видеть «с какого дня шансы сдвинуть
                сделку куда-либо становятся ничтожными». Та же когорта/шкала
                дней, что у графика «…в работе (WORK)» выше. */}
            <MilestoneCard
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              onDrilldown={setDrilldown}
            />
            {/* Четвёртый график (задача 2553, 29.07) — сразу под своим «источником»
                (SurvivalCard preset="work" выше): та же WORK-когорта, подача life table. */}
            <LifeTableCard
              config={WORK_DAYS_CONFIG}
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
              onDrilldown={setDrilldown}
            />
            <LifeTableCard
              config={CALLED_TO_SALE_CONFIG}
              period={period} dealScope={dealScope} clientType={clientType}
              departmentIds={departmentIds} departmentsReady={departmentsReady}
              productGroupMode={productGroupMode} productGroupIds={productGroupIds}
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
          productGroupMode={productGroupMode}
          productGroupIds={productGroupIds}
        />
      )}
      {drilldown && <ChartDrilldownPanel target={drilldown} onClose={() => setDrilldown(null)} />}
    </div>
    </div>
  );
}
