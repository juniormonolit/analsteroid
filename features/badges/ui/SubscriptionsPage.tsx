'use client';
// «Директор и выше видят все настройки подписки сотрудников — по роли, без
// возможности менять чужое» (правка владельца 02.08, задача 2765). READ-ONLY:
// нет ни одной кнопки редактирования — менять можно только свои настройки
// (ЛК → Уведомления). Доступ гейтит сам API (action.subscriptions.view_all
// или superadmin) — эта страница рендерится всем, но при 403 просто покажет
// сообщение об отсутствии доступа (роли РОП это право НЕ выдаётся по умолчанию).

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

interface Row {
  bitrixId: number; name: string; customized: boolean; updatedAt: string | null;
  prefs: { enabled: boolean; dailyDigest: boolean; weeklyDigest: boolean; adviceCustomers: boolean; adviceNumbers: boolean };
}

type SortKey = 'name' | 'enabled' | 'updatedAt';
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

function SortableTh({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: SortState; onSort: (k: SortKey) => void }) {
  const active = sort?.key === sortKey;
  return (
    <th onClick={() => onSort(sortKey)} className="px-2 py-2 text-left font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] text-[var(--color-text-muted)]">
      {label}<span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

function Check({ v }: { v: boolean }) {
  return <span className={v ? 'text-green-600' : 'text-[var(--color-text-muted)]'}>{v ? '✓' : '—'}</span>;
}

export function SubscriptionsPage() {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const { data, isLoading, error } = useQuery<{ rows: Row[] }>({
    queryKey: ['settings-subscriptions'],
    queryFn: async () => {
      const res = await fetch('/api/settings/subscriptions');
      if (!res.ok) throw new Error(res.status === 403 ? 'forbidden' : `HTTP ${res.status}`);
      return res.json();
    },
    retry: false,
  });

  const handleSort = (key: SortKey) => {
    setSort(cur => {
      if (cur?.key !== key) return { key, dir: 'asc' };
      if (cur.dir === 'asc') return { key, dir: 'desc' };
      return { key: 'name', dir: 'asc' };
    });
  };

  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    if (!sort) return list;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const av = sort.key === 'name' ? a.name : sort.key === 'enabled' ? (a.prefs.enabled ? 1 : 0) : (a.updatedAt ?? '');
      const bv = sort.key === 'name' ? b.name : sort.key === 'enabled' ? (b.prefs.enabled ? 1 : 0) : (b.updatedAt ?? '');
      if (av === bv) return 0;
      return av > bv ? dir : -dir;
    });
  }, [data, sort]);

  if (error) {
    return <div className="p-6 text-sm text-[var(--color-text-muted)]">Доступ к этой странице ограничен (директор и выше).</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl">
      <h1 className="text-lg font-semibold mb-1">Подписки сотрудников на бота «Аналитик»</h1>
      <p className="mb-4 text-xs text-[var(--color-text-muted)]">
        Только просмотр — менять чужие настройки нельзя, каждый управляет своей подпиской сам
        (ЛК → «Уведомления»). Отключение никак не влияет на рейтинг, награды и XP.
      </p>
      {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
        <table className="w-full text-xs">
          <thead className="border-b border-[var(--color-border)]">
            <tr>
              <SortableTh label="Сотрудник" sortKey="name" sort={sort} onSort={handleSort} />
              <SortableTh label="Вкл" sortKey="enabled" sort={sort} onSort={handleSort} />
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Ежедневный</th>
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Еженедельный</th>
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Заказчики</th>
              <th className="px-2 py-2 text-left font-medium text-[var(--color-text-muted)]">Цифры</th>
              <SortableTh label="Изменено" sortKey="updatedAt" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.bitrixId} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-2 py-2 whitespace-nowrap">{r.name}{!r.customized && <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">(по умолчанию)</span>}</td>
                <td className="px-2 py-2"><Check v={r.prefs.enabled} /></td>
                <td className="px-2 py-2"><Check v={r.prefs.dailyDigest} /></td>
                <td className="px-2 py-2"><Check v={r.prefs.weeklyDigest} /></td>
                <td className="px-2 py-2"><Check v={r.prefs.adviceCustomers} /></td>
                <td className="px-2 py-2"><Check v={r.prefs.adviceNumbers} /></td>
                <td className="px-2 py-2 whitespace-nowrap text-[var(--color-text-muted)]">{r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('ru-RU') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
