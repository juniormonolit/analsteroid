'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, RefreshCw, RotateCcw } from 'lucide-react';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { PeriodRangeControls } from '@/features/reports/ui/FilterBar';
import { applyPreset, calendarComparisonForPreset } from '@/lib/period';
import { useUrlState, dateRangeParam, stringParam, boolParam } from '@/lib/hooks/useUrlState';
import type { MapScopeType } from '../types';
import { fetchMetricMap, recomputeMetricMap } from './api';
import { MetricMapTree } from './MetricMapTree';
import { fmtRub, fmtValue, indexTree, scenarioValues } from './tree';

// «Карта показателей» (задача владельца 23.11): дерево связанных показателей.
// Корень — Сумма отгрузок = перв. + повт.; ветка = сделки × CR × ср. чек × коэф. отгрузки.
// Экран только рисует MetricMapResponse и считает «что если» на клиенте — вся аналитика
// (медианы, вклады LMDI, потенциал) приходит от движка (features/metric-map/engine).

type Access = 'all' | 'depts' | 'self';
type Person = { id: string; name: string; department: string | null };
type DeptNode = { id: string; name: string; children?: DeptNode[] };

const SCOPE_LABEL: Record<MapScopeType, string> = {
  company: 'Компания',
  department: 'Отдел',
  manager: 'Менеджер',
  product_group: 'Товарная группа',
};

const monthLabel = (d: Date) => {
  const s = d.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const rangeLabel = (r: { from: Date; to: Date }) => {
  const sameMonth = r.from.getDate() === 1 && r.from.getMonth() === r.to.getMonth()
    && new Date(r.to.getFullYear(), r.to.getMonth(), r.to.getDate() + 1).getDate() === 1;
  if (sameMonth) return monthLabel(r.from);
  const f = (d: Date) => d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
  return `${f(r.from)} – ${f(r.to)}`;
};

function flattenDepts(nodes: DeptNode[], depth = 0, parent: string | null = null): SearchSelectOption[] {
  return nodes.flatMap(n => [
    { value: n.id, label: `${depth ? '  '.repeat(depth) : ''}${n.name}`, hint: parent },
    ...flattenDepts(n.children ?? [], depth + 1, n.name),
  ]);
}

const getJson = async <T,>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export function MetricMapPage({ access, selfId, selfName }: { access: Access; selfId: string | null; selfName: string }) {
  const defaultPeriod = useMemo(() => applyPreset('last_month'), []);
  const defaultCompare = useMemo(() => calendarComparisonForPreset('last_month'), []);
  const [period, setPeriod] = useUrlState('period', dateRangeParam(defaultPeriod));
  const [comparison, setComparison] = useUrlState('compare', dateRangeParam(defaultCompare));
  const selfScope = selfId ? `manager:${selfId}` : 'company';
  const [scopeRaw, setScope] = useUrlState('scope', stringParam(access === 'self' ? selfScope : 'company'));
  const [forceFixture] = useUrlState('fixture', boolParam(false));

  // МОП видит только себя: срез из URL игнорируем (API всё равно режет по сессии).
  const scope = access === 'self' ? selfScope : scopeRaw;
  const [scopeType, scopeId = ''] = scope.split(':') as [MapScopeType, string?];

  const allowedTypes: MapScopeType[] = access === 'all'
    ? ['company', 'department', 'manager', 'product_group']
    : access === 'depts' ? ['department', 'manager'] : ['manager'];
  // РОП/директор без выбора — по умолчанию первый свой отдел (компания целиком ему недоступна).

  const { data: people } = useQuery<{ people: Person[] }>({
    queryKey: ['profile-people'],
    queryFn: () => getJson('/api/profile/people'),
    staleTime: 5 * 60 * 1000,
    enabled: access !== 'self',
  });
  const { data: org } = useQuery<{ tree: DeptNode[] }>({
    queryKey: ['org-structure'],
    queryFn: () => getJson('/api/catalog/org-structure'),
    staleTime: 5 * 60 * 1000,
    enabled: allowedTypes.includes('department'),
  });
  const { data: pg } = useQuery<{ groups: { id: string; name: string }[] }>({
    queryKey: ['catalog-product-groups', 'kc'],
    queryFn: () => getJson('/api/catalog/product-groups?mode=kc'),
    staleTime: 30 * 60 * 1000,
    enabled: allowedTypes.includes('product_group'),
  });

  const entityOptions: SearchSelectOption[] = useMemo(() => {
    if (scopeType === 'manager') {
      const list = people?.people ?? [];
      return list.map(p => ({ value: p.id, label: p.name, hint: p.department }));
    }
    if (scopeType === 'department') return flattenDepts(org?.tree ?? []);
    if (scopeType === 'product_group') return (pg?.groups ?? []).map(g => ({ value: g.id, label: g.name }));
    return [];
  }, [scopeType, people, org, pg]);

  // РОП с пустым срезом «company» → первый доступный отдел.
  useEffect(() => {
    if (access === 'depts' && scopeType === 'company' && org?.tree?.[0]) setScope(`department:${org.tree[0].id}`);
  }, [access, scopeType, org, setScope]);

  const scopeLabel = scopeType === 'company'
    ? 'Вся компания'
    : access === 'self' ? selfName
      : entityOptions.find(o => o.value === scopeId)?.label.trim() ?? (scopeId ? `${SCOPE_LABEL[scopeType]} ${scopeId}` : `Выберите: ${SCOPE_LABEL[scopeType].toLowerCase()}`);
  const ready = scopeType === 'company' || !!scopeId;

  const q = {
    scope, scopeLabel,
    from: period.from, to: period.to,
    compareFrom: comparison.from, compareTo: comparison.to,
    periodLabel: rangeLabel(period), compareLabel: rangeLabel(comparison),
    forceFixture,
  };
  const qc = useQueryClient();
  const queryKey = ['metric-map', scope, period.from.toISOString(), period.to.toISOString(), comparison.from.toISOString(), comparison.to.toISOString(), forceFixture];
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey,
    queryFn: () => fetchMetricMap(q),
    enabled: ready,
    staleTime: 5 * 60 * 1000,
  });

  const recompute = useMutation({
    mutationFn: recomputeMetricMap,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['metric-map'] }),
  });

  // Раскрытие: по умолчанию видны корень, ветки и их множители; составные множители
  // (CR, ср. чек) свёрнуты до клика.
  const idx = useMemo(() => (data ? indexTree(data) : null), [data]);
  const [collapsed, setCollapsed] = useState<Set<string> | null>(null);
  const defaultCollapsed = useMemo(() => {
    const s = new Set<string>();
    if (!data || !idx) return s;
    const walk = (id: string, depth: number) => {
      const d = idx.byId.get(id);
      if (!d?.children?.length) return;
      if (depth >= 2) s.add(id);
      d.children.forEach(c => walk(c, depth + 1));
    };
    walk(data.rootId, 0);
    return s;
  }, [data, idx]);
  const effCollapsed = collapsed ?? defaultCollapsed;
  const toggle = (id: string) => setCollapsed(() => {
    const n = new Set(effCollapsed);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const setAll = (open: boolean) => {
    if (!data || !idx) return;
    setCollapsed(open ? new Set() : new Set(data.nodes.filter(n => n.children?.length && n.id !== data.rootId).map(n => n.id)));
  };

  // «Что если»: сценарий живёт только на клиенте, сбрасывается при смене данных.
  const [whatIf, setWhatIf] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  useEffect(() => { setOverrides({}); }, [data]);
  const scenario = useMemo(() => (data && idx ? scenarioValues(data, idx, whatIf ? overrides : {}) : {}), [data, idx, overrides, whatIf]);
  const onOverride = (id: string, v: number | null) => setOverrides(prev => {
    const n = { ...prev };
    if (v == null) delete n[id]; else n[id] = v;
    return n;
  });
  const rootFact = data?.values[data.rootId]?.value ?? null;
  const rootScen = data ? scenario[data.rootId] ?? null : null;
  const effect = rootFact != null && rootScen != null ? rootScen - rootFact : null;
  const nOverrides = Object.keys(overrides).length;

  const computedAt = data?.computedAt ? new Date(data.computedAt) : null;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="px-3 sm:px-6 py-3 border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Карта показателей</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5 max-w-4xl">
          Из чего складывается сумма отгрузок: первичка + повторка, каждая — сделки × CR Сделка → Продажа × ср. чек × коэф. отгрузки.
          У каждого показателя — изменение к прошлому периоду, медиана команды, вклад в рублях в изменение корня и сколько даст подтянуть его до медианы.
        </p>
      </div>

      {/* Фильтры */}
      <div className="flex items-center gap-2 px-3 sm:px-6 py-2 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] flex-wrap">
        <PeriodRangeControls
          period={period} comparison={comparison}
          onPeriodChange={setPeriod} onComparisonChange={setComparison}
        />
        {access !== 'self' ? (
          <>
            <SearchSelect
              ariaLabel="Срез"
              options={allowedTypes.map(t => ({ value: t, label: SCOPE_LABEL[t] }))}
              value={scopeType}
              onChange={t => setScope(t === 'company' ? 'company' : `${t}:`)}
              className="min-h-11 sm:min-h-0"
            />
            {scopeType !== 'company' && (
              <SearchSelect
                ariaLabel={SCOPE_LABEL[scopeType]}
                options={entityOptions}
                value={scopeId}
                onChange={id => setScope(`${scopeType}:${id}`)}
                placeholder={`Выберите: ${SCOPE_LABEL[scopeType].toLowerCase()}`}
                searchable
                className="min-h-11 sm:min-h-0 max-w-[260px]"
                panelClassName="w-[320px] max-w-[calc(100vw-16px)]"
              />
            )}
          </>
        ) : (
          <span className="text-sm text-[var(--color-text-secondary)]">Срез: {selfName}</span>
        )}
        {isFetching && !isLoading && <span className="text-xs text-[var(--color-text-muted)]">Обновляю…</span>}
      </div>

      {/* Панель действий */}
      <div className="flex items-center gap-2 px-3 sm:px-6 py-2 border-b border-[var(--color-border)] flex-wrap">
        <button type="button" onClick={() => setWhatIf(w => !w)} aria-pressed={whatIf}
          className={`min-h-11 sm:min-h-9 inline-flex items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${whatIf ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
          <FlaskConical size={15} /> Что если
        </button>
        <button type="button" onClick={() => setAll(true)} className="min-h-11 sm:min-h-9 rounded-lg px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Раскрыть всё</button>
        <button type="button" onClick={() => setAll(false)} className="min-h-11 sm:min-h-9 rounded-lg px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Свернуть</button>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {computedAt && (
            <span className="text-[11px] text-[var(--color-text-muted)]" title={`Медианы — по окну ${data?.windowMonths ?? '—'} мес.`}>
              Пересчитано {computedAt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button type="button" onClick={() => recompute.mutate()} disabled={recompute.isPending}
            className="min-h-11 sm:min-h-9 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-60">
            <RefreshCw size={14} className={recompute.isPending ? 'animate-spin' : ''} /> {recompute.isPending ? 'Считаю…' : 'Пересчитать'}
          </button>
        </div>
        {recompute.error && <div className="w-full text-xs text-[var(--color-negative)]">{(recompute.error as Error).message}</div>}
      </div>

      <div className="px-3 sm:px-6 py-4 flex flex-col gap-3 max-w-6xl">
        {data?.demo && (
          <div className="rounded-lg border border-dashed border-[var(--color-border-strong)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            Демо-данные (dev): движок /api/metric-map ещё не отвечает — показана фикстура на цифрах владельца.
          </div>
        )}
        {!ready && <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Выберите {SCOPE_LABEL[scopeType].toLowerCase()} в фильтре сверху.</div>}
        {error && (
          <div className="rounded-lg border border-[var(--color-negative)]/40 px-3 py-2 text-sm text-[var(--color-negative)]">
            Не удалось загрузить карту: {(error as Error).message}
          </div>
        )}
        {ready && isLoading && <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Собираю карту…</div>}

        {data && idx && (
          <>
            <div className="text-xs text-[var(--color-text-muted)]">
              <span className="text-[var(--color-text)] font-medium">{data.scope.label}</span> · {data.period.label} · сравнение с {data.comparePeriod.label}
            </div>

            {whatIf && (
              <div className="sticky top-0 z-10 rounded-lg border border-[var(--color-accent)]/50 bg-[var(--color-bg)] px-3 py-2 flex flex-col gap-1 shadow-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-[var(--color-text)]">Эффект на «{idx.byId.get(data.rootId)?.label}»:</span>
                  <span className={`text-base font-semibold tabular-nums ${effect == null || Math.abs(effect) < 0.5 ? 'text-[var(--color-text-muted)]' : effect > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
                    {effect == null ? '—' : fmtRub(effect, true)}
                  </span>
                  {rootScen != null && nOverrides > 0 && (
                    <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtValue(rootFact, 'rub')} → {fmtValue(rootScen, 'rub')}</span>
                  )}
                  <button type="button" onClick={() => setOverrides({})} disabled={nOverrides === 0}
                    className="ml-auto min-h-11 sm:min-h-8 inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
                    <RotateCcw size={13} /> Сбросить
                  </button>
                </div>
                <p className="text-[11px] leading-snug text-[var(--color-text-muted)]">
                  Нажмите «изменить» у множителя (отмечены «×») и двигайте значение — дерево пересчитается вверх до корня. Факторы считаются независимыми:
                  например, рост CR не уменьшает число сделок и не меняет чек. В жизни они связаны, поэтому это оценка порядка, а не прогноз.
                </p>
              </div>
            )}

            <div className="rounded-xl border border-[var(--color-border)] p-1.5 sm:p-2">
              <MetricMapTree
                data={data} idx={idx}
                collapsed={effCollapsed} onToggle={toggle}
                whatIf={whatIf} scenario={scenario} overrides={overrides} onOverride={onOverride}
              />
            </div>

            <p className="text-[11px] leading-snug text-[var(--color-text-muted)] max-w-4xl">
              <b className="font-medium">Вклад в Δ</b> — на сколько рублей этот показатель изменил сумму отгрузок к периоду сравнения (вклады детей
              складываются во вклад родителя без остатка). <b className="font-medium">До медианы</b> — сколько добавит корню подтянуть показатель до медианы
              команды при прочих равных. Медиана — по менеджерам с достаточной выборкой, окно {data.windowMonths} мес. Серым — мало данных.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
