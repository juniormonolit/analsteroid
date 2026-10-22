'use client';

// «Ещё → Источники» (задача владельца 22.10): инструмент структуризации маркетинговых
// источников. Руководитель маркетинга сам заводит ГРУППИРОВКИ (оси разреза), в каждой —
// ГРУППЫ, и раскладывает по ним source_id Битрикса; источнику можно дать понятное
// название и заметку. На этой структуре строится «Маркетинг» (измерение `g:<id>`).
// API — app/api/marketing/structure. Аудит UI 22.10 (Fable): выбор всех отфильтрованных,
// shift-диапазон, плавающая панель действий, sticky-шапка, карточки на телефоне,
// быстрые фильтры (новые/системные/мёртвые), «Без сделок» вместо даты, доли групп.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, RefreshCw, BarChart3, Search, X, Layers } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SortableTh } from '@/components/ui/SortableTh';
import { GsColorPickerButton } from '@/components/ui/GsColorPicker';

interface Grouping { id: number; name: string; sort: number; builtinKey: string | null }
interface Group { id: number; groupingId: number; name: string; color: string | null; sort: number }
interface Source {
  sourceId: string; name: string; category: string; note: string | null; inDirectory: boolean;
  deals: number; deals90: number; lastAt: string | null;
  assign: Record<number, number>;
}
interface Structure { groupings: Grouping[]; groups: Group[]; sources: Source[]; statsOk: boolean }

type Op = Record<string, unknown> & { op: string };
type SortKey = 'name' | 'group' | 'deals90' | 'deals' | 'idle';
type Status = 'all' | 'new' | 'system' | 'active' | 'dead';
type ShownGroup = Group & { shown: string };

const UNASSIGNED = '__none__';
const ALL = '';
const NEW_GROUP = '__new__';
const PAGE = 200;
const DAY = 24 * 60 * 60 * 1000;
// Цвета групп по умолчанию — строка «тёмный 1» стандартной палитры Google Sheets («Основная
// палитра» проекта). Группе без своего цвета достаётся цвет по её месту в группировке.
const GROUP_COLORS = ['#3c78d8', '#e69138', '#6aa84f', '#cc0000', '#674ea7', '#45818e', '#f1c232', '#a64d79', '#3d85c6', '#999999'];

const btn = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const btnPrimary = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-text-inverse)] hover:opacity-90 disabled:opacity-50';
const btnGhost = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const input = 'min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:text-sm';
const WARN = 'var(--color-warning,#e69138)';

const fmtInt = (n: number) => n.toLocaleString('ru-RU');
const displayName = (s: Source) => (s.name && s.name !== s.sourceId ? s.name : `#${s.sourceId}`);
const idleDays = (s: Source) => (s.lastAt ? Math.max(0, Math.floor((Date.now() - new Date(s.lastAt).getTime()) / DAY)) : Infinity);
function fmtIdle(d: number): string {
  if (d === Infinity) return 'не было';
  if (d === 0) return 'сегодня';
  if (d < 31) return `${d} дн.`;
  if (d < 365) return `${Math.round(d / 30)} мес.`;
  return `${(d / 365).toFixed(1).replace('.0', '').replace('.', ',')} г.`;
}

export function MarketingSourcesPage() {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['marketing-structure'],
    queryFn: async () => {
      const r = await fetch('/api/marketing/structure');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      return r.json() as Promise<Structure>;
    },
  });

  const [opError, setOpError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: async (body: Op) => {
      const r = await fetch('/api/marketing/structure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      return j as { ok: true; id?: number; added?: number; total?: number };
    },
    onMutate: () => setOpError(null),
    onError: (e: Error) => setOpError(e.message),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing-structure'] });
      // Справочник отчётов (селекторы «Сущность», раскладка дрилл-дауна).
      qc.invalidateQueries({ queryKey: ['marketing-sources'] });
    },
  });

  // ── Группировка и её группы ────────────────────────────────────────────────
  const groupings = useMemo(() => data?.groupings ?? [], [data]);
  const [pickedGrouping, setPickedGrouping] = useState<number | null>(null);
  const groupingId = groupings.some(g => g.id === pickedGrouping) ? pickedGrouping! : (groupings[0]?.id ?? null);
  const grouping = groupings.find(g => g.id === groupingId) ?? null;
  const groups: ShownGroup[] = useMemo(
    () => (data?.groups ?? []).filter(g => g.groupingId === groupingId)
      .map((g, i) => ({ ...g, shown: g.color ?? GROUP_COLORS[i % GROUP_COLORS.length] })),
    [data, groupingId],
  );
  const groupById = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups]);
  const sources = useMemo(() => data?.sources ?? [], [data]);
  const liveGroupOf = useCallback(
    (s: Source) => { const g = groupingId !== null ? s.assign[groupingId] : undefined; return g !== undefined && groupById.has(g) ? g : undefined; },
    [groupingId, groupById],
  );

  // ── Фильтры, сортировка, выбор ─────────────────────────────────────────────
  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [status, setStatus] = useState<Status>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'deals90', dir: 'desc' });
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastClicked = useRef<string | null>(null);

  const statusOk = useCallback((s: Source, st: Status) =>
    st === 'all' ? true
      : st === 'new' ? !s.inDirectory
      : st === 'system' ? s.category !== 'marketing'
      : st === 'active' ? s.deals90 > 0
      : idleDays(s) > 90,
  []);

  const counts = useMemo(() => {
    const m = new Map<string, { n: number; d90: number }>();
    const bump = (k: string, s: Source) => { const c = m.get(k) ?? { n: 0, d90: 0 }; c.n++; c.d90 += s.deals90; m.set(k, c); };
    for (const s of sources) {
      bump(ALL, s);
      const g = liveGroupOf(s);
      bump(g !== undefined ? String(g) : UNASSIGNED, s);
    }
    return m;
  }, [sources, liveGroupOf]);
  const inGroupFilter = useCallback((s: Source) =>
    groupFilter === ALL || (groupFilter === UNASSIGNED ? liveGroupOf(s) === undefined : String(liveGroupOf(s)) === groupFilter),
  [groupFilter, liveGroupOf]);
  const statusCounts = useMemo(() => {
    const inGroup = sources.filter(inGroupFilter);
    return Object.fromEntries((['all', 'new', 'system', 'active', 'dead'] as Status[]).map(st => [st, inGroup.filter(s => statusOk(s, st)).length])) as Record<Status, number>;
  }, [sources, inGroupFilter, statusOk]);
  const maxGroupD90 = Math.max(1, ...groups.map(g => counts.get(String(g.id))?.d90 ?? 0), counts.get(UNASSIGNED)?.d90 ?? 0);
  const unassignedActive = useMemo(() => sources.filter(s => s.deals90 > 0 && liveGroupOf(s) === undefined).length, [sources, liveGroupOf]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = sources.filter(s => {
      if (!statusOk(s, status) || !inGroupFilter(s)) return false;
      if (needle && !`${s.name} ${s.sourceId} ${s.note ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const k = sort.key; const sign = sort.dir === 'asc' ? 1 : -1;
    const gName = (s: Source) => { const g = liveGroupOf(s); return g !== undefined ? groupById.get(g)!.name : '￿'; };
    rows.sort((a, b) => {
      let c = 0;
      if (k === 'name') c = displayName(a).localeCompare(displayName(b), 'ru');
      else if (k === 'group') c = gName(a).localeCompare(gName(b), 'ru');
      else if (k === 'idle') { const x = idleDays(a), y = idleDays(b); c = x === y ? 0 : x > y ? 1 : -1; }
      else c = a[k] - b[k];
      return c * sign || b.deals - a.deals;
    });
    return rows;
  }, [sources, q, status, sort, liveGroupOf, groupById, statusOk, inGroupFilter]);

  const visible = filtered.slice(0, limit);
  const maxD90 = Math.max(1, ...visible.map(s => s.deals90));
  const allVisibleSelected = visible.length > 0 && visible.every(s => selected.has(s.sourceId));
  const allFilteredSelected = filtered.length > 0 && filtered.every(s => selected.has(s.sourceId));
  const filtersOn = q !== '' || status !== 'all' || groupFilter !== ALL;
  const resetFilters = () => { setQ(''); setStatus('all'); setGroupFilter(ALL); setLimit(PAGE); };

  const toggleSort = (key: SortKey) => setSort(p => p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'group' ? 'asc' : 'desc' });
  // Клик по строке/чекбоксу: shift — диапазон от последнего клика (в текущем порядке строк).
  function toggleRow(id: string, shift: boolean) {
    setSelected(prev => {
      const n = new Set(prev);
      const on = !prev.has(id);
      const a = shift && lastClicked.current ? visible.findIndex(s => s.sourceId === lastClicked.current) : -1;
      const b = visible.findIndex(s => s.sourceId === id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          if (on) n.add(visible[i].sourceId); else n.delete(visible[i].sourceId);
        }
      } else if (on) n.add(id); else n.delete(id);
      return n;
    });
    lastClicked.current = id;
  }
  const toggleAllVisible = () => setSelected(p => {
    const n = new Set(p);
    if (allVisibleSelected) visible.forEach(s => n.delete(s.sourceId)); else visible.forEach(s => n.add(s.sourceId));
    return n;
  });
  const clearSelection = useCallback(() => { setSelected(new Set()); lastClicked.current = null; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);

  const groupOptions = groups.map(g => ({ value: String(g.id), label: g.name }));
  const assign = (sourceIds: string[], groupId: number | null, after?: () => void) => {
    if (groupingId === null || sourceIds.length === 0) return;
    mut.mutate({ op: 'assign', groupingId, sourceIds, groupId }, {
      onSuccess: () => {
        if (sourceIds.length > 1) {
          const g = groupId !== null ? groupById.get(groupId)?.name : null;
          setNotice(g ? `${fmtInt(sourceIds.length)} ист. → «${g}»` : `${fmtInt(sourceIds.length)} ист. убраны из групп`);
        }
        after?.();
      },
    });
  };

  // ── Диалоги ────────────────────────────────────────────────────────────────
  const [nameDialog, setNameDialog] = useState<
    | { kind: 'grouping.create' | 'grouping.update'; id?: number; name: string }
    | { kind: 'group.create' | 'group.update'; id?: number; name: string; color: string; assignSelected?: boolean }
    | null>(null);
  const [sourceDialog, setSourceDialog] = useState<{ sourceId: string; name: string; note: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; body: Op } | null>(null);
  const [groupsModal, setGroupsModal] = useState(false);
  const nextColor = () => GROUP_COLORS.find(c => !groups.some(g => g.shown === c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length];
  const newGroup = (assignSelected = false) => setNameDialog({ kind: 'group.create', name: '', color: nextColor(), assignSelected });
  const editSource = (s: Source) => setSourceDialog({ sourceId: s.sourceId, name: s.name && s.name !== s.sourceId ? s.name : '', note: s.note ?? '' });

  function submitNameDialog() {
    if (!nameDialog || !nameDialog.name.trim()) return;
    const d = nameDialog;
    let body: Op;
    if (!('color' in d)) body = d.kind === 'grouping.create' ? { op: d.kind, name: d.name } : { op: d.kind, id: d.id, name: d.name };
    else body = d.kind === 'group.create' ? { op: d.kind, groupingId, name: d.name, color: d.color } : { op: d.kind, id: d.id, name: d.name, color: d.color };
    mut.mutate(body, {
      onSuccess: (r) => {
        setNameDialog(null);
        if (d.kind === 'grouping.create' && r.id) { setPickedGrouping(r.id); setGroupFilter(ALL); clearSelection(); }
        // «+ Новая группа…» из панели выбора: сразу кладём в неё отмеченные источники.
        if ('assignSelected' in d && d.assignSelected && r.id && selected.size > 0) assign([...selected], r.id, clearSelection);
      },
    });
  }
  const pickGrouping = (id: number) => { setPickedGrouping(id); setGroupFilter(ALL); clearSelection(); };
  const reportHref = groupingId !== null ? `/marketing/general?sourceDim=g:${groupingId}` : '/marketing/general';

  const groupsPanel = grouping && (
    <GroupsPanel
      grouping={grouping} groups={groups} counts={counts} maxD90={maxGroupD90} unassignedActive={unassignedActive}
      groupFilter={groupFilter}
      onFilter={(v) => { setGroupFilter(v); setLimit(PAGE); setGroupsModal(false); }}
      onRenameGrouping={() => setNameDialog({ kind: 'grouping.update', id: grouping.id, name: grouping.name })}
      onDeleteGrouping={() => setConfirm({
        title: 'Удалить группировку?',
        text: `«${grouping.name}» и все её группы будут удалены, раскладка источников по ним пропадёт. Сами источники и сделки не трогаются.${grouping.builtinKey ? '\n\nГотовые отчёты «Маркетинга» с этим разрезом вернутся на старый справочник.' : ''}`,
        body: { op: 'grouping.delete', id: grouping.id },
      })}
      onEditGroup={(g) => setNameDialog({ kind: 'group.update', id: g.id, name: g.name, color: g.shown })}
      onDeleteGroup={(g) => setConfirm({ title: 'Удалить группу?', text: `Группа «${g.name}» будет удалена, её источники станут «Не распределено».`, body: { op: 'group.delete', id: g.id } })}
      onAddGroup={() => newGroup(false)}
      reportHref={reportHref}
    />
  );

  const emptyState = (
    <>Ничего не нашлось{filtersOn && <> · <button type="button" className="text-[var(--color-accent)] underline" onClick={resetFilters}>сбросить фильтры</button></>}</>
  );

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 p-3 sm:p-6">
        {/* Шапка */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-[var(--color-text)]">Источники</h1>
            <p className="text-[12px] text-[var(--color-text-muted)]">
              Разрезы для отчётов «Маркетинга»: группировка → группы → источники Битрикса. В группировке источник — максимум в одной группе.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={mut.isPending} title="Добавить новые источники из Битрикса (ваши названия не затираются)"
              onClick={() => mut.mutate({ op: 'bitrix.sync' }, { onSuccess: r => setNotice(`Битрикс: ${fmtInt(r.total ?? 0)} источников, новых — ${fmtInt(r.added ?? 0)}`) })}>
              <RefreshCw size={14} className={mut.isPending && mut.variables?.op === 'bitrix.sync' ? 'animate-spin' : ''} /> Обновить из Битрикса
            </button>
            <Link href={reportHref} className={btnPrimary}>
              <BarChart3 size={14} /> <span className="max-w-[260px] truncate">Отчёт{grouping ? ` по «${grouping.name}»` : ''}</span>
            </Link>
          </div>
        </div>

        {opError && (
          <div className="flex items-start gap-2 rounded-lg border border-[var(--color-danger,#e06666)] px-3 py-2 text-sm text-[var(--color-danger,#cc0000)]">
            <span className="min-w-0 flex-1">{opError}</span>
            <button type="button" aria-label="Скрыть" className="tap-target" onClick={() => setOpError(null)}><X size={14} /></button>
          </div>
        )}

        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {error && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-danger,#cc0000)]">
            Не удалось загрузить: {(error as Error).message}
            <button type="button" className={btn} onClick={() => refetch()}>Повторить</button>
          </div>
        )}

        {data && (
          <>
            {/* Группировки — перенос строк вместо горизонтальной ленты (CLAUDE.md п.12, альтернатива). */}
            <div className="flex flex-wrap items-center gap-2">
              {groupings.map(g => (
                <button key={g.id} type="button" onClick={() => pickGrouping(g.id)}
                  className={`min-h-11 rounded-full border px-3 text-sm transition-colors ${g.id === groupingId ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {g.name}
                </button>
              ))}
              <button type="button" className={btnGhost} onClick={() => setNameDialog({ kind: 'grouping.create', name: '' })}>
                <Plus size={14} /> Группировка
              </button>
            </div>

            {!grouping && (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
                Группировок пока нет. Создайте первую — например, «Канал».
              </div>
            )}

            {grouping && (
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
                {/* Группы: на десктопе — липкая колонка слева, на телефоне/планшете — выбор + окно управления. */}
                <aside className="hidden w-80 shrink-0 lg:sticky lg:top-3 lg:block">{groupsPanel}</aside>

                <section className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-center gap-2 lg:hidden">
                    <SearchSelect
                      ariaLabel="Группа"
                      value={groupFilter}
                      onChange={v => { setGroupFilter(v); setLimit(PAGE); }}
                      allLabel={`Все группы · ${fmtInt(counts.get(ALL)?.n ?? 0)}`}
                      options={[
                        { value: UNASSIGNED, label: 'Не распределено', hint: `${counts.get(UNASSIGNED)?.n ?? 0} ист.` },
                        ...groups.map(g => ({ value: String(g.id), label: g.name, hint: `${counts.get(String(g.id))?.n ?? 0} ист. · ${fmtInt(counts.get(String(g.id))?.d90 ?? 0)} сд. за 90 дн.` })),
                      ]}
                      className="min-w-0 flex-1"
                    />
                    <button type="button" className={btn} onClick={() => setGroupsModal(true)}><Layers size={14} /> Группы</button>
                  </div>

                  {/* Поиск + быстрые фильтры */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex min-w-0 flex-1 basis-64 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3">
                      <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                      <input value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Название, ID, заметка"
                        className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
                      {q && <button type="button" aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]" onClick={() => setQ('')}><X size={14} /></button>}
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {([
                        ['all', 'Все'], ['active', 'Со сделками за 90 дн.'], ['new', 'Новые'], ['system', 'Системные'], ['dead', 'Без сделок 90+ дн.'],
                      ] as [Status, string][]).map(([k, label]) => (
                        <button key={k} type="button" onClick={() => { setStatus(k); setLimit(PAGE); }}
                          className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm ${status === k ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                          {label}
                          <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtInt(statusCounts[k])}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Таблица (md+): своя прокрутка по высоте — шапка остаётся видна при скролле. */}
                  <div className="scroll-x hidden max-h-[calc(100dvh-230px)] min-h-[320px] overflow-y-auto rounded-xl border border-[var(--color-border)] md:block">
                    <table className="w-full min-w-[760px] table-fixed text-sm">
                      <colgroup>
                        <col className="w-11" /><col /><col className="w-[260px]" /><col className="w-[150px]" /><col className="w-[100px]" /><col className="w-[110px]" /><col className="w-12" />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col" className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2 text-left">
                            <input type="checkbox" aria-label="Выбрать все видимые" checked={allVisibleSelected} onChange={toggleAllVisible} className="h-4 w-4" />
                          </th>
                          <SortableTh label="Источник" active={sort.key === 'name'} dir={sort.dir} onClick={() => toggleSort('name')} />
                          <SortableTh label="Группа" active={sort.key === 'group'} dir={sort.dir} onClick={() => toggleSort('group')} />
                          <SortableTh label="Сделок за 90 дн." align="right" active={sort.key === 'deals90'} dir={sort.dir} onClick={() => toggleSort('deals90')} />
                          <SortableTh label="Всего" align="right" active={sort.key === 'deals'} dir={sort.dir} onClick={() => toggleSort('deals')} />
                          <SortableTh label="Без сделок" align="right" title="Сколько прошло с последней сделки" active={sort.key === 'idle'} dir={sort.dir} onClick={() => toggleSort('idle')} />
                          <th scope="col" className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-table-header)]" />
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(s => {
                          const gid = liveGroupOf(s);
                          const g = gid !== undefined ? groupById.get(gid) : undefined;
                          const isSel = selected.has(s.sourceId);
                          const idle = idleDays(s);
                          return (
                            <tr key={s.sourceId}
                              onClick={e => { if (!(e.target as HTMLElement).closest('button,input,a')) toggleRow(s.sourceId, e.shiftKey); }}
                              className={`cursor-pointer border-b border-[var(--color-border)] last:border-b-0 ${isSel ? 'bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
                              <td className="px-2 align-middle">
                                <input type="checkbox" aria-label={`Выбрать ${displayName(s)}`} checked={isSel} readOnly
                                  onClick={e => toggleRow(s.sourceId, e.shiftKey)} className="h-4 w-4" />
                              </td>
                              <td className="px-2 py-1.5"><SourceTitle s={s} /></td>
                              <td className="px-2 py-1">
                                <GroupPicker group={g} options={groupOptions} disabled={mut.isPending} label={displayName(s)} onChange={v => assign([s.sourceId], v)} />
                              </td>
                              <td className="px-2 text-right">
                                <div className="relative ml-auto flex h-6 items-center justify-end">
                                  <span className="absolute inset-y-1 right-0 rounded-sm bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]" style={{ width: `${(s.deals90 / maxD90) * 100}%` }} />
                                  <span className="relative pr-1 tabular-nums text-[var(--color-text)]">{fmtInt(s.deals90)}</span>
                                </div>
                              </td>
                              <td className="px-2 text-right tabular-nums text-[var(--color-text-muted)]">{fmtInt(s.deals)}</td>
                              <td className="whitespace-nowrap px-2 text-right tabular-nums"
                                style={{ color: idle > 90 ? WARN : 'var(--color-text-muted)' }}
                                title={s.lastAt ? `Последняя сделка ${new Date(s.lastAt).toLocaleDateString('ru-RU')}` : 'Сделок не было'}>
                                {fmtIdle(idle)}
                              </td>
                              <td className="px-1 text-center">
                                <button type="button" aria-label="Название и заметка" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={() => editSource(s)}>
                                  <Pencil size={14} />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        {visible.length === 0 && (
                          <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">{emptyState}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Карточки (телефон): таблица в 375px уносила название при свайпе. */}
                  <div className="flex flex-col gap-2 md:hidden">
                    {visible.map(s => {
                      const gid = liveGroupOf(s);
                      const g = gid !== undefined ? groupById.get(gid) : undefined;
                      const isSel = selected.has(s.sourceId);
                      const idle = idleDays(s);
                      return (
                        <div key={s.sourceId} className={`flex flex-col gap-2 rounded-xl border p-3 ${isSel ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
                          <div className="flex items-start gap-2">
                            <label className="tap-target flex h-6 items-center">
                              <input type="checkbox" aria-label={`Выбрать ${displayName(s)}`} checked={isSel} onChange={() => toggleRow(s.sourceId, false)} className="h-4 w-4" />
                            </label>
                            <div className="min-w-0 flex-1"><SourceTitle s={s} /></div>
                            <button type="button" aria-label="Название и заметка" className="tap-target text-[var(--color-text-muted)]" onClick={() => editSource(s)}>
                              <Pencil size={14} />
                            </button>
                          </div>
                          <div className="flex items-center gap-3">
                            <GroupPicker group={g} options={groupOptions} disabled={mut.isPending} label={displayName(s)} onChange={v => assign([s.sourceId], v)} />
                            <div className="shrink-0 text-right text-[12px] leading-tight text-[var(--color-text-muted)]">
                              <div><b className="tabular-nums text-[var(--color-text)]">{fmtInt(s.deals90)}</b> за 90 дн.</div>
                              <div style={{ color: idle > 90 ? WARN : undefined }}>без сделок: {fmtIdle(idle)}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {visible.length === 0 && <div className="py-6 text-center text-sm text-[var(--color-text-muted)]">{emptyState}</div>}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                    <span>Показано {fmtInt(visible.length)} из {fmtInt(filtered.length)}<span className="hidden md:inline"> · Shift+клик — выбрать диапазон, Esc — снять выбор</span></span>
                    {filtered.length > limit && (
                      <button type="button" className={btn} onClick={() => setLimit(l => l + PAGE)}>Показать ещё {fmtInt(Math.min(PAGE, filtered.length - limit))}</button>
                    )}
                  </div>
                  {!data.statsOk && <p className="text-[11px] text-[var(--color-text-muted)]">Счётчики сделок временно недоступны (база сделок не ответила).</p>}
                </section>
              </div>
            )}
          </>
        )}
      </div>

      {/* Панель действий — плавающая снизу, не сдвигает таблицу. */}
      {(selected.size > 0 || notice) && (
        <div className="sticky bottom-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-3 py-2 sm:px-6">
            {selected.size > 0 ? (
              <>
                <span className="text-sm font-semibold text-[var(--color-text)]">Выбрано: {fmtInt(selected.size)}</span>
                {allVisibleSelected && !allFilteredSelected && (
                  <button type="button" className={btnGhost} onClick={() => setSelected(new Set(filtered.map(s => s.sourceId)))}>
                    Выбрать все {fmtInt(filtered.length)}
                  </button>
                )}
                <SearchSelect
                  ariaLabel="Положить выбранные в группу"
                  value=""
                  placeholder="В группу…"
                  options={[...groupOptions, { value: NEW_GROUP, label: '+ Новая группа…' }]}
                  onChange={v => { if (v === NEW_GROUP) newGroup(true); else if (v) assign([...selected], Number(v), clearSelection); }}
                  disabled={mut.isPending}
                  className="min-w-[200px] border-[var(--color-accent)]"
                />
                <button type="button" className={btn} disabled={mut.isPending} onClick={() => assign([...selected], null, clearSelection)}>Убрать из группы</button>
                <button type="button" className={btnGhost} onClick={clearSelection}>Снять выбор</button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-sm text-[var(--color-text)]">{notice}</span>
                <button type="button" aria-label="Скрыть" className="tap-target text-[var(--color-text-muted)]" onClick={() => setNotice(null)}><X size={14} /></button>
              </>
            )}
          </div>
        </div>
      )}

      <Modal open={groupsModal} onOpenChange={setGroupsModal} title="Группы">
        {groupsPanel}
      </Modal>

      <Modal open={!!nameDialog} onOpenChange={o => { if (!o) setNameDialog(null); }}
        title={nameDialog?.kind === 'grouping.create' ? 'Новая группировка'
          : nameDialog?.kind === 'grouping.update' ? 'Группировка'
          : nameDialog?.kind === 'group.create' ? `Новая группа · ${grouping?.name ?? ''}` : 'Группа'}>
        {nameDialog && (
          <form onSubmit={e => { e.preventDefault(); submitNameDialog(); }} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
              Название
              <input autoFocus value={nameDialog.name} maxLength={120}
                onChange={e => setNameDialog({ ...nameDialog, name: e.target.value })} className={input}
                placeholder={nameDialog.kind.startsWith('grouping') ? 'Например, «Платный / бесплатный»' : 'Например, «Авито»'} />
            </label>
            {'color' in nameDialog && (
              <div className="flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
                Цвет
                <GsColorPickerButton value={nameDialog.color} onChange={c => setNameDialog({ ...nameDialog, color: c })} />
              </div>
            )}
            {'assignSelected' in nameDialog && nameDialog.assignSelected && selected.size > 0 && (
              <p className="text-[12px] text-[var(--color-text-muted)]">Выбранные источники ({fmtInt(selected.size)}) сразу попадут в эту группу.</p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={btn} onClick={() => setNameDialog(null)}>Отмена</button>
              <button type="submit" className={btnPrimary} disabled={!nameDialog.name.trim() || mut.isPending}>Сохранить</button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!sourceDialog} onOpenChange={o => { if (!o) setSourceDialog(null); }} title={sourceDialog ? `Источник ID ${sourceDialog.sourceId}` : ''}>
        {sourceDialog && (
          <form className="flex flex-col gap-3"
            onSubmit={e => {
              e.preventDefault();
              mut.mutate({ op: 'source.update', sourceId: sourceDialog.sourceId, name: sourceDialog.name, note: sourceDialog.note },
                { onSuccess: () => setSourceDialog(null) });
            }}>
            <label className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
              Название
              <input autoFocus value={sourceDialog.name} maxLength={300} placeholder="Как источник называется для людей"
                onChange={e => setSourceDialog({ ...sourceDialog, name: e.target.value })} className={input} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-[var(--color-text-muted)]">
              Заметка
              <textarea value={sourceDialog.note} maxLength={2000} rows={3} placeholder="Что это за источник, откуда идут обращения"
                onChange={e => setSourceDialog({ ...sourceDialog, note: e.target.value })}
                className={`${input} py-2`} />
            </label>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" className={btn} onClick={() => setSourceDialog(null)}>Отмена</button>
              <button type="submit" className={btnPrimary} disabled={mut.isPending}>Сохранить</button>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ''}
        description={confirm?.text ?? ''}
        confirmLabel="Удалить"
        tone="danger"
        pending={mut.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          const body = confirm.body;
          mut.mutate(body, { onSuccess: () => { setConfirm(null); if (body.op === 'group.delete') setGroupFilter(ALL); } });
        }}
      />
    </div>
  );
}

function SourceTitle({ s }: { s: Source }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[var(--color-text)]" title={s.name}>{displayName(s)}</div>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <span className="shrink-0">ID {s.sourceId}</span>
        {!s.inDirectory && <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-1.5 font-medium text-[var(--color-accent)]">новый</span>}
        {s.category !== 'marketing' && <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1.5">{s.category === 'system' ? 'системный' : s.category}</span>}
        {s.note && <span className="min-w-0 truncate italic" title={s.note}>{s.note}</span>}
      </div>
    </div>
  );
}

/** Группа источника: цветная метка + выбор из списка с поиском (пустая — оранжевое колечко). */
function GroupPicker({ group, options, onChange, disabled, label }: {
  group: ShownGroup | undefined; options: { value: string; label: string }[];
  onChange: (groupId: number | null) => void; disabled: boolean; label: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: group?.shown ?? 'transparent', boxShadow: group ? undefined : `inset 0 0 0 1.5px ${WARN}` }} />
      <SearchSelect
        options={options}
        value={group ? String(group.id) : ''}
        allLabel="— не распределено"
        onChange={v => onChange(v ? Number(v) : null)}
        ariaLabel={`Группа источника ${label}`}
        disabled={disabled}
        className={`min-w-0 flex-1 border-transparent ${group ? 'bg-[var(--color-bg-hover)]' : 'bg-transparent italic text-[var(--color-text-muted)]'}`}
      />
    </div>
  );
}

function GroupsPanel({
  grouping, groups, counts, maxD90, unassignedActive, groupFilter, onFilter,
  onRenameGrouping, onDeleteGrouping, onEditGroup, onDeleteGroup, onAddGroup, reportHref,
}: {
  grouping: Grouping; groups: ShownGroup[]; counts: Map<string, { n: number; d90: number }>; maxD90: number;
  unassignedActive: number; groupFilter: string; onFilter: (v: string) => void;
  onRenameGrouping: () => void; onDeleteGrouping: () => void;
  onEditGroup: (g: ShownGroup) => void; onDeleteGroup: (g: ShownGroup) => void; onAddGroup: () => void;
  reportHref: string;
}) {
  const c = (k: string) => counts.get(k) ?? { n: 0, d90: 0 };
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1 truncate font-semibold text-[var(--color-text)]">{grouping.name}</div>
        <button type="button" aria-label="Переименовать группировку" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onRenameGrouping}><Pencil size={14} /></button>
        <button type="button" aria-label="Удалить группировку" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-danger,#cc0000)]" onClick={onDeleteGrouping}><Trash2 size={14} /></button>
      </div>
      {grouping.builtinKey && (
        <Link href={reportHref} className="text-[11px] text-[var(--color-accent)] hover:underline">
          По этой группировке считаются и готовые отчёты «Маркетинга» →
        </Link>
      )}

      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 pl-2 pr-[72px] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        <span>Группа</span><span className="w-10 text-right">ист.</span><span className="w-16 text-right">сд. 90 дн.</span>
      </div>
      <div className="flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto lg:max-h-[calc(100dvh-300px)]">
        <GroupRow label="Все источники" n={c(ALL).n} d90={c(ALL).d90} active={groupFilter === ALL} onClick={() => onFilter(ALL)} />
        <GroupRow label="Не распределено" warn n={c(UNASSIGNED).n} d90={c(UNASSIGNED).d90} share={c(UNASSIGNED).d90 / maxD90}
          active={groupFilter === UNASSIGNED} onClick={() => onFilter(UNASSIGNED)}
          sub={unassignedActive > 0 ? `${unassignedActive} со сделками за 90 дн. — разобрать` : undefined} />
        <div className="my-1 border-t border-[var(--color-border)]" />
        {groups.map(g => (
          <GroupRow key={g.id} label={g.name} color={g.shown} n={c(String(g.id)).n} d90={c(String(g.id)).d90} share={c(String(g.id)).d90 / maxD90}
            active={groupFilter === String(g.id)} onClick={() => onFilter(String(g.id))}
            onEdit={() => onEditGroup(g)} onDelete={() => onDeleteGroup(g)} />
        ))}
        {groups.length === 0 && (
          <div className="px-2 py-2 text-xs text-[var(--color-text-muted)]">Групп пока нет. Создайте группу, затем отметьте источники и положите их в неё.</div>
        )}
      </div>
      <button type="button" className={btnGhost} onClick={onAddGroup}><Plus size={14} /> Группа</button>
    </div>
  );
}

function GroupRow({ label, n, d90, share, active, onClick, color, warn, sub, onEdit, onDelete }: {
  label: string; n: number; d90: number; share?: number; active: boolean; onClick: () => void;
  color?: string; warn?: boolean; sub?: string; onEdit?: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`group flex items-center gap-1 rounded-lg pl-2 ${active ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
      <button type="button" onClick={onClick} className="flex min-h-11 min-w-0 flex-1 flex-col justify-center py-1 text-left">
        <span className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-3">
          <span className="flex min-w-0 items-center gap-2">
            {color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />}
            <span className={`truncate text-sm ${active ? 'font-semibold' : ''}`} style={{ color: warn && n > 0 ? WARN : 'var(--color-text)' }}>{label}</span>
          </span>
          <span className="w-10 text-right text-[12px] tabular-nums text-[var(--color-text-muted)]">{n}</span>
          <span className="w-16 text-right text-[12px] tabular-nums text-[var(--color-text)]">{d90.toLocaleString('ru-RU')}</span>
        </span>
        {share !== undefined && (
          <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(share * 100, d90 > 0 ? 2 : 0)}%`, background: warn ? WARN : (color ?? 'var(--color-accent)') }} />
          </span>
        )}
        {sub && <span className="mt-0.5 text-[11px]" style={{ color: WARN }}>{sub}</span>}
      </button>
      {/* Место под правку/удаление держим и у «Все»/«Не распределено», чтобы числа стояли в колонку. */}
      {onEdit ? (
        <button type="button" aria-label={`Изменить «${label}»`} onClick={onEdit}
          className="hover-reveal tap-target w-8 shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><Pencil size={13} className="mx-auto" /></button>
      ) : <span className="w-8 shrink-0" />}
      {onDelete ? (
        <button type="button" aria-label={`Удалить «${label}»`} onClick={onDelete}
          className="hover-reveal tap-target w-8 shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger,#cc0000)]"><Trash2 size={13} className="mx-auto" /></button>
      ) : <span className="w-8 shrink-0" />}
    </div>
  );
}
