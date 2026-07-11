'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { previousPeriodSameLength, type DateRange } from '@/lib/period';
import type { ProductGroupMode } from '@/lib/metrics/types';
import { ManagerCardRadar, type RadarAxisInput } from './ManagerCardRadar';
import type { CardSegment, ManagerCardResult, AxisUnit } from '@/features/manager-card/engine/managerCard';

interface Props {
  managerId: string;
  managerName?: string;
  /** Период основного отчёта — начальное значение периода карточки (дефолт). */
  reportPeriod: DateRange;
  onClose: () => void;
  /** Карточка менеджера v2 (бриф 10.07, п.3): «Карточка отдела» — та же панель,
   *  но данные — агрегат отдела (/api/manager-card/department-card), а managerId
   *  в этом режиме — id отдела (uuid) либо 'all'. Дефолт 'manager' — прежнее
   *  поведение (клик по #логину в отчёте), не трогаем. */
  mode?: 'manager' | 'department';
}

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
// Плитки итогов теперь — ЛЮБАЯ метрика каталога (карточка v4, задача 10.07, п.1),
// не только 6 зашитых (count/money) — форматирование по unit (managerCard.ts::
// catalogUnitFor), переиспользует те же fmt*-хелперы, что и раньше.
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
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
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

// Плитка «Итогов за период» — вариант Б аудита UI/UX Монолитики (задача 1662,
// кейс 2Б, зафиксировано владельцем): подпись мелким серым СВЕРХУ, значение
// крупным жирным под ней в одну строку без truncate/обрезки (сетка плиток
// grid-cols-2 ниже даёт достаточно ширины — замерено на мокапе Виктора,
// «1,5 млн ₽» при 20px влезает с запасом). Раньше было наоборот (значение
// сверху, обрезалось многоточием при длинных суммах) — см. git blame.
function Tile({ value, label, deltaPct }: { value: string; label: string; deltaPct: number | null | undefined }) {
  return (
    <div className="border border-[var(--color-border)] rounded-xl px-3.5 py-3 flex flex-col gap-1.5 min-w-0">
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

// ── Дрилл-даун «клик по товарной группе» (задача 10.07, п.5) ────────────────
// Компактный список сделок-отгрузок группы за период карточки (дата, клиент/
// сделка, сумма) — переиспользует существующий /api/reports/deals (тот же
// эндпоинт, что и дрилл-даун основного отчёта), без параллельного SQL.
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

export function ManagerCardPanel({ managerId, managerName, reportPeriod, onClose, mode = 'manager' }: Props) {
  const { closing, requestClose } = useSlideClose(onClose);

  // ── Фильтры (задача 10.07, п.3): произвольный период + отдельный период
  // сравнения (дефолт — предыдущий период той же длины), пресет «Всё время»
  // убран. Физики/Юрики — как раньше. ────────────────────────────────────────
  const [period, setPeriod] = useState<DateRange>(reportPeriod);
  const [comparisonPeriod, setComparisonPeriod] = useState<DateRange>(() => previousPeriodSameLength(reportPeriod));
  const [segment, setSegment] = useState<CardSegment>('all');
  // Система товарных категорий (задача 10.07, п.4): переключатель ровно с такими
  // подписями, как согласовано с Серёгой.
  const [productGroupMode, setProductGroupMode] = useState<ProductGroupMode>('kc');
  // Раскрытый дрилл-даун сделок (задача 10.07, п.5) — id категории (dimensionId,
  // НЕ отображаемое имя — см. CategoryShare в managerCard.ts).
  const [openCategoryId, setOpenCategoryId] = useState<string | null>(null);
  // Табы (карточка v4, задача 10.07, п.3): «Профиль эффективности» (паутина+плитки)
  // и «По товарным категориям» (топ-5 + тумблер KC/по наибольшему + дрилл-даун —
  // переехали сюда целиком, раньше жили во второй колонке первого экрана).
  const [activeTab, setActiveTab] = useState<'main' | 'categories'>('main');

  // Сравнение при смене периода теперь считает PeriodRangeControls (задача 10.07):
  // быстрый пресет → календарный шаг назад, ручной диапазон → previousPeriodSameLength
  // (см. manualComparisonFn ниже — прежний дефолт карточки, «период сразу перед
  // текущим», без изменений для ручного выбора).
  function handlePeriodChange(p: DateRange) {
    setPeriod(p);
    setOpenCategoryId(null);
  }
  function handleComparisonChange(p: DateRange) {
    setComparisonPeriod(p);
    setOpenCategoryId(null);
  }
  // Смена системы категорий/сегмента меняет весь список категорий — открытый
  // дрилл-даун привязан к id ПРЕДЫДУЩЕЙ категории (kc/by_max — разные шкалы id,
  // см. AXIS_CATALOG в cardTemplates.ts), закрываем, чтобы не показать стейл-данные.
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
      return res.json() as Promise<ManagerCardResult>;
    },
    staleTime: 60_000,
  });

  const radarAxes: RadarAxisInput[] = (data?.radar.axes ?? []).map(a => ({
    key: a.key, label: a.label, periodValue: a.period.normalized, comparisonValue: a.comparison.normalized, dataAvailable: a.dataAvailable,
  }));

  // Плитки итогов (карточка v4, задача 10.07, п.1) — набор И порядок решает шаблон
  // карточки (/settings/card-templates): API уже отдаёт ровно то, что нужно
  // рендерить, в нужном порядке — отдельного фильтра видимости на клиенте больше
  // не требуется (выбор в настройках УЖЕ и есть видимость).
  const tiles = data?.tiles ?? [];

  const rating = data?.rating.value ?? null;
  const RING_R = 33;
  const CIRC = 2 * Math.PI * RING_R;
  const ringOffset = rating === null ? CIRC : CIRC * (1 - rating / 10);

  return (
    <>
      <SlideBackdrop closing={closing} onClick={requestClose} className="z-[55]" />
      {/* Задача 1575, п.4: `overflow-hidden` здесь клипало `PanelCloseTab` —
          крестик-ярлык позиционируется `-left-[30px]` (см.
          components/ui/PanelCloseTab.tsx), т.е. за пределами собственного бокса
          этого div, и `overflow-hidden` на родителе обрезал его невидимым. Ни
          у одной другой панели с тем же паттерном (DealCard — идентичная
          структура `fixed ... flex flex-col` без overflow, ChangelogPanel,
          IdeasPanel, ReportSettingsPanel) такого класса нет — прокрутку
          содержимого даёт свой `flex-1 overflow-y-auto` блок ниже (шапка/
          фильтры — `shrink-0`), внешний overflow-hidden был не нужен и
          добавлен по невнимательности при создании файла (см. git blame). */}
      <div className={`fixed inset-y-0 right-0 z-[60] w-full sm:w-[70vw] sm:min-w-[980px] sm:max-w-[1400px] bg-[var(--color-bg-surface)] shadow-2xl border-l border-[var(--color-border)] flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />

        {error ? (
          <div className="p-6 text-sm text-[var(--color-negative)]">
            Ошибка: {error instanceof Error ? error.message : 'Не удалось загрузить карточку менеджера'}
          </div>
        ) : (
          <>
            {/* ── Шапка ── */}
            <div className="shrink-0 border-b border-[var(--color-border)] px-4 sm:px-9 pt-5 sm:pt-6 pb-4 sm:pb-5 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-4 min-w-0">
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center text-[19px] font-extrabold shrink-0"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 16%, transparent)', color: 'var(--color-accent)' }}
                >
                  {initials(data?.profile.name ?? managerName ?? '')}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-lg font-extrabold text-[var(--color-text)] truncate">{data?.profile.name ?? managerName ?? '…'}</span>
                    {data?.profile.login && <span className="text-[13px] font-semibold text-[var(--color-text-muted)]">{data.profile.login}</span>}
                  </div>
                  <div className="mt-1 text-[13px] text-[var(--color-text-muted)] flex items-center gap-2">
                    {data?.profile.department && <span>{data.profile.department}</span>}
                    {data?.profile.department && data?.profile.branch && <span className="text-[var(--color-text-muted)]">·</span>}
                    {data?.profile.branch && <span>{data.profile.branch}</span>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-4 shrink-0">
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
                <div
                  className="flex flex-col items-center gap-0.5 rounded-2xl px-3.5 py-2"
                  style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' }}
                >
                  <span className="text-[13px] font-extrabold text-[var(--color-accent)]">{data?.rating.rank ? `#${data.rating.rank}` : '—'}</span>
                  <span className="text-[10px] text-[var(--color-text-muted)] text-center leading-tight">из {data?.rating.deptSize ?? '—'}<br />{mode === 'department' ? 'среди отделов' : 'в отделе'}</span>
                </div>
              </div>
            </div>

            {/* ── Фильтры ── (карточка v4, задача 10.07, п.3: тумблер «Категория КЦ /
                По наибольшему» переехал в таб «По товарным категориям» — он относится
                только к этому блоку, здесь остаются только период/сравнение/сегмент,
                общие для обоих табов). */}
            <div className="shrink-0 border-b border-[var(--color-border)] px-4 sm:px-9 py-2.5 flex items-center gap-2.5 flex-wrap">
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

            {/* ── Табы (карточка v4, п.3): «Профиль эффективности» (крупная паутина +
                плитки итогов) / «По товарным категориям» (топ-5 + тумблер + дрилл-даун,
                переехали сюда целиком). Стиль — тот же «вариант C», что и табы карточки
                сделки (DealCard.tsx) — единый визуальный язык табов приложения. */}
            <div className="shrink-0 px-4 sm:px-9 pt-3 pb-2 border-b border-[var(--color-border)]">
              <div className="flex bg-[var(--color-bg)] rounded-xl p-1 gap-1 max-w-md">
                {([
                  { v: 'main', label: 'Профиль эффективности' },
                  { v: 'categories', label: `Товарные категории${data?.categories.length ? ` · ${data.categories.length}` : ''}` },
                ] as { v: 'main' | 'categories'; label: string }[]).map(o => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => setActiveTab(o.v)}
                    className={`flex-1 text-center px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
                      activeTab === o.v ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Тело ── */}
            <div className="flex-1 overflow-y-auto px-4 sm:px-9 py-5">
              {isLoading ? (
                <div className="space-y-3">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
              ) : activeTab === 'main' ? (
                <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-7">
                  {/* Левая колонка — паутина (карточка v4, п.3: заметно крупнее и
                      выразительнее — см. ManagerCardRadar.tsx, был мелкий SVG с большим
                      пустым местом под ним; колонка расширена 1.08fr → 1.35fr под новый
                      размер). */}
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2.5">
                      Профиль эффективности · {radarAxes.length || 6} метрик
                    </div>
                    <div className="border border-[var(--color-border)] rounded-2xl py-4 flex justify-center overflow-x-auto">
                      <ManagerCardRadar axes={radarAxes} />
                    </div>
                  </div>

                  {/* Правая колонка — плитки итогов (карточка v4, п.1/2: произвольный
                      набор из ВСЕГО каталога метрик, порядок из шаблона, без ограничения
                      количества — сетка растёт рядами, горизонтальный скролл-предохранитель
                      overflow-x-auto на случай очень узкой панели/длинных подписей). */}
                  <div className="min-w-0">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2.5">
                      Итоги за период · к прошлому периоду
                    </div>
                    <div className="overflow-x-auto">
                      {/* grid-cols-3 → grid-cols-2 (задача 1662, кейс 2Б): плитки шире —
                          значение в 20px («1,5 млн ₽») помещается без truncate. */}
                      <div className="grid grid-cols-2 gap-2.5 min-w-[260px]">
                        {tiles.length === 0 ? (
                          <div className="col-span-full text-sm text-[var(--color-text-muted)] py-2">Плитки не выбраны в шаблоне карточки</div>
                        ) : tiles.map(t => (
                          <Tile key={t.key} value={fmtByUnit(t.current, t.unit)} label={t.label} deltaPct={t.deltaPct} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="max-w-2xl">
                  {/* Таб «По товарным категориям» (карточка v4, п.3) — блок переехал
                      сюда целиком вместе с тумблером системы категорий (был в общем
                      фильтр-баре, относится только к этому табу) и дрилл-дауном. */}
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-2.5">
                    <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                      По товарным категориям · топ-5
                    </div>
                    <ChipGroup
                      value={productGroupMode}
                      onChange={setProductGroupMode}
                      options={[
                        { key: 'kc', label: 'Категория КЦ' },
                        { key: 'by_max', label: 'По наибольшему' },
                      ]}
                    />
                  </div>
                  <div className="border border-[var(--color-border)] rounded-2xl px-4 py-1 overflow-hidden">
                    {(data?.categories.length ?? 0) === 0 ? (
                      <div className="py-3 text-sm text-[var(--color-text-muted)]">Нет продаж за период</div>
                    ) : data!.categories.map((c, i) => {
                      const isOpen = openCategoryId === c.id;
                      return (
                        <div key={c.id} className={i > 0 ? 'border-t border-[var(--color-border)]' : ''}>
                          {/* Клик по группе — дрилл-даун сделок-отгрузок (задача 10.07, п.5) */}
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
                </div>
              )}
            </div>

            {/* ── Тизер звонков ── */}
            {data?.calls && (
              <div className="shrink-0 mx-4 sm:mx-9 mb-5 rounded-xl px-4 py-3 text-[12.5px] text-[var(--color-text-muted)] flex items-center gap-2 flex-wrap"
                   style={{ backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' }}>
                Звонки за период: <b className="text-[var(--color-text)]">{fmtInt(data.calls.count)}</b>
                <span>· средний разговор <b className="text-[var(--color-text)]">{fmtDuration(data.calls.avgDurationSec)}</b></span>
                <span>· первое касание <b className="text-[var(--color-text)]">{fmtMinutes(data.calls.medianFirstTouchMinutes)}</b></span>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
