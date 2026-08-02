'use client';
// «Мои замечания» (задача 2765, правка владельца 02.08): личный журнал того,
// что менеджер отправил кнопками «⚠️ Ошибка»/«👍 Полезно». Тон статусов —
// уважительный («Аналитик — кореш, не надзиратель»): не «жалоба отклонена»,
// а человеческое объяснение от разбирающего — оно обязательно и видно здесь.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Row {
  id: number; shortId: string; signal: 'error' | 'useful'; status: string;
  reviewedAt: string | null; reviewNote: string | null; createdAt: string; messageText: string | null;
}

type SortKey = 'createdAt' | 'status';
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  pending: { label: 'На рассмотрении', cls: 'text-[var(--color-text-muted)]' },
  bonus_awarded: { label: 'Принято, бонус начислен', cls: 'text-green-600' },
  dismissed: { label: 'Рассмотрено', cls: 'text-[var(--color-text)]' },
};

function SortableTh({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort?.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className="px-2 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] text-[var(--color-text-muted)]">
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

export function MyFeedbackLog() {
  const [sort, setSort] = useState<SortState>({ key: 'createdAt', dir: 'desc' });
  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['me-feedback'],
    queryFn: async () => {
      const res = await fetch('/api/me/feedback');
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
    const list = data?.rows ?? [];
    if (!sort) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sort.key === 'createdAt' ? a.createdAt : a.status;
      const bv = sort.key === 'createdAt' ? b.createdAt : b.status;
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [data, sort]);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5">
      <h2 className="mb-1 text-sm font-semibold text-[var(--color-text)]">Мои замечания</h2>
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Всё, что ты отмечал кнопками «⚠️ Ошибка» / «👍 Полезно» под сообщениями Аналитика, и что нам
        удалось разобрать.
      </p>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {!isLoading && rows.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Пока ничего не отмечал(а).</div>}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead className="border-b border-[var(--color-border)]">
              <tr>
                <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">ID</th>
                <SortableTh label="Когда" sortKey="createdAt" sort={sort} onSort={handleSort} />
                <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Сигнал</th>
                <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">О чём сообщение</th>
                <SortableTh label="Статус" sortKey="status" sort={sort} onSort={handleSort} />
                <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const st = STATUS_LABEL[r.status] ?? { label: r.status, cls: '' };
                return (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0 align-top">
                    <td className="px-2 py-2 font-mono">{r.shortId}</td>
                    <td className="px-2 py-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString('ru-RU')}</td>
                    <td className="px-2 py-2">{r.signal === 'error' ? '⚠️ Ошибка' : '👍 Полезно'}</td>
                    <td className="px-2 py-2 max-w-xs text-[var(--color-text-muted)]">{(r.messageText ?? '').replace(/\[.*?\]/g, '').slice(0, 100)}</td>
                    <td className={`px-2 py-2 ${st.cls}`}>{st.label}</td>
                    <td className="px-2 py-2 max-w-sm">{r.reviewNote ?? (r.status === 'pending' ? '—' : '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
