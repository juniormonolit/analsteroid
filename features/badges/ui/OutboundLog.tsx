'use client';
// «Настройки → Геймификация → Исходящие» (задача 2765, правка владельца
// 02.08): лог всех сообщений «Аналитика» менеджерам — «система отладки»:
// каждому сообщению ID (base36), поиск по нему открывает полный след решения
// (decision_trace) — «по какому правилу/порогу ушло именно это сообщение».
// Таблица сортируется по заголовкам (правило проекта 01.08).

import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Row {
  logId: number; shortId: string; bitrixId: number; managerName: string | null;
  msgType: string; text: string; triggerReason: string | null;
  dryRun: boolean; sent: boolean; suppressReason: string | null;
  decisionTrace: unknown; createdAt: string;
}

type SortKey = 'createdAt' | 'managerName' | 'msgType' | 'sent';
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

function SortableTh({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort?.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className="px-2 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] text-[var(--color-text-muted)]">
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

const MSG_TYPES = ['digest_daily', 'digest_weekly', 'advice_nudge', 'advice_success', 'gamification'];

export function OutboundLogBlock() {
  const [idSearch, setIdSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', dir: 'desc' });
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['settings-digest-outbound', idSearch],
    queryFn: async () => {
      const q = idSearch.trim() ? `?id=${encodeURIComponent(idSearch.trim())}` : '';
      const res = await fetch(`/api/settings/digest/outbound${q}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const handleSort = (key: SortKey) => {
    setSort(cur => {
      if (cur?.key !== key) return { key, dir: 'desc' };
      if (cur.dir === 'desc') return { key, dir: 'asc' };
      return { key: 'createdAt', dir: 'desc' };
    });
  };

  const rows = useMemo(() => {
    let list = data?.rows ?? [];
    if (typeFilter) list = list.filter(r => r.msgType === typeFilter);
    if (nameFilter.trim()) {
      const q = nameFilter.trim().toLowerCase();
      list = list.filter(r => (r.managerName ?? '').toLowerCase().includes(q) || String(r.bitrixId).includes(q));
    }
    if (!sort) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sort.key === 'createdAt' ? a.createdAt : sort.key === 'managerName' ? (a.managerName ?? '') : sort.key === 'msgType' ? a.msgType : (a.sent ? 1 : 0);
      const bv = sort.key === 'createdAt' ? b.createdAt : sort.key === 'managerName' ? (b.managerName ?? '') : sort.key === 'msgType' ? b.msgType : (b.sent ? 1 : 0);
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [data, typeFilter, nameFilter, sort]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={idSearch} onChange={e => setIdSearch(e.target.value)}
          placeholder="Поиск по ID сообщения (напр. K3F)"
          className="w-56 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs"
        />
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs">
          <option value="">Все типы</option>
          {MSG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          value={nameFilter} onChange={e => setNameFilter(e.target.value)}
          placeholder="Фильтр по сотруднику"
          className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs"
        />
        <span className="text-[11px] text-[var(--color-text-muted)]">{rows.length} сообщений</span>
      </div>

      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}

      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">ID</th>
              <SortableTh label="Когда" sortKey="createdAt" sort={sort} onSort={handleSort} />
              <SortableTh label="Сотрудник" sortKey="managerName" sort={sort} onSort={handleSort} />
              <SortableTh label="Тип" sortKey="msgType" sort={sort} onSort={handleSort} />
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Текст</th>
              <SortableTh label="Статус" sortKey="sent" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <Fragment key={r.logId}>
                <tr
                  onClick={() => setExpanded(x => x === r.logId ? null : r.logId)}
                  className="cursor-pointer border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)]"
                >
                  <td className="px-2 py-2 font-mono">{r.shortId}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString('ru-RU')}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.managerName ?? r.bitrixId}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.msgType}</td>
                  <td className="px-2 py-2 max-w-xs truncate text-[var(--color-text-muted)]">{r.text.replace(/\[.*?\]/g, '').slice(0, 80)}</td>
                  <td className="px-2 py-2">
                    {r.sent
                      ? <span className="text-green-600">отправлено</span>
                      : <span className="text-[var(--color-text-muted)]" title={r.suppressReason ?? 'dry-run'}>{r.suppressReason ? 'подавлено (подписка)' : 'dry-run (лог)'}</span>}
                  </td>
                </tr>
                {expanded === r.logId && (
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                    <td colSpan={6} className="px-3 py-3">
                      <div className="mb-2 whitespace-pre-wrap text-[var(--color-text)]">{r.text}</div>
                      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">Триггер</div>
                      <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">{r.triggerReason ?? '—'}</div>
                      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">След решения (decision_trace)</div>
                      <pre className="overflow-x-auto rounded bg-[var(--color-bg-surface)] p-2 text-[10px]">{r.decisionTrace ? JSON.stringify(r.decisionTrace, null, 2) : '—'}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!isLoading && rows.length === 0 && <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>}
      </div>
    </div>
  );
}
