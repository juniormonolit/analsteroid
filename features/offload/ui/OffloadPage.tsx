'use client';

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { Seg } from '@/features/reports/ui/FiltersMenu';
import { DealCard } from '@/features/reports/ui/DealCard';
import { useAccountDepartments } from '@/lib/hooks/useAccountDepartments';
import type { DealScope } from '@/lib/metrics/types';
import type { OffloadTree, OffloadDealRow, StageMode } from '../engine/offload';

// «Разгрузка отделов» (задача 2635): инструмент директора по продажам. Дерево
// отдел → менеджер → открытые сделки NEW/WORK с оценкой «мёртвости» (модель
// отсечек 30.07). Этап 2: закрытие отмеченных в Битриксе (стадия C1:9) батчами
// + «Лог закрытий» (offload_close_log, миграция 109).

function fmtRub(v: number): string {
  return (Math.round(v) || 0).toLocaleString('ru-RU') + ' ₽';
}
function fmtPct(p: number | null): string {
  return p === null ? '—' : `${Math.round(p * 1000) / 10}%`;
}

interface Selected { amount: number; probability: number | null }

// Этап 2 (задача 2635): закрытие в Битриксе. Стадия и лимит батча — те же
// константы, что в движке (features/offload/engine/close.ts).
const CLOSE_STAGE_NAME = 'НЕ ТРОГАТЬ - ЗАПРЕЩЕНО (штраф 10 000 руб)';
const CLOSE_BATCH = 25;
const CLOSE_PAUSE_MS = 1500;

interface CloseResultItem { dealId: number; status: 'closed' | 'skipped' | 'error'; detail?: string }

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
  const [view, setView] = useState<'tree' | 'log'>('tree');
  // Этап 2: подтверждение/прогресс/результаты закрытия
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState<{ done: number; total: number } | null>(null);
  const [closeResults, setCloseResults] = useState<CloseResultItem[] | null>(null);
  const [closedIds, setClosedIds] = useState<Set<number>>(new Set());
  const queryClient = useQueryClient();

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

  // ПОСЛЕДОВАТЕЛЬНЫЕ чанки по 25 с паузой 1.5с (требование владельца по
  // нагрузке на Битрикс: «паковать в батчи и не отправлять слишком часто») —
  // сервер на каждый чанк делает один batch.json; прогресс — «закрыто X из Y».
  async function runClose() {
    const ids = [...selected.keys()];
    setConfirmOpen(false);
    setClosing({ done: 0, total: ids.length });
    const all: CloseResultItem[] = [];
    for (let i = 0; i < ids.length; i += CLOSE_BATCH) {
      const chunk = ids.slice(i, i + CLOSE_BATCH);
      try {
        const res = await fetch('/api/offload/close', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...filtersBody, dealIds: chunk }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        all.push(...(json.results as CloseResultItem[]));
      } catch (e) {
        for (const id of chunk) all.push({ dealId: id, status: 'error', detail: e instanceof Error ? e.message : String(e) });
      }
      setClosing({ done: Math.min(i + CLOSE_BATCH, ids.length), total: ids.length });
      if (i + CLOSE_BATCH < ids.length) await new Promise(r => setTimeout(r, CLOSE_PAUSE_MS));
    }
    setClosing(null);
    setCloseResults(all);
    setClosedIds(prev => {
      const n = new Set(prev);
      for (const r of all) if (r.status === 'closed') n.add(r.dealId);
      return n;
    });
    setSelected(new Map());
    queryClient.invalidateQueries({ queryKey: ['offload-log'] });
  }

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-3 sm:p-6 max-w-[1500px] mx-auto pb-24">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Разгрузка отделов</h1>
          <Seg<'tree' | 'log'>
            options={['tree', 'log']}
            value={view} onChange={setView}
            labels={{ tree: 'Дерево', log: 'Лог закрытий' }}
          />
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-4 max-w-[1100px]">
          Снимок текущих открытых сделок в стадиях NEW и WORK (стадии «продано/отгружено» исключены).
          «Раб. дн.» — накопленное рабочее время сделки (механика графика «В работе → продажа»); отсечки и
          вероятности — модель 30.07 по товарным группам (первичка; к повторным сделкам отсечка не применяется).
          Кнопка закрытия меняет стадию отмеченных сделок в Битриксе на «{CLOSE_STAGE_NAME}».
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

        {view === 'log' ? (
          <CloseLogView />
        ) : isLoading || (!isError && data === undefined) ? (
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
                  closedIds={closedIds}
                  onToggleDeal={toggleDeal}
                  onOpenDeal={setOpenDealId}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Плашка выбора — фиксирована снизу, появляется при отмеченных сделках.
          Регресс #2999 (04.08, проход по всплывающим поверхностям): под плашкой
          СКРОЛЛИТСЯ таблица сделок, а карточный --color-bg-surface прозрачен (68/60/
          7.5% по темам) — строки просвечивали сквозь суммы. Плотный --color-bg-overlay
          + блюр, как у BottomTabBar (та же роль: фиксированная полоса над контентом). */}
      {selectionStats.count > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] [backdrop-filter:var(--glass-blur)] shadow-2xl">
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
              onClick={() => setConfirmOpen(true)}
              disabled={closing !== null}
              className="px-3 py-1.5 text-sm rounded-lg bg-[var(--color-negative)] text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Закрыть выбранное…
            </button>
          </div>
        </div>
      )}

      {confirmOpen && (
        <ConfirmCloseModal
          stats={selectionStats}
          sample={[...selected.keys()].slice(0, 10)}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={runClose}
        />
      )}
      {closing && (
        // Регресс #2999 (04.08) — см. комментарий у ConfirmCloseModal ниже: тот же
        // самописный диалог с прозрачным фоном, тот же фикс.
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center">
          <div className="rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] px-6 py-5 text-sm text-[var(--color-text)] shadow-2xl">
            Закрываем сделки в Битриксе… обработано <b>{closing.done}</b> из <b>{closing.total}</b>
            <div className="mt-2 h-1.5 rounded bg-[var(--color-border)] overflow-hidden">
              <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${closing.total ? Math.round(closing.done / closing.total * 100) : 0}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">Батчи по {CLOSE_BATCH} с паузой — не закрывайте вкладку.</p>
          </div>
        </div>
      )}
      {closeResults && <CloseResultsModal results={closeResults} onClose={() => setCloseResults(null)} />}
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}

function ConfirmCloseModal({ stats, sample, onCancel, onConfirm }: {
  stats: { count: number; amount: number; expected: number };
  sample: number[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    // Регресс #2999 (04.08): самописный диалог подтверждения (не на <Modal>) с
    // прозрачным --color-bg-surface без backdrop-filter — контент страницы позади
    // просвечивал. Фикс — непрозрачный --color-bg, без стекла (владелец: если блюр не
    // нужен точечно, проще и безопаснее просто убрать прозрачность).
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="w-full max-w-[520px] rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-[var(--color-text)] mb-2">Закрыть отмеченные сделки?</h3>
        <div className="text-sm text-[var(--color-text-muted)] space-y-1 mb-3">
          <div>Сделок: <b className="text-[var(--color-text)]">{stats.count.toLocaleString('ru-RU')}</b></div>
          <div>Σ сумма: <b className="text-[var(--color-text)]">{fmtRub(stats.amount)}</b></div>
          <div>Упускаемая выручка (Σ P×сумма): <b className="text-[var(--color-negative)]">{fmtRub(stats.expected)}</b></div>
        </div>
        <p className="text-xs text-[var(--color-text)] bg-[var(--color-negative)]/10 border border-[var(--color-negative)]/40 rounded-lg px-3 py-2 mb-3">
          Стадия каждой сделки будет изменена в Битриксе на «{CLOSE_STAGE_NAME}» (C1:9).
          Перед записью стадия перепроверяется: изменившиеся/проданные будут пропущены.
        </p>
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
          Первые сделки: {sample.map(id => `#${id}`).join(', ')}{stats.count > sample.length ? ` и ещё ${stats.count - sample.length}` : ''}
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-sm rounded-lg bg-[var(--color-negative)] text-white hover:opacity-90">Закрыть {stats.count.toLocaleString('ru-RU')}</button>
        </div>
      </div>
    </div>
  );
}

function CloseResultsModal({ results, onClose }: { results: CloseResultItem[]; onClose: () => void }) {
  const closed = results.filter(r => r.status === 'closed').length;
  const skipped = results.filter(r => r.status === 'skipped');
  const errors = results.filter(r => r.status === 'error');
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      {/* Тот же регресс, что у ConfirmModal выше (см. комментарий там) — при первом
          фиксе этот диалог-сосед пропустили. Решение то же: непрозрачный --color-bg. */}
      <div className="w-full max-w-[560px] max-h-[80vh] overflow-y-auto rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl p-5" onClick={e => e.stopPropagation()}>
        <h3 className="font-semibold text-[var(--color-text)] mb-2">Результат закрытия</h3>
        <div className="text-sm text-[var(--color-text-muted)] mb-3">
          Закрыто: <b className="text-[var(--color-text)]">{closed}</b> · Пропущено: <b className="text-[var(--color-text)]">{skipped.length}</b> · Ошибок: <b className={errors.length ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}>{errors.length}</b>
        </div>
        {skipped.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase mb-1">Пропущено</p>
            {skipped.map(r => <div key={r.dealId} className="text-xs text-[var(--color-text-muted)]">#{r.dealId} — {r.detail}</div>)}
          </div>
        )}
        {errors.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-[var(--color-negative)] uppercase mb-1">Ошибки</p>
            {errors.map(r => <div key={r.dealId} className="text-xs text-[var(--color-negative)]">#{r.dealId} — {r.detail}</div>)}
          </div>
        )}
        <p className="text-[11px] text-[var(--color-text-muted)] mb-3">Закрытые сделки исчезнут из дерева после ближайшего синка с Битриксом; до этого они помечены серым. Записи — во вкладке «Лог закрытий».</p>
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">Готово</button>
        </div>
      </div>
    </div>
  );
}

interface CloseLogRow {
  id: number; closed_at: string; closed_by_login: string | null; deal_id: number;
  deal_name: string | null; amount: string | null; kc_group: string | null; head_group: string | null;
  manager_name: string | null; department_name: string | null; work_days: string | null;
  priced_stagnant_days: number | null; probability: string | null; was_recommended: boolean | null;
  status: string; detail: string | null;
}

function CloseLogView() {
  const { data, isLoading, isError } = useQuery<{ rows: CloseLogRow[] }>({
    queryKey: ['offload-log'],
    queryFn: async () => {
      const res = await fetch('/api/offload/log');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });
  if (isLoading) return <div className="h-40 rounded-lg bg-[var(--color-border)] animate-pulse" />;
  if (isError) return <p className="text-sm text-[var(--color-negative)]">Не удалось загрузить лог.</p>;
  const rows = data?.rows ?? [];
  if (rows.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">Закрытий ещё не было.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <table className="min-w-[1100px] w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
            <th className="px-3 py-2">Когда (МСК)</th>
            <th className="px-3 py-2">Кто</th>
            <th className="px-3 py-2">Сделка</th>
            <th className="px-3 py-2 text-right">Сумма</th>
            <th className="px-3 py-2">Группа (КЦ)</th>
            <th className="px-3 py-2">Менеджер / отдел</th>
            <th className="px-3 py-2 text-right" title="Раб. дни / дней в «Созвонился» / P(продажи) на момент закрытия">Метрики</th>
            <th className="px-3 py-2">Статус</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-b border-[var(--color-border)] last:border-b-0">
              <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">{new Date(r.closed_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</td>
              <td className="px-3 py-1.5">{r.closed_by_login ?? '—'}</td>
              <td className="px-3 py-1.5 max-w-[280px]">
                <a href={`https://td.monolit-crm.ru/crm/deal/details/${r.deal_id}/`} target="_blank" rel="noreferrer" className="text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline truncate inline-block max-w-full" title={r.deal_name ?? undefined}>
                  {r.deal_name ?? `#${r.deal_id}`}
                </a>
                <div className="text-[10px] text-[var(--color-text-muted)]">#{r.deal_id}{r.was_recommended ? ' · рекомендованная' : ''}</div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.amount === null ? '—' : fmtRub(Number(r.amount))}</td>
              <td className="px-3 py-1.5 max-w-[150px] truncate" title={r.head_group ?? undefined}>{r.kc_group ?? '—'}</td>
              <td className="px-3 py-1.5">{r.manager_name ?? '—'}<div className="text-[10px] text-[var(--color-text-muted)]">{r.department_name ?? ''}</div></td>
              <td className="px-3 py-1.5 text-right tabular-nums text-[var(--color-text-muted)]">
                {r.work_days === null ? '—' : Number(r.work_days).toLocaleString('ru-RU')} / {r.priced_stagnant_days ?? '—'} / {r.probability === null ? '—' : fmtPct(Number(r.probability))}
              </td>
              <td className={`px-3 py-1.5 ${r.status === 'closed' ? 'text-[var(--color-text)]' : r.status === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`} title={r.detail ?? undefined}>
                {r.status === 'closed' ? 'закрыта' : r.status === 'skipped' ? 'пропущена' : 'ошибка'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeptBlock({ dept, open, onToggle, openManagers, onToggleManager, filtersBody, stageMode, selected, closedIds, onToggleDeal, onOpenDeal }: {
  dept: OffloadTree['departments'][number];
  open: boolean;
  onToggle: () => void;
  openManagers: Set<string>;
  onToggleManager: (id: string) => void;
  filtersBody: Record<string, unknown>;
  stageMode: StageMode;
  selected: Map<number, Selected>;
  closedIds: Set<number>;
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
              selected={selected} closedIds={closedIds} onToggleDeal={onToggleDeal} onOpenDeal={onOpenDeal}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ManagerBlock({ manager, open, onToggle, filtersBody, stageMode, selected, closedIds, onToggleDeal, onOpenDeal }: {
  manager: OffloadTree['departments'][number]['managers'][number];
  open: boolean;
  onToggle: () => void;
  filtersBody: Record<string, unknown>;
  stageMode: StageMode;
  selected: Map<number, Selected>;
  closedIds: Set<number>;
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
                  <tr key={d.dealId} className={`border-t border-[var(--color-border)] ${closedIds.has(d.dealId) ? 'opacity-45' : d.recommended ? 'bg-[var(--color-negative)]/8' : ''}`}>
                    <td className="px-2 py-1.5 align-top">
                      {closedIds.has(d.dealId)
                        ? <span className="text-[10px] text-[var(--color-text-muted)]" title="Закрыта — исчезнет из списка после синка с Битриксом">закрыто</span>
                        : <input
                            type="checkbox"
                            checked={selected.has(d.dealId)}
                            onChange={() => onToggleDeal(d)}
                            aria-label={`Отметить сделку ${d.dealId}`}
                          />}
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
