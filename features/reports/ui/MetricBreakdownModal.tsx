'use client';
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, HelpCircle } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import type { Metric } from '@/lib/metrics/types';
import { formatValue } from '@/lib/format';
import { dealsCountLabel, pluralizeRu } from '@/lib/format/pluralize';
import {
  parseFormula, evalFormulaTree, formatOp, needsParens, formulaRefs,
  type FormulaNode, type FormulaOpNode,
} from '@/lib/metrics/formulaTree';
import { collectedSelectionChips, metricFormulaLine, metricValueKind } from '@/lib/metrics/formulaText';
import { CLIENT_FAMILY_METRIC_IDS, CLIENT_DRILL_RULES } from '@/features/reports/engine/clientDrilldownShared';
import { DealsListBody, ClientDealsView, type DrillTotals } from './DrilldownDrawer';
import { DealCard } from './DealCard';
import { MetricInfoBody } from './MetricInfoBody';
import type { BreakdownReportContext } from './MetricBreakdownContext';

// Полноэкранный «Разбор метрики» (задача владельца 03.09): все сущности, из
// которых сложилась цифра, с параметрами выборки. Простая метрика — один список
// сделок как в дрилл-дауне; формульная — операнды РЯДОМ со знаком операции
// между ними, каждый со своей живой выборкой. Списки — те же компоненты, что в
// дрилл-дауне (DealsListBody / ClientDealsView): сервер режет 1000 сделок / 500
// заказчиков, «Итого» считается по всей выборке. Самопроверка: «Итого выборки»
// каждой панели и результат формулы сверяются с ячейкой отчёта.

// Глубже трёх вложенных формул не раскрываем — дальше панель-заглушка с
// предложением открыть «?» у самой метрики.
const MAX_NESTED_DEPTH = 3;

// Общее для всех панелей дерева — через локальный контекст, а не пропсами через
// каждый уровень рекурсии.
interface Shared {
  ctx: BreakdownReportContext;
  rowId: string | null;
  rowName: string;
  byId: Map<string, Metric>;
  onDealOpen: (id: number) => void;
}
const SharedCtx = createContext<Shared | null>(null);
function useShared(): Shared {
  const s = useContext(SharedCtx);
  if (!s) throw new Error('MetricBreakdown: панель вне SharedCtx');
  return s;
}

const fmtMoney = (n: number) => formatValue(n, 'money', 0);
const fmtNum = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 4 }).format(n);
const fmtMetric = (m: Metric | undefined, v: number | null) =>
  m ? formatValue(v, m.dataType, m.decimalPlaces) : (v === null ? '—' : fmtNum(v));

// ── Сверка с ячейкой ────────────────────────────────────────────────────────
type MatchStatus = 'match' | 'mismatch' | 'none';

// Допуск: деньги — полрубля (ячейка отчёта округлена до рубля, выборка нет),
// счётчики — точно, доли/средние — относительная погрешность плавающей точки
// (ячейка и разбор считают одну формулу от одних чисел, расходиться нечему).
function matches(actual: number, cell: number, dataType: Metric['dataType']): boolean {
  if (dataType === 'money') return Math.abs(actual - cell) <= 0.5;
  if (dataType === 'int') return actual === cell;
  return Math.abs(actual - cell) <= 1e-9 * Math.max(1, Math.abs(cell));
}

function MatchBadge({ status, children }: { status: MatchStatus; children: ReactNode }) {
  const cls = status === 'match'
    ? 'text-[var(--color-positive,#16a34a)] border-[color-mix(in_srgb,var(--color-positive,#16a34a)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-positive,#16a34a)_10%,transparent)]'
    : status === 'mismatch'
      ? 'text-[var(--color-negative,#e03131)] border-[color-mix(in_srgb,var(--color-negative,#e03131)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-negative,#e03131)_10%,transparent)]'
      : 'text-[var(--color-text-muted)] border-[var(--color-border)] bg-[var(--color-bg-surface)]';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] leading-snug whitespace-normal ${cls}`}>
      {children}
    </span>
  );
}

/** Бейдж «= ячейка отчёта ✓» / «расходится на Δ» / «в отчёте нет значения». */
function CellCompare({ actual, cell, metric }: { actual: number | null; cell: number | null; metric: Metric }) {
  if (cell === null) return <MatchBadge status="none">в отчёте нет значения</MatchBadge>;
  if (actual === null) return <MatchBadge status="none">выборка без результата · ячейка отчёта: {fmtMetric(metric, cell)}</MatchBadge>;
  if (matches(actual, cell, metric.dataType)) return <MatchBadge status="match">= ячейка отчёта ✓</MatchBadge>;
  const delta = actual - cell;
  return (
    <MatchBadge status="mismatch">
      ячейка отчёта: {fmtMetric(metric, cell)}, расходится на {delta > 0 ? '+' : ''}{fmtMetric(metric, delta)}
    </MatchBadge>
  );
}

// ── Формула строкой с числами ───────────────────────────────────────────────
function isUnaryMinus(node: FormulaOpNode): boolean {
  return node.op === '-' && node.left.kind === 'num' && node.left.value === 0;
}

function InlineFormula({ node, values, byId, parent, side }: {
  node: FormulaNode; values: Record<string, number | null>; byId: Map<string, Metric>;
  parent?: FormulaOpNode; side?: 'left' | 'right';
}) {
  const wrapped = parent && side ? needsParens(parent, node, side) : false;
  let body: ReactNode;
  if (node.kind === 'num') {
    body = <span className="tabular-nums">{fmtNum(node.value)}</span>;
  } else if (node.kind === 'ref') {
    const m = byId.get(node.id);
    body = (
      // nowrap — только на «= значение»: имена метрик до ~70 символов, на 375px
      // блок формулы шириной 319px; цельный nowrap вылезал за модал и тащил его вбок.
      <span>
        <span className="text-[var(--color-text)] break-words">{m?.nameRu ?? node.id}</span>
        <span className="whitespace-nowrap">
          <span className="text-[var(--color-text-muted)]"> = </span>
          <span className="font-semibold tabular-nums text-[var(--color-text)]">{fmtMetric(m, values[node.id] ?? null)}</span>
        </span>
      </span>
    );
  } else if (isUnaryMinus(node)) {
    body = <>−<InlineFormula node={node.right} values={values} byId={byId} parent={node} side="right" /></>;
  } else {
    body = (
      <>
        <InlineFormula node={node.left} values={values} byId={byId} parent={node} side="left" />
        <span className="mx-1.5 text-[var(--color-accent)] font-semibold">{formatOp(node.op)}</span>
        <InlineFormula node={node.right} values={values} byId={byId} parent={node} side="right" />
      </>
    );
  }
  return wrapped ? <>( {body} )</> : <>{body}</>;
}

// ── Панели дерева ───────────────────────────────────────────────────────────
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-[11px] leading-snug bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-text)] border border-[color-mix(in_srgb,var(--color-accent)_25%,transparent)]">
      {children}
    </span>
  );
}

function InfoPopover({ metric }: { metric: Metric }) {
  return (
    <Popover
      align="start"
      className="w-[340px] max-w-[calc(100vw-16px)] p-3"
      trigger={
        <button
          onClick={e => e.stopPropagation()}
          title="Как считается"
          className="tap-target p-0.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors shrink-0"
        >
          <HelpCircle size={13} />
        </button>
      }
    >
      <MetricInfoBody metric={metric} />
    </Popover>
  );
}

/** Шапка панели операнда: имя, «?», чипы выборки, значение ячейки. */
function PanelHeader({ metric, chips, extra }: { metric: Metric; chips: string[]; extra?: ReactNode }) {
  const { ctx, rowId } = useShared();
  const cell = ctx.getCellValue(metric.id, rowId);
  return (
    <header className="flex items-start gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-sm font-semibold text-[var(--color-text)] truncate" title={metric.nameRu}>{metric.nameRu}</span>
          <InfoPopover metric={metric} />
        </div>
        {chips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {chips.map((c, i) => <Chip key={i}>{c}</Chip>)}
          </div>
        )}
        {extra}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Ячейка</div>
        <div className="text-sm font-semibold tabular-nums text-[var(--color-num,#000)]">{fmtMetric(metric, cell)}</div>
      </div>
    </header>
  );
}

/** Query-параметры /api/reports/deals для панели операнда: срез отчёта + метрика + строка/Итого. */
function buildDealsQuery(ctx: BreakdownReportContext, metricId: string, rowId: string | null): URLSearchParams {
  const p: Record<string, string> = {
    from: ctx.period.from.toISOString(),
    to: ctx.period.to.toISOString(),
    scope: ctx.dealScope,
    productGroupMode: ctx.productGroupMode,
    clientType: ctx.clientType,
    metricFilter: metricId,
  };
  // Зеркало baseDealParams из DrilldownDrawer: отделы — везде, кроме разреза
  // источников; тип аккаунтов — только там, где срез менеджерский.
  if (ctx.dimensionType !== 'source' && ctx.departmentIds.length) p.departmentIds = ctx.departmentIds.join(',');
  const managerSlice = ctx.dimensionType === 'manager'
    || (ctx.dimensionType === 'period' && ctx.periodDimension !== 'product-groups');
  if (managerSlice && ctx.accountType && ctx.accountType !== 'all') p.accountType = ctx.accountType;
  if (ctx.dealFilters.length) p.dealFilters = JSON.stringify(ctx.dealFilters);
  // Срез: «Итого» в отчёте по менеджерам — ТОЛЬКО менеджеры строк отчёта
  // (ctx.totalRowIds): так считает ячейка «Итого» (фильтр «тип аккаунта» и
  // оргструктура режут строки, движок и суммы идут по ним). Без этого разбор
  // брал весь срез и расходился на сделки не-manager* аккаунтов (инцидент 03.09,
  // +11,7 млн у «Сумма (Новые клиенты)»). Прочие разрезы — весь срез (all=1);
  // строка — менеджер или товарная группа; период/источник/клиент по строке
  // в v1 не режем (переключатель там выключен).
  if (rowId === null) {
    if (ctx.dimensionType === 'manager' && ctx.totalRowIds.length) p.managerIds = ctx.totalRowIds.join(',');
    else p.all = '1';
  }
  else if (ctx.dimensionType === 'manager') p.managerId = rowId;
  else if (ctx.dimensionType === 'product-group') p.productGroup = rowId;
  else p.all = '1';
  return new URLSearchParams(p);
}

/**
 * Панель-лист: живая выборка метрики (сделки или заказчики) + «Итого выборки» и
 * сверка с ячейкой. `note` — вместо списка (слишком глубокая вложенность).
 */
function MetricLeafPanel({ metric, note }: { metric: Metric; note?: string }) {
  const { ctx, rowId, rowName, onDealOpen } = useShared();
  const [totals, setTotals] = useState<DrillTotals | null>(null);
  const cell = ctx.getCellValue(metric.id, rowId);
  const isClient = CLIENT_FAMILY_METRIC_IDS.includes(metric.id);
  const chips = useMemo(() => {
    if (metric.metricType === 'collected') return collectedSelectionChips(metric);
    const line = metricFormulaLine(metric);
    return line ? [line] : [];
  }, [metric]);
  const query = useMemo(() => buildDealsQuery(ctx, metric.id, rowId), [ctx, metric.id, rowId]);

  // Что сверяем с ячейкой. Итог выборки — число сущностей и сумма; сравнимы с
  // ним только счётчики той же сущности и суммы. Несравнимое (noCompare — текст
  // причины в бейдж): доли/средние/медианы; счётчик collected по полю, отличному
  // от deal_id (число разных заказчиков в списке сделок); средний чек; звонковые
  // метрики (список — сделки со звонком, ячейка — звонки); клиентские метрики
  // без явного `compare` в CLIENT_DRILL_RULES и с населением-фолбэком.
  const kind = metricValueKind(metric);
  const clientCompare = isClient ? CLIENT_DRILL_RULES[metric.id]?.compare : undefined;
  let compared: number | null = null;
  let noCompare: string | null = kind === 'other' ? 'доля/среднее/медиана' : null;
  if (totals && !totals.noRule) {
    if (isClient) {
      if (totals.approxPopulation) noCompare = 'население — все отгрузки клиентов периода (фолбэк), не население метрики';
      else if (!clientCompare) noCompare = 'среднее/медиана/доля/снимок по клиентам';
      else compared = clientCompare === 'deals' ? (totals.deals ?? totals.count) : clientCompare === 'amount' ? totals.amount : totals.count;
    } else if (totals.unit === 'calls') {
      noCompare = 'объект метрики — звонок, а в списке сделки со звонком';
    } else if (kind === 'count') {
      if (metric.metricType === 'collected' && metric.aggField && metric.aggField !== 'deal_id') noCompare = 'счётчик не по сделкам';
      else compared = totals.count;
    } else if (kind === 'amount') {
      if (metric.metricType === 'collected' && metric.aggFn === 'avg') noCompare = 'средний чек против суммы выборки';
      else compared = totals.amount;
    }
  }
  // Клиентская метрика с явным compare — сравнима даже при dataType, который
  // metricValueKind считает «иным» (сверяем по сущности населения, не по формату).
  if (isClient && compared !== null) noCompare = null;

  return (
    <section className="flex flex-col min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
      <PanelHeader metric={metric} chips={chips} />
      {note ? (
        <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">{note}</div>
      ) : (
        <>
          {/* Фиксированная высота — списки внутри рассчитаны на h-full со своим
              скроллом (stickyHead у DealsTable); модал скроллит панели целиком. */}
          <div className="h-[min(440px,55dvh)] min-h-[200px] min-w-0">
            {isClient ? (
              <ClientDealsView
                // «Итого» по менеджерам — kind 'managers' со списком строк отчёта
                // (та же популяция, что у ячейки, см. buildDealsQuery); иначе — весь срез.
                target={rowId !== null
                  ? { id: rowId, name: rowName, metricId: metric.id }
                  : ctx.dimensionType === 'manager' && ctx.totalRowIds.length
                    ? { id: ctx.totalRowIds.join(','), name: rowName, metricId: metric.id, kind: 'managers' }
                    : { id: '__total__', name: rowName, metricId: metric.id, kind: 'total' }}
                dimensionType={ctx.dimensionType === 'client' ? 'manager' : ctx.dimensionType}
                period={ctx.period}
                dealScope={ctx.dealScope}
                clientType={ctx.clientType}
                productGroupMode={ctx.productGroupMode}
                departmentIds={ctx.departmentIds}
                dealFilters={ctx.dealFilters}
                onDealOpen={onDealOpen}
                onTotals={setTotals}
                grouped
              />
            ) : (
              <DealsListBody
                query={query}
                dealFields={ctx.dealFields}
                onDealOpen={onDealOpen}
                onTotals={setTotals}
                emptyLabel="Нет сделок в выборке за период"
              />
            )}
          </div>
          <footer className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] text-xs text-[var(--color-text-muted)] flex flex-wrap items-center gap-x-3 gap-y-1">
            {!totals && <span>Итого выборки: …</span>}
            {totals?.noRule && (
              <span>Список сущностей для этой метрики не строится (медиана/снимок/своя популяция) — сверить с ячейкой нечего, см. «?».</span>
            )}
            {totals && !totals.noRule && (
              <>
                <span className="text-[var(--color-text)]">
                  Итого выборки:{' '}
                  {isClient
                    ? `${totals.count.toLocaleString('ru-RU')} ${pluralizeRu(totals.count, ['заказчик', 'заказчика', 'заказчиков'])} · ${dealsCountLabel(totals.deals ?? 0)} · ${fmtMoney(totals.amount)}`
                    : `${dealsCountLabel(totals.count)} · ${fmtMoney(totals.amount)}`}
                </span>
                {noCompare === null
                  ? <CellCompare actual={compared} cell={cell} metric={metric} />
                  : <MatchBadge status="none">с ячейкой не сравнивается: {noCompare}</MatchBadge>}
                {totals.truncated && (
                  <span>показаны первые {totals.shown ?? '…'}, Итого посчитано по всем</span>
                )}
              </>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

/** Ссылка на метрику, которой нет в каталоге (скрытые каталог-роут не отдаёт). */
function ServiceMetricPanel({ id }: { id: string }) {
  const { ctx, rowId, onDealOpen } = useShared();
  const [totals, setTotals] = useState<DrillTotals | null>(null);
  const cell = ctx.getCellValue(id, rowId);
  const query = useMemo(() => buildDealsQuery(ctx, id, rowId), [ctx, id, rowId]);
  return (
    <section className="flex flex-col min-w-0 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
      <header className="flex items-start gap-2 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)]">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--color-text)] truncate">служебная метрика <span className="font-mono">{id}</span></div>
          <div className="text-[11px] text-[var(--color-text-muted)]">скрыта в каталоге — описания и чипов выборки нет</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Ячейка</div>
          <div className="text-sm font-semibold tabular-nums">{cell === null ? '—' : fmtNum(cell)}</div>
        </div>
      </header>
      <div className="h-[min(440px,55dvh)] min-h-[200px] min-w-0">
        <DealsListBody query={query} dealFields={ctx.dealFields} onDealOpen={onDealOpen} onTotals={setTotals} emptyLabel="Нет сделок в выборке за период" />
      </div>
      <footer className="px-3 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] text-xs text-[var(--color-text-muted)]">
        {totals && !totals.noRule && <>Итого выборки: {dealsCountLabel(totals.count)} · {fmtMoney(totals.amount)}</>}
        {totals?.noRule && 'Список сущностей для этой метрики не строится.'}
        {!totals && 'Итого выборки: …'}
      </footer>
    </section>
  );
}

/** Крупный знак операции в круге — между операндами. */
function OpCircle({ op }: { op: FormulaOpNode['op'] }) {
  return (
    <div className="flex items-center justify-center shrink-0 self-center">
      <span className="w-11 h-11 rounded-full border-2 border-[var(--color-accent)] text-[var(--color-accent)] flex items-center justify-center text-2xl font-semibold bg-[var(--color-bg)]">
        {formatOp(op)}
      </span>
    </div>
  );
}

/** Компактная пилюля для числового операнда: «× 100», «÷ 20», «100 ×». */
function NumPill({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center shrink-0 self-center">
      <span className="px-3 py-1.5 rounded-full border-2 border-[var(--color-accent)] text-[var(--color-accent)] text-lg font-semibold tabular-nums bg-[var(--color-bg)] whitespace-nowrap">
        {children}
      </span>
    </div>
  );
}

/** Операнд op-узла: flex-1 + min-w-0 (таблицы внутри скроллят сами), скобки — рамка с подписью. */
function Operand({ node, parent, side, depth }: { node: FormulaNode; parent: FormulaOpNode; side: 'left' | 'right'; depth: number }) {
  const inner = <TreeNode node={node} depth={depth} />;
  if (!needsParens(parent, node, side)) return <div className="flex-1 min-w-0 flex flex-col">{inner}</div>;
  return (
    <div className="relative flex-1 min-w-0 flex flex-col rounded-2xl border-2 border-dashed border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] p-2 pt-4 sm:p-3 sm:pt-4">
      <span className="absolute -top-2.5 left-3 px-1.5 text-xs font-mono text-[var(--color-accent)] bg-[var(--color-bg-overlay)]">( … )</span>
      {inner}
    </div>
  );
}

/** Вложенная формульная метрика: заголовок с именем/ячейкой и поддерево ниже. */
function NestedFormulaPanel({ metric, node, depth }: { metric: Metric; node: FormulaNode; depth: number }) {
  const line = metricFormulaLine(metric);
  return (
    <section className="flex flex-col min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
      <PanelHeader metric={metric} chips={line ? [line] : []} />
      <div className="p-2 sm:p-3 min-w-0">
        <TreeNode node={node} depth={depth} />
      </div>
    </section>
  );
}

function TreeNode({ node, depth }: { node: FormulaNode; depth: number }) {
  const { byId } = useShared();
  if (node.kind === 'num') return <NumPill>{fmtNum(node.value)}</NumPill>;
  if (node.kind === 'ref') {
    const m = byId.get(node.id);
    if (!m) return <ServiceMetricPanel id={node.id} />;
    if (m.metricType === 'calculated' && m.formula) {
      const sub = parseFormula(m.formula);
      if (sub && depth < MAX_NESTED_DEPTH) return <NestedFormulaPanel metric={m} node={sub} depth={depth + 1} />;
      if (sub) return <MetricLeafPanel metric={m} note="Вложенная формула глубже трёх уровней — откройте её «?» и «Подробнее» там." />;
      // Формула не разобралась — покажем как лист: сервер сам раскладывает
      // calculated на collected-ноги (/api/reports/deals, metricFilter) либо отдаст noRule.
    }
    return <MetricLeafPanel metric={m} />;
  }
  // op-узел: столбиком на телефоне, в ряд с md — знак операции между операндами.
  const row = 'flex flex-col md:flex-row gap-3 items-stretch min-w-0';
  if (isUnaryMinus(node)) {
    return (
      <div className={row}>
        <NumPill>−</NumPill>
        <Operand node={node.right} parent={node} side="right" depth={depth} />
      </div>
    );
  }
  if (node.right.kind === 'num') {
    return (
      <div className={row}>
        <Operand node={node.left} parent={node} side="left" depth={depth} />
        <NumPill>{formatOp(node.op)} {fmtNum(node.right.value)}</NumPill>
      </div>
    );
  }
  if (node.left.kind === 'num') {
    return (
      <div className={row}>
        <NumPill>{fmtNum(node.left.value)} {formatOp(node.op)}</NumPill>
        <Operand node={node.right} parent={node} side="right" depth={depth} />
      </div>
    );
  }
  return (
    <div className={row}>
      <Operand node={node.left} parent={node} side="left" depth={depth} />
      <OpCircle op={node.op} />
      <Operand node={node.right} parent={node} side="right" depth={depth} />
    </div>
  );
}

// ── Сам модал ───────────────────────────────────────────────────────────────
const DIMENSION_LABEL: Record<BreakdownReportContext['dimensionType'], string> = {
  manager: 'Менеджер', 'product-group': 'Товарная группа', period: 'Период', source: 'Источник', client: 'Клиент',
};
const SLICE_UNSUPPORTED_NOTE = 'Срез по строке в этом разрезе пока не режется — показан «Итого» всего отчёта';

export function MetricBreakdownModal({ metric, ctx, onClose }: {
  metric: Metric;
  ctx: BreakdownReportContext;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Тот же ключ и fetch, что в MetricInfoBody/SalesReportPage — кэш общий.
  const { data: catalog } = useQuery({
    queryKey: ['metrics-catalog'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error('Failed to load metrics catalog');
      return res.json() as Promise<{ metrics: Metric[] }>;
    },
    staleTime: 5 * 60 * 1000,
  });
  const byId = useMemo(() => new Map((catalog?.metrics ?? []).map(m => [m.id, m])), [catalog]);
  // Живая версия из каталога (после тумблера «Проверено» инвалидация принесёт
  // свежие verifiedAt/By); до загрузки — объект, с которым открыли.
  const live = byId.get(metric.id) ?? metric;

  // Отметку ставит только супер-админ (см. verify-роут) — по флагу сессии, не по правам раздела.
  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/me');
      if (!res.ok) return null;
      return res.json() as Promise<{ user: { login: string; isSuperadmin: boolean } }>;
    },
    staleTime: 5 * 60 * 1000,
  });
  const isSuperadmin = !!me?.user?.isSuperadmin;

  // Срез: «Итого» по умолчанию; строка — только в разрезах, где список умеет
  // резаться по ней (менеджер / товарная группа). Период/источник/клиент — v1
  // только «Итого», иначе список и ячейка строки честно расходились бы.
  const sliceSupported = ctx.dimensionType === 'manager' || ctx.dimensionType === 'product-group';
  const [rowIdState, setRowId] = useState<string | null>(null);
  const rowId = sliceSupported ? rowIdState : null;
  const rowName = rowId === null ? 'Итого' : (ctx.rows.find(r => r.id === rowId)?.name ?? rowId);

  const [openDealId, setOpenDealId] = useState<number | null>(null);

  // «Проверено»: локальный override после POST, чтобы не ждать рефетч каталога.
  const [verifyState, setVerifyState] = useState<{ verifiedAt: string | null; verifiedBy: string | null } | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const verifiedAt = verifyState ? verifyState.verifiedAt : (live.verifiedAt ?? null);
  const verifiedBy = verifyState ? verifyState.verifiedBy : (live.verifiedBy ?? null);

  async function toggleVerified(next: boolean) {
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const res = await fetch(`/api/catalog/metrics/${encodeURIComponent(live.id)}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified: next }),
      });
      const body = await res.json().catch(() => null) as { verifiedAt?: string | null; verifiedBy?: string | null; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setVerifyState({ verifiedAt: body?.verifiedAt ?? null, verifiedBy: body?.verifiedBy ?? null });
      qc.invalidateQueries({ queryKey: ['metrics-catalog'] });
    } catch (e) {
      setVerifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifyBusy(false);
    }
  }

  // Дерево формулы и значения ссылок из ячеек текущего среза.
  const tree = live.metricType === 'calculated' && live.formula ? parseFormula(live.formula) : null;
  const refValues = useMemo(() => {
    const out: Record<string, number | null> = {};
    if (tree) for (const id of formulaRefs(tree)) out[id] = ctx.getCellValue(id, rowId);
    return out;
  }, [tree, ctx, rowId]);
  const cell = ctx.getCellValue(live.id, rowId);
  const computed = tree ? evalFormulaTree(tree, refValues) : null;

  const shared = useMemo<Shared>(() => ({ ctx, rowId, rowName, byId, onDealOpen: setOpenDealId }), [ctx, rowId, rowName, byId]);

  const verifiedTitle = verifiedAt
    ? `Проверено · ${verifiedBy ?? '—'} · ${format(new Date(verifiedAt), 'd MMM yyyy, HH:mm', { locale: ru })}`
    : null;

  return (
    <Modal
      open
      // Esc/клик мимо при открытой карточке сделки закрывают карточку, не разбор:
      // карточка живёт внутри контента модала, а Esc Radix перехватывает первым.
      onOpenChange={o => {
        if (o) return;
        if (openDealId !== null) { setOpenDealId(null); return; }
        onClose();
      }}
      desktopWidth="sm:max-w-[96vw]"
      // На весь экран: телефон — 100dvh без скруглений (h-dvh, не h-screen —
      // CLAUDE.md п.7), десктоп — 92vh. Прокрутка — ТЕЛА модала (bodyClassName),
      // а не Dialog.Content: у Content transform/backdrop-filter, он containing
      // block для fixed-потомков (карточка сделки/заказчика внутри), и при
      // скролле самого Content карточка уезжала вместе с содержимым за экран.
      // Нескроллящийся Content = карточка занимает бокс модала и стоит на месте.
      contentClassName="h-[100dvh] max-h-[100dvh] rounded-none sm:rounded-lg sm:h-[92vh] sm:max-h-[92vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      title={
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate">Разбор метрики · {live.nameRu}</span>
          {verifiedAt && (
            <CheckCircle2 size={16} className="shrink-0 text-[var(--color-positive,#16a34a)]" aria-label={verifiedTitle ?? undefined} />
          )}
        </span>
      }
    >
      <SharedCtx.Provider value={shared}>
        {/* Панель управления: срез + «Проверено» */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 mb-3">
          <div className="flex flex-col gap-1 min-w-0">
            <label className="flex items-center gap-2 min-w-0">
              <span className="text-xs text-[var(--color-text-muted)] shrink-0">Срез</span>
              <select
                value={rowId ?? ''}
                onChange={e => setRowId(e.target.value === '' ? null : e.target.value)}
                disabled={!sliceSupported}
                title={sliceSupported ? undefined : SLICE_UNSUPPORTED_NOTE}
                className="min-w-0 flex-1 sm:flex-none sm:max-w-[320px] text-base sm:text-sm min-h-11 sm:min-h-9 px-2 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-60"
              >
                <option value="">{ctx.dimensionType === 'manager' && ctx.totalRowIds.length ? `Итого · ${ctx.totalRowIds.length} строк отчёта` : 'Итого · весь отчёт'}</option>
                {sliceSupported && ctx.rows.map(r => (
                  <option key={r.id} value={r.id}>{DIMENSION_LABEL[ctx.dimensionType]}: {r.name}</option>
                ))}
              </select>
            </label>
            {/* Причина блокировки — видимым текстом: на таче title не показывается
                (на disabled-элементе iOS Safari — вообще никогда), CLAUDE.md п.5. */}
            {!sliceSupported && (
              <span className="text-[11px] text-[var(--color-text-muted)]">{SLICE_UNSUPPORTED_NOTE}</span>
            )}
          </div>
          <span className="hidden sm:block text-xs text-[var(--color-text-muted)]">
            {format(ctx.period.from, 'd MMM', { locale: ru })} — {format(ctx.period.to, 'd MMM yyyy', { locale: ru })}
          </span>
          <div className="sm:ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <label
              className={`flex items-center gap-2 min-h-11 sm:min-h-0 text-sm ${isSuperadmin ? 'cursor-pointer' : 'cursor-not-allowed opacity-70'}`}
              title={isSuperadmin ? 'Отметить метрику как сверенную вручную' : 'Отметку ставит супер-админ'}
            >
              <input
                type="checkbox"
                checked={!!verifiedAt}
                disabled={!isSuperadmin || verifyBusy}
                onChange={e => toggleVerified(e.target.checked)}
                className="w-4 h-4 accent-[var(--color-positive,#16a34a)]"
              />
              <span className="text-[var(--color-text)]">Проверено</span>
            </label>
            {verifiedTitle && (
              <span className="flex items-center gap-1 text-xs text-[var(--color-positive,#16a34a)]">
                <CheckCircle2 size={13} /> {verifiedTitle}
              </span>
            )}
            {verifyError && <span className="text-xs text-[var(--color-negative,#e03131)]">Не сохранилось: {verifyError}</span>}
          </div>
        </div>

        {/* Формула с числами и сверка с ячейкой */}
        <div className="mb-3 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-sm leading-relaxed">
          {tree ? (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="text-[var(--color-text-muted)] shrink-0">{rowName}:</span>
              <span className="min-w-0 break-words">
                <InlineFormula node={tree} values={refValues} byId={byId} />
              </span>
              <span className="text-[var(--color-text-muted)]">=</span>
              <span className="font-semibold tabular-nums text-[var(--color-text)]">{fmtMetric(live, computed)}</span>
              <CellCompare actual={computed} cell={cell} metric={live} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[var(--color-text-muted)]">{rowName} · ячейка отчёта:</span>
              <span className="font-semibold tabular-nums text-[var(--color-text)]">{fmtMetric(live, cell)}</span>
              {live.metricType === 'calculated' && live.formula && (
                <span className="text-xs text-[var(--color-text-muted)]">формула не разобралась в дерево — показан список по метрике целиком</span>
              )}
            </div>
          )}
        </div>

        {/* Дерево операндов / одиночная выборка */}
        <div className="min-w-0">
          {tree ? <TreeNode node={tree} depth={1} /> : <MetricLeafPanel metric={live} />}
        </div>

        {/* Карточка внутри Dialog.Content (не порталом в body: модальный Radix
            ставит на body pointer-events:none и держит focus-trap в Content) —
            позиционируется относительно бокса модала; Content нескроллящийся
            (см. contentClassName), поэтому карточка не уезжает со скроллом тела. */}
        {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
      </SharedCtx.Provider>
    </Modal>
  );
}
