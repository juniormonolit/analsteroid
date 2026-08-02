'use client';
// «Настройки → Геймификация → Обратная связь» (задача 2765, правка владельца
// 02.08): очередь кликов «⚠️ Ошибка»/«👍 Полезно». Бонус НЕ автоматический —
// админ вручную переводит в bonus_awarded/dismissed (защита от фарма).
// Начисление самой валюты — отдельная существующая операция («Штрафы» →
// ручное поощрение), эта очередь только помечает статус разбора.
//
// Комментарий разбирающего ОБЯЗАТЕЛЕН при закрытии (правка владельца 02.08):
// менеджер видит его в своём ЛК («Мои замечания») — молчание после жалобы
// отбивает желание жать кнопку в следующий раз.

import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Row {
  id: number; logId: number; shortId: string; bitrixId: number; managerName: string | null;
  signal: 'error' | 'useful'; status: string; reviewedBy: string | null; reviewedAt: string | null;
  reviewNote: string | null; createdAt: string; messageText: string | null; msgType: string | null;
  decisionTrace: unknown;
}

type SortKey = 'createdAt' | 'managerName' | 'signal' | 'status';
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

function SortableTh({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort?.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className="px-2 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] text-[var(--color-text-muted)]">
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

const STATUS_LABEL: Record<string, string> = { pending: 'на разборе', bonus_awarded: 'бонус начислен', dismissed: 'отклонено' };

function ReviewForm({ row, onSubmit, pending }: { row: Row; onSubmit: (status: 'bonus_awarded' | 'dismissed', note: string) => void; pending: boolean }) {
  const [note, setNote] = useState('');
  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] p-2.5">
      <div className="mb-1.5 text-[11px] font-semibold text-[var(--color-text-muted)]">
        Комментарий менеджеру (обязателен, он его увидит в «Мои замечания»)
      </div>
      <textarea
        value={note} onChange={e => setNote(e.target.value)}
        placeholder={row.signal === 'error' ? 'Например: посмотрели, тут система сработала правильно, потому что…' : 'Например: спасибо, учли при следующей доработке'}
        rows={2}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs"
      />
      <div className="mt-2 flex gap-1.5">
        <button
          type="button" disabled={!note.trim() || pending}
          onClick={() => onSubmit('bonus_awarded', note.trim())}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
        >начислить бонус</button>
        <button
          type="button" disabled={!note.trim() || pending}
          onClick={() => onSubmit('dismissed', note.trim())}
          className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
        >отклонить</button>
      </div>
    </div>
  );
}

export function FeedbackQueueBlock() {
  const qc = useQueryClient();
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', dir: 'desc' });
  const [expanded, setExpanded] = useState<number | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);

  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['settings-digest-feedback'],
    queryFn: async () => {
      const res = await fetch('/api/settings/digest/feedback');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const review = useMutation({
    mutationFn: async ({ id, status, note }: { id: number; status: string; note: string }) => {
      const res = await fetch('/api/settings/digest/feedback', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status, note }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings-digest-feedback'] }),
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
    if (onlyPending) list = list.filter(r => r.status === 'pending');
    if (!sort) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sort.key === 'createdAt' ? a.createdAt : sort.key === 'managerName' ? (a.managerName ?? '') : sort.key === 'signal' ? a.signal : a.status;
      const bv = sort.key === 'createdAt' ? b.createdAt : sort.key === 'managerName' ? (b.managerName ?? '') : sort.key === 'signal' ? b.signal : b.status;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [data, sort, onlyPending]);

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} className="w-3.5 h-3.5 accent-[var(--color-accent)]" />
        Только на разборе
      </label>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}

      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">ID</th>
              <SortableTh label="Когда" sortKey="createdAt" sort={sort} onSort={handleSort} />
              <SortableTh label="Сотрудник" sortKey="managerName" sort={sort} onSort={handleSort} />
              <SortableTh label="Сигнал" sortKey="signal" sort={sort} onSort={handleSort} />
              <SortableTh label="Статус" sortKey="status" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <Fragment key={r.id}>
                <tr onClick={() => setExpanded(x => x === r.id ? null : r.id)} className="cursor-pointer border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)]">
                  <td className="px-2 py-2 font-mono">{r.shortId}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString('ru-RU')}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{r.managerName ?? r.bitrixId}</td>
                  <td className="px-2 py-2">{r.signal === 'error' ? '⚠️ Ошибка' : '👍 Полезно'}</td>
                  <td className="px-2 py-2">{STATUS_LABEL[r.status] ?? r.status}</td>
                </tr>
                {expanded === r.id && (
                  <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)]">
                    <td colSpan={5} className="px-3 py-3">
                      <div className="mb-2 whitespace-pre-wrap text-[var(--color-text)]">{r.messageText ?? '—'}</div>
                      <div className="text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">След решения</div>
                      <pre className="overflow-x-auto rounded bg-[var(--color-bg-surface)] p-2 text-[10px]">{r.decisionTrace ? JSON.stringify(r.decisionTrace, null, 2) : '—'}</pre>
                      {r.status === 'pending'
                        ? <ReviewForm row={r} pending={review.isPending} onSubmit={(status, note) => review.mutate({ id: r.id, status, note })} />
                        : (
                          <div className="mt-2 rounded-lg bg-[var(--color-bg-surface)] p-2.5 text-[11px]">
                            <span className="font-semibold">{STATUS_LABEL[r.status]}</span> ({r.reviewedBy}, {r.reviewedAt ? new Date(r.reviewedAt).toLocaleString('ru-RU') : ''}): {r.reviewNote}
                          </div>
                        )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!isLoading && rows.length === 0 && <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">Пусто</div>}
      </div>
    </div>
  );
}
