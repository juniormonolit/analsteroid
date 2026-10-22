'use client';

// «Ещё → Источники» (задача владельца 22.10): инструмент структуризации маркетинговых
// источников. Руководитель маркетинга сам заводит ГРУППИРОВКИ (оси разреза), в каждой —
// ГРУППЫ, и раскладывает по ним source_id Битрикса; источнику можно дать понятное
// название и заметку. На этой структуре строится «Маркетинг → Общий отчёт»
// (измерение `g:<id>` в by-sources). API — app/api/marketing/structure.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, RefreshCw, BarChart3, Search, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SortableTh } from '@/components/ui/SortableTh';
import { GsColorPickerButton } from '@/components/ui/GsColorPicker';

interface Grouping { id: number; name: string; sort: number }
interface Group { id: number; groupingId: number; name: string; color: string | null; sort: number }
interface Source {
  sourceId: string; name: string; category: string; note: string | null; inDirectory: boolean;
  deals: number; deals90: number; lastAt: string | null;
  assign: Record<number, number>;
}
interface Structure { groupings: Grouping[]; groups: Group[]; sources: Source[]; statsOk: boolean }

type Op = Record<string, unknown> & { op: string };
type SortKey = 'name' | 'group' | 'deals90' | 'deals' | 'lastAt';

const UNASSIGNED = '__none__';
const ALL = '';
const PAGE = 200;
const DEFAULT_COLOR = '#4a86e8';

const btn = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const btnPrimary = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-text-inverse)] hover:opacity-90 disabled:opacity-50';
const input = 'min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:text-sm';

const fmtInt = (n: number) => n.toLocaleString('ru-RU');
const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
const displayName = (s: Source) => s.name && s.name !== s.sourceId ? s.name : `#${s.sourceId}`;

export function MarketingSourcesPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['marketing-structure'],
    queryFn: async () => {
      const r = await fetch('/api/marketing/structure');
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
      return r.json() as Promise<Structure>;
    },
  });

  const [opError, setOpError] = useState<string | null>(null);
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

  const groupings = useMemo(() => data?.groupings ?? [], [data]);
  const [pickedGrouping, setPickedGrouping] = useState<number | null>(null);
  const groupingId = groupings.some(g => g.id === pickedGrouping) ? pickedGrouping! : (groupings[0]?.id ?? null);
  const grouping = groupings.find(g => g.id === groupingId) ?? null;
  const groups = useMemo(() => (data?.groups ?? []).filter(g => g.groupingId === groupingId), [data, groupingId]);
  const groupById = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups]);
  const sources = useMemo(() => data?.sources ?? [], [data]);

  // Фильтры и выбор
  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [q, setQ] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'deals90', dir: 'desc' });
  const [limit, setLimit] = useState(PAGE);

  const groupOf = (s: Source) => (groupingId !== null ? s.assign[groupingId] : undefined);
  const liveGroupOf = (s: Source) => { const g = groupOf(s); return g !== undefined && groupById.has(g) ? g : undefined; };

  const counts = useMemo(() => {
    const m = new Map<string, { n: number; d90: number }>();
    const bump = (k: string, s: Source) => { const c = m.get(k) ?? { n: 0, d90: 0 }; c.n++; c.d90 += s.deals90; m.set(k, c); };
    for (const s of sources) {
      bump(ALL, s);
      const g = groupingId !== null ? s.assign[groupingId] : undefined;
      bump(g !== undefined && groupById.has(g) ? String(g) : UNASSIGNED, s);
    }
    return m;
  }, [sources, groupingId, groupById]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = sources.filter(s => {
      if (activeOnly && s.deals90 === 0) return false;
      if (groupFilter === UNASSIGNED && liveGroupOf(s) !== undefined) return false;
      if (groupFilter !== ALL && groupFilter !== UNASSIGNED && String(liveGroupOf(s)) !== groupFilter) return false;
      if (needle && !`${s.name} ${s.sourceId} ${s.note ?? ''}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const k = sort.key; const sign = sort.dir === 'asc' ? 1 : -1;
    const gName = (s: Source) => { const g = liveGroupOf(s); return g !== undefined ? groupById.get(g)!.name : '￿'; };
    rows.sort((a, b) => {
      let c = 0;
      if (k === 'name') c = displayName(a).localeCompare(displayName(b), 'ru');
      else if (k === 'group') c = gName(a).localeCompare(gName(b), 'ru');
      else if (k === 'lastAt') c = (a.lastAt ?? '').localeCompare(b.lastAt ?? '');
      else c = a[k] - b[k];
      return c * sign || b.deals - a.deals;
    });
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, q, activeOnly, groupFilter, sort, groupingId, groupById]);

  const visible = filtered.slice(0, limit);
  const allVisibleSelected = visible.length > 0 && visible.every(s => selected.has(s.sourceId));
  const toggleSort = (key: SortKey) => setSort(p => p.key === key ? { key, dir: p.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'group' ? 'asc' : 'desc' });
  const toggleOne = (id: string) => setSelected(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllVisible = () => setSelected(p => {
    const n = new Set(p);
    if (allVisibleSelected) visible.forEach(s => n.delete(s.sourceId)); else visible.forEach(s => n.add(s.sourceId));
    return n;
  });

  const groupOptions = groups.map(g => ({ value: String(g.id), label: g.name }));
  const assign = (sourceIds: string[], groupId: number | null) => {
    if (groupingId === null || sourceIds.length === 0) return;
    mut.mutate({ op: 'assign', groupingId, sourceIds, groupId }, { onSuccess: () => setSelected(new Set()) });
  };
  const [bulkGroup, setBulkGroup] = useState('');

  // Диалоги
  const [nameDialog, setNameDialog] = useState<
    | { kind: 'grouping.create' | 'grouping.update'; id?: number; name: string }
    | { kind: 'group.create' | 'group.update'; id?: number; name: string; color: string }
    | null>(null);
  const [sourceDialog, setSourceDialog] = useState<{ sourceId: string; name: string; note: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; body: Op } | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function submitNameDialog() {
    if (!nameDialog || !nameDialog.name.trim()) return;
    const d = nameDialog;
    let body: Op;
    if (!('color' in d)) body = d.kind === 'grouping.create' ? { op: d.kind, name: d.name } : { op: d.kind, id: d.id, name: d.name };
    else body = d.kind === 'group.create' ? { op: d.kind, groupingId, name: d.name, color: d.color } : { op: d.kind, id: d.id, name: d.name, color: d.color };
    mut.mutate(body, {
      onSuccess: (r) => {
        setNameDialog(null);
        if (d.kind === 'grouping.create' && r.id) { setPickedGrouping(r.id); setGroupFilter(ALL); }
      },
    });
  }

  const unassignedActive = sources.filter(s => s.deals90 > 0 && liveGroupOf(s) === undefined).length;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden p-3 sm:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-[var(--color-text)]">Источники</h1>
          <p className="max-w-3xl text-[12px] text-[var(--color-text-muted)]">
            Структура маркетинговых источников Битрикса. Группировка — это разрез отчёта (например, «Канал» или
            «Платный / бесплатный»), в ней — группы, в каждую группу — источники. Один источник в группировке
            входит максимум в одну группу. По этой структуре строится «Маркетинг → Общий отчёт».
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btn} disabled={mut.isPending}
            onClick={() => mut.mutate({ op: 'bitrix.sync' }, { onSuccess: r => setSyncMsg(`Битрикс: ${r.total ?? 0} источников, новых добавлено — ${r.added ?? 0}`) })}>
            <RefreshCw size={14} className={mut.isPending && mut.variables?.op === 'bitrix.sync' ? 'animate-spin' : ''} /> Названия из Битрикса
          </button>
          <Link href={groupingId !== null ? `/marketing/general?sourceDim=g:${groupingId}` : '/marketing/general'} className={btnPrimary}>
            <BarChart3 size={14} /> Открыть отчёт
          </Link>
        </div>
      </div>

      {(opError || syncMsg) && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${opError ? 'border-[var(--color-danger,#e06666)] text-[var(--color-danger,#cc0000)]' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
          <span className="min-w-0 flex-1">{opError ?? syncMsg}</span>
          <button type="button" aria-label="Скрыть" className="tap-target text-[var(--color-text-muted)]" onClick={() => { setOpError(null); setSyncMsg(null); }}><X size={14} /></button>
        </div>
      )}

      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {error && <div className="text-sm text-[var(--color-danger,#cc0000)]">Не удалось загрузить: {(error as Error).message}</div>}

      {data && (
        <>
          {/* Группировки — перенос строк вместо горизонтальной ленты (CLAUDE.md п.12, альтернатива). */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Группировки</span>
            {groupings.map(g => (
              <button key={g.id} type="button"
                onClick={() => { setPickedGrouping(g.id); setGroupFilter(ALL); setSelected(new Set()); }}
                className={`min-h-11 rounded-full border px-3 text-sm transition-colors ${g.id === groupingId ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                {g.name}
              </button>
            ))}
            <button type="button" className={btn} onClick={() => setNameDialog({ kind: 'grouping.create', name: '' })}>
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
              {/* Группы выбранной группировки */}
              <aside className="flex w-full shrink-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 lg:w-80">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1 truncate font-semibold text-[var(--color-text)]">{grouping.name}</div>
                  <button type="button" aria-label="Переименовать группировку" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    onClick={() => setNameDialog({ kind: 'grouping.update', id: grouping.id, name: grouping.name })}><Pencil size={14} /></button>
                  <button type="button" aria-label="Удалить группировку" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-danger,#cc0000)]"
                    onClick={() => setConfirm({ title: 'Удалить группировку?', text: `«${grouping.name}» и все её группы будут удалены, раскладка источников по ним пропадёт. Сами источники и сделки не трогаются.`, body: { op: 'grouping.delete', id: grouping.id } })}><Trash2 size={14} /></button>
                </div>
                <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto lg:max-h-[calc(100dvh-280px)]">
                  <GroupRow label="Все источники" n={counts.get(ALL)?.n ?? 0} d90={counts.get(ALL)?.d90 ?? 0}
                    active={groupFilter === ALL} onClick={() => setGroupFilter(ALL)} />
                  <GroupRow label="Не распределено" muted n={counts.get(UNASSIGNED)?.n ?? 0} d90={counts.get(UNASSIGNED)?.d90 ?? 0}
                    active={groupFilter === UNASSIGNED} onClick={() => setGroupFilter(UNASSIGNED)} />
                  <div className="my-1 border-t border-[var(--color-border)]" />
                  {groups.map(g => (
                    <GroupRow key={g.id} label={g.name} color={g.color ?? undefined}
                      n={counts.get(String(g.id))?.n ?? 0} d90={counts.get(String(g.id))?.d90 ?? 0}
                      active={groupFilter === String(g.id)} onClick={() => setGroupFilter(String(g.id))}
                      onEdit={() => setNameDialog({ kind: 'group.update', id: g.id, name: g.name, color: g.color ?? DEFAULT_COLOR })}
                      onDelete={() => setConfirm({ title: 'Удалить группу?', text: `Группа «${g.name}» будет удалена, её источники станут «Не распределено».`, body: { op: 'group.delete', id: g.id } })} />
                  ))}
                  {groups.length === 0 && <div className="px-2 py-2 text-xs text-[var(--color-text-muted)]">Групп пока нет.</div>}
                </div>
                <button type="button" className={btn} onClick={() => setNameDialog({ kind: 'group.create', name: '', color: DEFAULT_COLOR })}>
                  <Plus size={14} /> Группа
                </button>
                {unassignedActive > 0 && (
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    Не распределено источников со сделками за 90 дней: <b className="text-[var(--color-text)]">{unassignedActive}</b>
                  </p>
                )}
              </aside>

              {/* Источники */}
              <section className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3">
                    <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
                    <input value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Название, ID, заметка"
                      className="min-h-11 min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
                    {q && <button type="button" aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]" onClick={() => setQ('')}><X size={14} /></button>}
                  </label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
                    <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} className="h-4 w-4" />
                    Только со сделками за 90 дней
                  </label>
                  <span className="text-xs text-[var(--color-text-muted)]">{fmtInt(filtered.length)} шт.</span>
                </div>

                {selected.size > 0 && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-3 py-2">
                    <span className="text-sm font-medium text-[var(--color-text)]">Выбрано: {selected.size}</span>
                    <SearchSelect options={groupOptions} value={bulkGroup} onChange={setBulkGroup} placeholder="Группа…" ariaLabel="Группа для выбранных" className="min-w-[180px]" />
                    <button type="button" className={btnPrimary} disabled={!bulkGroup || mut.isPending}
                      onClick={() => assign([...selected], Number(bulkGroup))}>Положить в группу</button>
                    <button type="button" className={btn} disabled={mut.isPending}
                      onClick={() => assign([...selected], null)}>Убрать из группы</button>
                    <button type="button" className={btn} onClick={() => setSelected(new Set())}>Снять выбор</button>
                  </div>
                )}

                <div className="scroll-x rounded-xl border border-[var(--color-border)]">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr>
                        <th scope="col" className="sticky top-0 z-20 w-10 border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2">
                          <input type="checkbox" aria-label="Выбрать все видимые" checked={allVisibleSelected} onChange={toggleAllVisible} className="h-4 w-4" />
                        </th>
                        <SortableTh label="Источник" active={sort.key === 'name'} dir={sort.dir} onClick={() => toggleSort('name')} />
                        <SortableTh label={`Группа · ${grouping.name}`} active={sort.key === 'group'} dir={sort.dir} onClick={() => toggleSort('group')} />
                        <SortableTh label="Сделок 90 дн." align="right" active={sort.key === 'deals90'} dir={sort.dir} onClick={() => toggleSort('deals90')} />
                        <SortableTh label="Всего" align="right" active={sort.key === 'deals'} dir={sort.dir} onClick={() => toggleSort('deals')} />
                        <SortableTh label="Последняя" align="right" active={sort.key === 'lastAt'} dir={sort.dir} onClick={() => toggleSort('lastAt')} />
                        <th scope="col" className="sticky top-0 z-20 w-10 border-b border-[var(--color-border)] bg-[var(--color-table-header)]" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map(s => {
                        const gid = liveGroupOf(s);
                        const g = gid !== undefined ? groupById.get(gid) : undefined;
                        return (
                          <tr key={s.sourceId} className={`border-b border-[var(--color-border)] last:border-b-0 ${selected.has(s.sourceId) ? 'bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)]' : ''}`}>
                            <td className="px-2 align-middle">
                              <input type="checkbox" aria-label={`Выбрать ${displayName(s)}`} checked={selected.has(s.sourceId)} onChange={() => toggleOne(s.sourceId)} className="h-4 w-4" />
                            </td>
                            <td className="max-w-[360px] px-2 py-1.5">
                              <div className="truncate text-[var(--color-text)]" title={s.name}>{displayName(s)}</div>
                              <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-text-muted)]">
                                <span>ID {s.sourceId}</span>
                                {!s.inDirectory && <span className="rounded bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] px-1 text-[var(--color-accent)]">новый</span>}
                                {s.category !== 'marketing' && <span>{s.category}</span>}
                                {s.note && <span className="truncate italic" title={s.note}>{s.note}</span>}
                              </div>
                            </td>
                            <td className="px-2 py-1">
                              <div className="flex items-center gap-2">
                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: g?.color ?? 'transparent', boxShadow: g ? undefined : 'inset 0 0 0 1px var(--color-border)' }} />
                                <SearchSelect
                                  options={groupOptions}
                                  value={gid !== undefined ? String(gid) : ''}
                                  allLabel="— не распределено"
                                  onChange={v => assign([s.sourceId], v ? Number(v) : null)}
                                  ariaLabel={`Группа источника ${displayName(s)}`}
                                  className="min-w-[160px] max-w-[240px] flex-1"
                                  disabled={mut.isPending}
                                />
                              </div>
                            </td>
                            <td className="px-2 text-right tabular-nums text-[var(--color-text)]">{fmtInt(s.deals90)}</td>
                            <td className="px-2 text-right tabular-nums text-[var(--color-text-muted)]">{fmtInt(s.deals)}</td>
                            <td className="whitespace-nowrap px-2 text-right tabular-nums text-[var(--color-text-muted)]">{fmtDate(s.lastAt)}</td>
                            <td className="px-1 text-center">
                              <button type="button" aria-label="Название и заметка" className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                onClick={() => setSourceDialog({ sourceId: s.sourceId, name: s.name && s.name !== s.sourceId ? s.name : '', note: s.note ?? '' })}>
                                <Pencil size={14} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {visible.length === 0 && (
                        <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Ничего не нашлось</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {filtered.length > limit && (
                  <button type="button" className={`${btn} self-center`} onClick={() => setLimit(l => l + PAGE)}>
                    Показать ещё ({fmtInt(filtered.length - limit)})
                  </button>
                )}
                {!data.statsOk && (
                  <p className="text-[11px] text-[var(--color-text-muted)]">Счётчики сделок временно недоступны (база сделок не ответила).</p>
                )}
              </section>
            </div>
          )}
        </>
      )}

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
                placeholder={nameDialog.kind.startsWith('grouping') ? 'Например, «Канал»' : 'Например, «Авито»'} />
            </label>
            {'color' in nameDialog && (
              <div className="flex items-center gap-3 text-sm text-[var(--color-text-muted)]">
                Цвет
                <GsColorPickerButton value={nameDialog.color} onChange={c => setNameDialog({ ...nameDialog, color: c })} />
              </div>
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

function GroupRow({ label, n, d90, active, onClick, color, muted, onEdit, onDelete }: {
  label: string; n: number; d90: number; active: boolean; onClick: () => void;
  color?: string; muted?: boolean; onEdit?: () => void; onDelete?: () => void;
}) {
  return (
    <div className={`group flex min-h-11 items-center gap-2 rounded-lg px-2 ${active ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
      <button type="button" onClick={onClick} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left">
        {color !== undefined && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />}
        <span className={`min-w-0 flex-1 truncate text-sm ${muted ? 'italic text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'} ${active ? 'font-semibold' : ''}`}>{label}</span>
        <span className="shrink-0 text-right text-[11px] tabular-nums text-[var(--color-text-muted)]" title="Источников · сделок за 90 дней">
          {n} · {d90.toLocaleString('ru-RU')}
        </span>
      </button>
      {onEdit && (
        <button type="button" aria-label={`Изменить «${label}»`} onClick={onEdit}
          className="hover-reveal tap-target text-[var(--color-text-muted)] hover:text-[var(--color-text)]"><Pencil size={13} /></button>
      )}
      {onDelete && (
        <button type="button" aria-label={`Удалить «${label}»`} onClick={onDelete}
          className="hover-reveal tap-target text-[var(--color-text-muted)] hover:text-[var(--color-danger,#cc0000)]"><Trash2 size={13} /></button>
      )}
    </div>
  );
}
