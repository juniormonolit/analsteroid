'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ManagersResult } from '../../engine/sheetFact';
import type { FunnelSplit } from '../../sheets';
import { C } from './theme';
import {
  Card, CardHead, HeatLegend, Kpi, Loading, Notice, PlanFactTable, Seg, Select, fetchJson, fmtDelta, fmtPct, fmtVal, ratioColor, toneColor,
  type Density, type MoneyUnit, type TableLine, type ViewMode,
} from './shared';

// Вкладка «Менеджеры»: план отгрузок/продаж по менеджерам из листа «Менеджеры»
// (Bitrix user id из «Справочников») против факта по тем же менеджерам.

const SCOPE_LABELS: Record<string, string> = { zero_cycle: 'СПБ НЦ', stroy: 'СПБ ОС', msk: 'МСК', krd: 'КРД', new: 'Новые' };

export function ManagersView({ split, view, money, density }: { split: FunnelSplit; view: ViewMode; money: MoneyUnit; density: Density }) {
  const [blockKey, setBlockKey] = useState<'ship_sum' | 'sales_sum'>('ship_sum');
  const [scope, setScope] = useState<string>('all');
  const [q, setQ] = useState('');

  const { data, isLoading, isError, error } = useQuery<ManagersResult>({
    queryKey: ['decomposition-managers'],
    queryFn: () => fetchJson<ManagersResult>('/api/decomposition/managers'),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const block = data?.blocks.find(b => b.key === blockKey);
  const splitData = block?.splits[split];
  const scopes = useMemo(() => {
    const s = new Set<string>();
    for (const r of splitData?.rows ?? []) if (r.scope) s.add(r.scope);
    return [...s];
  }, [splitData]);

  const lines = useMemo<TableLine[]>(() => {
    if (!splitData) return [];
    const needle = q.trim().toLowerCase();
    const rows = splitData.rows
      .filter(r => scope === 'all' || r.scope === scope)
      .filter(r => !needle || r.label.toLowerCase().includes(needle))
      .sort((a, b) => (b.planYear ?? 0) - (a.planYear ?? 0) || (b.factYtd ?? 0) - (a.factYtd ?? 0));
    // ИТОГО — по отфильтрованным строкам, чтобы фильтр по отделу давал свой итог.
    const planMonths = new Array(12).fill(0) as number[];
    const factMonths = new Array(12).fill(0) as number[];
    let planToDate = 0, factYtd = 0, planYear = 0, anyFact = false;
    for (const r of rows) {
      r.planMonths?.forEach((v, i) => { planMonths[i] += v; });
      r.factMonths.forEach((v, i) => { if (v !== null) { factMonths[i] += v; anyFact = true; } });
      planToDate += r.planToDate ?? 0; factYtd += r.factYtd ?? 0; planYear += r.planYear ?? 0;
    }
    const cur = data?.currentMonth ?? -1;
    const total: TableLine = {
      key: '__total__', label: scope === 'all' ? 'ИТОГО' : `ИТОГО (${SCOPE_LABELS[scope] ?? scope})`, level: 'total',
      planMonths, planYear, factMonths: factMonths.map((v, i) => (i <= cur && anyFact ? v : null)), factYtd: anyFact ? factYtd : null, planToDate,
    };
    return [total, ...rows.map(r => ({
      key: r.key, label: r.label, level: 'row' as const, planMonths: r.planMonths, planYear: r.planYear, factMonths: r.factMonths,
      factYtd: r.factYtd, planToDate: r.planToDate, muted: !r.inOrg,
      note: !r.inOrg ? 'Менеджера нет среди активных в оргструктуре — факт не привязан.' : (r.scope ? SCOPE_LABELS[r.scope] ?? r.scope : undefined),
    }))];
  }, [splitData, scope, q, data?.currentMonth]);

  if (isLoading) return <Loading text="Считаем факт по менеджерам…" />;
  if (isError) return <Notice tone="error">Не удалось загрузить: {(error as Error)?.message}</Notice>;
  if (!data || !block || !splitData) return null;

  const total = lines[0];
  const delta = total && total.factYtd !== null && total.planToDate !== null ? total.factYtd - total.planToDate : null;

  return (
    <Card>
      <CardHead
        title="Менеджеры"
        hint={`лист «Менеджеры» · ${blockKey === 'ship_sum' ? 'отгрузки' : 'продажи'}${split !== 'all' ? split === 'primary' ? ' · первичные' : ' · повторные' : ''}`}
        right={
          <>
            <Seg onSurface value={blockKey} onChange={setBlockKey} options={[{ v: 'ship_sum', label: 'Отгрузки' }, { v: 'sales_sum', label: 'Продажи' }]} />
            <Select
              value={scope}
              onChange={setScope}
              options={[{ v: 'all', label: 'Все отделы' }, ...scopes.map(s => ({ v: s, label: SCOPE_LABELS[s] ?? s }))]}
            />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Поиск"
              className="h-10 w-full rounded-[10px] border-0 px-3.5 text-base font-medium outline-none sm:w-44 sm:text-[14px]"
              style={{ background: C.mutedBg, color: C.text }}
            />
          </>
        }
      />
      {total && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
          <Kpi label="План к дате" value={fmtVal(total.planToDate, 'money', money)} sub={money === 'mln' ? 'млн ₽' : '₽'} />
          <Kpi label="Факт с начала года" value={fmtVal(total.factYtd, 'money', money)} sub={`выполнение ${fmtPct(total.factYtd, total.planToDate)}`} color={ratioColor(total.factYtd, total.planToDate)} />
          <Kpi label="Отклонение" value={fmtDelta(delta, 'money', money)} sub="факт − план к дате" color={toneColor(delta)} />
          <Kpi label="План на год" value={fmtVal(total.planYear, 'money', money)} sub={`менеджеров: ${lines.length - 1}`} />
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <HeatLegend />
        <PlanFactTable lines={lines} cal={data} kind="sum" unit="money" money={money} view={view} density={density} emptyText="Никого не нашли." />
      </div>
      <p className="mt-3 max-w-4xl text-[12px] font-medium" style={{ color: C.muted }}>
        План — лист «Менеджеры» файла «{data.sourceFile}» (сопоставление с Bitrix по «Справочникам»). Факт — суммы сделок менеджера
        по дате {blockKey === 'ship_sum' ? 'отгрузки' : 'продажи'}; первичные/повторные — по воронке. Строки без привязки к оргструктуре
        приглушены. «ИТОГО» — по строкам, оставшимся после фильтра.
      </p>
    </Card>
  );
}
