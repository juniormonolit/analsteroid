'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { DealCard } from '@/features/reports/ui/DealCard';
import { useAccountDepartments } from '@/lib/hooks/useAccountDepartments';
import type { DealScope } from '@/lib/metrics/types';
import type { OffloadTree, OffloadDealRow, StageMode } from '../engine/offload';

// «Разгрузка отделов» (задача 2635, ЭТАП 1 — read-only): инструмент директора по
// продажам. Дерево отдел → менеджер → открытые сделки NEW/WORK с оценкой
// «мёртвости» (модель отсечек 30.07). Кнопка закрытия — этап 2 (задизейблена).

function fmtRub(v: number): string {
  return (Math.round(v) || 0).toLocaleString('ru-RU') + ' ₽';
}
function fmtPct(p: number | null): string {
  return p === null ? '—' : `${Math.round(p * 1000) / 10}%`;
}

interface Selected { amount: number; probability: number | null }

export function OffloadPage() {
  const [dealScope, setDealScope] = useState<DealScope>('all');
  const [stageMode, setStageMode] = useState<StageMode>('both');
  const { departmentIds, ready: departmentsReady, setDepartmentIds } = useAccountDepartments();
  // «Чек от/до» — тот же паттерн, что раздел «Графики» (черновик → применение по Enter/blur)
  const [amountFromStr, setAmountFromStr] = useState('');
  const [amountToStr, setAmountToStr] = useState('');
  const [amountFrom, setAmountFrom] = useState<number | undefined>();
  const [amountTo, setAmountTo] = useState<number | undefined>();
  const draftFrom = amountFromStr.trim() === '' ? undefined : Number(amountFromStr.replace(',', '.'));
  const draftTo = amountToStr.trim() === '' ? undefined : Number(amountToStr.replace(',', '.'));
  const amountInvalid =
    (draftFrom !== undefined && (!Number.isFinite(draftFrom) || draftFrom < 0)) ||
    (draftTo !== undefined && (!Number.isFinite(draftTo) || draftTo < 0)) ||
    (draftFrom !== undefined && draftTo !== undefined && Number.isFinite(draftFrom) && Number.isFinite(draftTo) && draftFrom > draftTo);
  const applyAmount = () => {
    if (amountInvalid) return;
    setAmountFrom(draftFrom !== undefined && Number.isFinite(draftFrom) ? draftFrom : undefined);
    setAmountTo(draftTo !== undefined && Number.isFinite(draftTo) ? draftTo : undefined);
  };

  const [openDepts, setOpenDepts] = useState<Set<string>>(new Set());
  const [openManagers, setOpenManagers] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<number, Selected>>(new Map());
  const [openDealId, setOpenDealId] = useState<number | null>(null);

  const filtersBody = { dealScope, departmentIds, amountFrom, amountTo };

  const { data, isLoading, isError } = useQuery<{ result: OffloadTree }>({
    queryKey: ['offload-tree', dealScope, departmentIds, amountFrom, amountTo],
    queryFn: async () => {
      const res = await fetch('/api/offload/tree', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filtersBody),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: departmentsReady,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const tree = data?.result ?? null;

  const selectionStats = useMemo(() => {
    let count = 0, amount = 0, expected = 0;
    for (const s of selected.values()) {
      count++;
      amount += s.amount;
      expected += (s.probability ?? 0) * s.amount;
    }
    return { count, amount, expected };
  }, [selected]);

  function toggleDeal(deal: { dealId: number; amount: number; probability: number | null }) {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(deal.dealId)) next.delete(deal.dealId);
      else next.set(deal.dealId, { amount: deal.amount, probability: deal.probability });
      return next;
    });
  }

  // «Выделить все рекомендованные» — по данным дерева (raскрытие не требуется):
  // tree несёт recommendedDeals каждого менеджера.
  function selectAllRecommended() {
    if (!tree) return;
    setSelected(prev => {
      const next = new Map(prev);
      for (const dept of tree.departments) {
        for (const m of dept.managers) {
          for (const d of m.recommendedDeals) next.set(d.dealId, { amount: d.amount, probability: d.probability });
        }
      }
      return next;
    });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 sm:p-6 max-w-[1500px] mx-auto pb-24">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Разгрузка отделов</h1>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-4 max-w-[1100px]">
          Снимок текущих открытых сделок в стадиях NEW и WORK (стадии «продано/отгружено» исключены).
          «Раб. дн.» — накопленное рабочее время сделки (механика графика «В работе → продажа»); отсечки и
          вероятности — модель 30.07 по товарным группам (первичка; к повторным сделкам отсечка не применяется).
          Закрытие сделок в Битриксе — этап 2, кнопка пока неактивна.
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-4">
          <DepartmentPicker departmentIds={departmentIds} onDepartmentIdsChange={setDepartmentIds} />
          <Seg<DealScope>
            options={['primary', 'repeat', 'all']}
            value={dealScope} onChange={setDealScope}
            labels={{ primary: 'Первичные', repeat: 'Повторные', all: 'Все' }}
          />
          <Seg<StageMode>
            options={['both', 'work', 'new']}
            value={stageMode} onChange={setStageMode}
            labels={{ both: 'Work + New', work: 'Только Work', new: 'Только New' }}
          />
          <div
            className={`flex items-center gap-1.5 border rounded-lg px-2 py-1 text-sm bg-[var(--color-bg-surface)] ${amountInvalid ? 'border-[var(--color-negative)]' : 'border-[var(--color-border)]'}`}
            title="Фильтр по сумме сделки (d.amount)"
          >
            <span className="text-[var(--color-text-muted)] text-xs whitespace-nowrap">Чек от</span>
            <input value={amountFromStr} onChange={e => setAmountFromStr(e.target.value)} onBlur={applyAmount}
              onKeyDown={e => { if (e.key === 'Enter') applyAmount(); }} placeholder="0" inputMode="numeric" aria-label="Чек от"
              className="w-20 bg-transparent outline-none text-[var(--color-text)] tabular-nums" />
            <span className="text-[var(--color-text-muted)] text-xs">до</span>
            <input value={amountToStr} onChange={e => setAmountToStr(e.target.value)} onBlur={applyAmount}
              onKeyDown={e => { if (e.key === 'Enter') applyAmount(); }} placeholder="∞" inputMode="numeric" aria-label="Чек до"
              className="w-20 bg-transparent outline-none text-[var(--color-text)] tabular-nums" />
          </div>
          <button
            onClick={selectAllRecommended}
            disabled={!tree || tree.totals.recommendedCount === 0}
            className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-40 transition-colors"
          >
            Выделить рекомендованные{tree ? ` (${tree.totals.recommendedCount.toLocaleString('ru-RU')})` : ''}
          </button>
        </div>

        {isLoading || (!isError && data === undefined) ? (
          <div className="h-[300px] rounded-lg bg-[var(--color-border)] animate-pulse" />
        ) : isError ? (
          <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить данные.</p>
        ) : !tree || tree.departments.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">Нет открытых сделок под выбранные фильтры.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-5 gap-y-1 mb-4 text-xs text-[var(--color-text-muted)]">
              <span>Всего WORK: <b className="text-[var(--color-text)]">{tree.totals.workCount.toLocaleString('ru-RU')}</b></span>
              <span>Всего NEW: <b className="text-[var(--color-text)]">{tree.totals.newCount.toLocaleString('ru-RU')}</b></span>
              <span>WORK + NEW: <b className="text-[var(--color-text)]">{tree.totals.totalCount.toLocaleString('ru-RU')}</b></span>
              <span>Σ сумма открытых: <b className="text-[var(--color-text)]">{fmtRub(tree.totals.totalAmount)}</b></span>
              <span>За отсечкой: <b className="text-[var(--color-negative)]">{tree.totals.recommendedCount.toLocaleString('ru-RU')}</b> на <b className="text-[var(--color-negative)]">{fmtRub(tree.totals.recommendedAmount)}</b></span>
            </div>

            <div className="flex flex-col gap-2">
              {tree.departments.map(dept => (
                <DeptBlock
                  key={dept.departmentId}
                  dept={dept}
                  open={openDepts.has(dept.departmentId)}
                  onToggle={() => setOpenDepts(p => { const n = new Set(p); if (n.has(dept.departmentId)) n.delete(dept.departmentId); else n.add(dept.departmentId); return n; })}
                  openManagers={openManagers}
                  onToggleManager={id => setOpenManagers(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
                  filtersBody={filtersBody}
                  stageMode={stageMode}
                  selected={selected}
                  onToggleDeal={toggleDeal}
                  onOpenDeal={setOpenDealId}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Плашка выбора — фиксирована снизу, появляется при отмеченных сделках */}
      {selectionStats.count > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-2xl">
          <div className="max-w-[1500px] mx-auto px-3 sm:px-6 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="text-[var(--color-text-muted)]">Отмечено: <b className="text-[var(--color-text)]">{selectionStats.count.toLocaleString('ru-RU')}</b></span>
            <span className="text-[var(--color-text-muted)]">Σ сумма: <b className="text-[var(--color-text)]">{fmtRub(selectionStats.amount)}</b></span>
            <span className="text-[var(--color-text-muted)]" title="Σ P(продажа) × сумма по отмеченным — ожидаемая выручка, которую закрытие упустит">
              Упускаемая выручка: <b className="text-[var(--color-negative)]">{fmtRub(selectionStats.expected)}</b>
            </span>
            <div className="flex-1" />
            <button onClick={() => setSelected(new Map())} className="px-2.5 py-1 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
              Снять всё
            </button>
            <button
              disabled
              title="Закрытие сделок в Битриксе — этап 2, скоро"
              className="px-3 py-1.5 text-sm rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] opacity-40 cursor-not-allowed"
            >
              Закрыть выбранные (скоро)
            </button>
          </div>
        </div>
      )}

      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}

function DeptBlock({ dept, open, onToggle, openManagers, onToggleManager, filtersBody, stageMode, selected, onToggleDeal, onOpenDeal }: {
  dept: OffloadTree['departments'][number];
  open: boolean;
  onToggle: () => void;
  openManagers: Set<string>;
  onToggleManager: (id: string) => void;
  filtersBody: Record<string, unknown>;
  stageMode: StageMode;
  selected: Map<number, Selected>;
  onToggleDeal: (d: { dealId: number; amount: number; probability: number | null }) => void;
  onOpenDeal: (id: number) => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <button onClick={onToggle} className="w-full flex flex-wrap items-center gap-x-4 gap-y-1 px-3 sm:px-4 py-2.5 text-left hover:bg-[var(--color-bg-hover)] rounded-xl transition-colors">
        {open ? <ChevronDown size={16} className="text-[var(--color-text-muted)] shrink-0" /> : <ChevronRight size={16} className="text-[var(--color-text-muted)] shrink-0" />}
        <span className="font-semibold text-sm text-[var(--color-text)]">{dept.departmentName}</span>
        {dept.branch && <span className="text-xs text-[var(--color-text-muted)]">{dept.branch}</span>}
        <span className="text-xs text-[var(--color-text-muted)]">work <b className="text-[var(--color-text)]">{dept.workCount.toLocaleString('ru-RU')}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">new <b className="text-[var(--color-text)]">{dept.newCount.toLocaleString('ru-RU')}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">всего <b className="text-[var(--color-text)]">{dept.totalCount.toLocaleString('ru-RU')}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">в ср. на менеджера <b className="text-[var(--color-text)]">{dept.avgPerManager.toLocaleString('ru-RU')}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">Σ <b className="text-[var(--color-text)]">{fmtRub(dept.totalAmount)}</b></span>
        {dept.recommendedCount > 0 && (
          <span className="text-xs text-[var(--color-negative)]">за отсечкой <b>{dept.recommendedCount.toLocaleString('ru-RU')}</b> · {fmtRub(dept.recommendedAmount)}</span>
        )}
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)]">
          {dept.managers.map(m => (
            <ManagerBlock
              key={m.managerId} manager={m}
              open={openManagers.has(m.managerId)}
              onToggle={() => onToggleManager(m.managerId)}
              filtersBody={filtersBody} stageMode={stageMode}
              selected={selected} onToggleDeal={onToggleDeal} onOpenDeal={onOpenDeal}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ManagerBlock({ manager, open, onToggle, filtersBody, stageMode, selected, onToggleDeal, onOpenDeal }: {
  manager: OffloadTree['departments'][number]['managers'][number];
  open: boolean;
  onToggle: () => void;
  filtersBody: Record<string, unknown>;
  stageMode: StageMode;
  selected: Map<number, Selected>;
  onToggleDeal: (d: { dealId: number; amount: number; probability: number | null }) => void;
  onOpenDeal: (id: number) => void;
}) {
  const { data, isLoading } = useQuery<{ deals: OffloadDealRow[] }>({
    queryKey: ['offload-deals', manager.managerId, stageMode, filtersBody],
    queryFn: async () => {
      const res = await fetch('/api/offload/deals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filtersBody, managerId: manager.managerId, stageMode }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button onClick={onToggle} className="w-full flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-7 sm:pl-9 pr-3 py-2 text-left hover:bg-[var(--color-bg-hover)] transition-colors">
        {open ? <ChevronDown size={14} className="text-[var(--color-text-muted)] shrink-0" /> : <ChevronRight size={14} className="text-[var(--color-text-muted)] shrink-0" />}
        <span className="text-sm text-[var(--color-text)]">{manager.managerName}</span>
        {manager.shortLogin && <span className="text-[11px] text-[var(--color-text-muted)]">#{manager.shortLogin}</span>}
        <span className="text-xs text-[var(--color-text-muted)]">new <b className="text-[var(--color-text)]">{manager.newCount}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">work <b className="text-[var(--color-text)]">{manager.workCount}</b></span>
        <span className="text-xs text-[var(--color-text-muted)]">Σ <b className="text-[var(--color-text)]">{fmtRub(manager.totalAmount)}</b></span>
        {manager.recommendedCount > 0 && (
          <span className="text-xs text-[var(--color-negative)]">за отсечкой <b>{manager.recommendedCount}</b></span>
        )}
      </button>
      {open && (
        <div className="pl-4 sm:pl-8 pr-2 pb-3 overflow-x-auto">
          {isLoading ? (
            <div className="h-16 rounded bg-[var(--color-border)] animate-pulse" />
          ) : !data || data.deals.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] px-3 py-2">Нет сделок под текущий режим.</p>
          ) : (
            <table className="min-w-[1150px] w-full text-xs">
              <thead>
                <tr className="text-[var(--color-text-muted)] text-left">
                  <th className="px-2 py-1.5 w-7"></th>
                  <th className="px-2 py-1.5">Сделка</th>
                  <th className="px-2 py-1.5 text-right">Сумма</th>
                  <th className="px-2 py-1.5">Группа (КЦ)</th>
                  <th className="px-2 py-1.5 text-right" title="Медианные рабочие дни товарной группы (шкала модели) до продажи / до отказа / до любого завершения">Медианы гр., дн (прод/отк/люб)</th>
                  <th className="px-2 py-1.5 text-right" title="Дней в стадии «Созвонился и озвучил цены» без смены стадии (по deal_events, история с 03.04.2026)">В «Созвонился» без движ.</th>
                  <th className="px-2 py-1.5 text-right" title="Накопленные рабочие дни сделки в WORK-стадиях (механика графиков)">Раб. дн.</th>
                  <th className="px-2 py-1.5 text-right" title="Отсечка товарной группы (модель 30.07) и превышение">Отсечка</th>
                  <th className="px-2 py-1.5 text-right" title="P(продажа | сделка дожила до своих раб. дней, товарная группа) — историческая модель; для повторки не считается">P(продажи)</th>
                </tr>
              </thead>
              <tbody>
                {data.deals.map(d => (
                  <tr key={d.dealId} className={`border-t border-[var(--color-border)] ${d.recommended ? 'bg-[var(--color-negative)]/8' : ''}`}>
                    <td className="px-2 py-1.5 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(d.dealId)}
                        onChange={() => onToggleDeal(d)}
                        aria-label={`Отметить сделку ${d.dealId}`}
                      />
                    </td>
                    <td className="px-2 py-1.5 max-w-[360px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <button onClick={() => onOpenDeal(d.dealId)} className="truncate text-left text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline" title={d.dealName}>
                          {d.dealName}
                        </button>
                        <a href={`https://td.monolit-crm.ru/crm/deal/details/${d.dealId}/`} target="_blank" rel="noreferrer"
                          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]" title="Открыть в Битриксе">
                          <ExternalLink size={12} />
                        </a>
                      </div>
                      <div className="text-[10px] text-[var(--color-text-muted)]">
                        #{d.dealId} · {d.stageName}{d.isRepeat ? ' · повторная' : ''}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium text-[var(--color-text)]">{fmtRub(d.amount)}</td>
                    <td className="px-2 py-1.5 max-w-[170px] truncate" title={`КЦ: ${d.kcGroup} · модель (по наибольшему): ${d.headGroup}`}>{d.kcGroup}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">
                      {d.medianSaleDays ?? '—'} / {d.medianLossDays ?? '—'} / {d.medianCloseDays ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.pricedStagnantDays === null ? '—' : d.pricedStagnantDays}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium text-[var(--color-text)]">{d.workDays.toLocaleString('ru-RU')}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${d.recommended ? 'text-[var(--color-negative)] font-semibold' : 'text-[var(--color-text-muted)]'}`}
                      title={d.recommended ? `Рекомендовано к закрытию: ${d.daysOverCutoff.toLocaleString('ru-RU')} дн. за отсечкой ${d.cutoffDays}` : (d.isRepeat ? 'Повторная — отсечка не применяется' : `Отсечка группы: ${d.cutoffDays} дн.`)}>
                      {d.isRepeat ? '—' : (d.recommended ? `+${Math.round(d.daysOverCutoff)} / ${d.cutoffDays}` : `${d.cutoffDays}`)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{fmtPct(d.probability)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
