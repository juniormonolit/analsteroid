'use client';
// Раздел «Уведомления» (правка владельца 05.08: «уведомления в виде висящего
// колокольчика надо нахуй убрать оттуда в раздел уведомления»). Колокольчик из
// шапки карточки удалён — вместо него пункт рельсы со счётчиком непрочитанного
// (useUnreadCount) и эта страница. Данные — те же /api/notifications (GET
// список + PATCH «прочитать»), новых ручек не заводим.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export interface NotificationRow {
  id: number; type: string; title: string; body: string | null; link: string | null;
  unread: boolean; at: string;
}

// Общий хук: страница и рельса читают ОДИН queryKey — React Query дедуплицирует
// запрос, счётчик у пункта меню и список всегда согласованы.
export function useNotifications() {
  return useQuery<{ notifications: NotificationRow[]; unread: number }>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}

function fmtWhen(at: string): string {
  const d = new Date(at);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const day = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  if (day === today) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useNotifications();
  const list = data?.notifications ?? [];
  const unread = data?.unread ?? 0;

  const markAll = useMutation({
    mutationFn: async () => {
      await fetch('/api/notifications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  // Подсветка нового ЗА ЭТОТ ЗАХОД. Раньше её фактически не было, хотя код был
  // написан: открытие раздела сразу помечало всё прочитанным, список
  // перезапрашивался с unread=false, и синие точки гасли на глазах — человек не
  // успевал увидеть, что именно пришло нового. Теперь id, пришедшие
  // непрочитанными, запоминаются на время визита и подсвечиваются, даже когда
  // сервер уже считает их прочитанными. Накапливаем, а не снимаем снимок один
  // раз: страница опрашивается каждые 2 минуты, и уведомление, прилетевшее пока
  // человек её читает, тоже обязано подсветиться.
  const [newIds, setNewIds] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    if (!data) return;
    setNewIds(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const n of data.notifications) {
        if (n.unread && !next.has(n.id)) { next.add(n.id); changed = true; }
      }
      return changed ? next : prev; // без changed — бесконечный цикл рендеров
    });
  }, [data]);

  // «Увидел — счётчик погас» (механика владельца): открытие раздела помечает
  // всё прочитанным. Гаснет кружок у пункта меню; подсветка в списке живёт до
  // ухода со страницы (см. newIds выше).
  useEffect(() => {
    if (unread > 0 && !markAll.isPending) markAll.mutate();
    // намеренно только по unread: повторный вызов при том же значении не нужен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  return (
    <div className="mx-auto w-full max-w-[860px] p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h1 className="text-xl font-extrabold text-[var(--color-text)]">🔔 Уведомления</h1>
        <span className="text-[13px] text-[var(--color-text-muted)]">
          {isLoading ? 'загрузка…' : `${list.length} за последнее время`}
        </span>
      </div>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-2">
        {list.length === 0 && !isLoading ? (
          <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">
            Пока пусто — здесь появятся награды, квесты, переводы и заявки.
          </div>
        ) : (
          <div className="flex flex-col">
            {list.map(n => {
              // Подсветка — по newIds, а не по n.unread: сервер гасит unread
              // сразу при входе, а человеку нужно успеть увидеть новое.
              const isNew = newIds.has(n.id);
              const row = (
                <div className={`flex items-start gap-2.5 border-b border-[var(--color-border)] py-3 last:border-0 ${isNew ? '' : 'opacity-70'}`}>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${isNew ? 'bg-[var(--color-accent)]' : 'bg-transparent'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[14px] font-semibold text-[var(--color-text)]">{n.title}</span>
                      <span className="ml-auto shrink-0 whitespace-nowrap text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtWhen(n.at)}</span>
                    </div>
                    {n.body && <div className="mt-0.5 text-[13px] text-[var(--color-text-muted)]">{n.body}</div>}
                  </div>
                </div>
              );
              return n.link
                ? <Link key={n.id} href={n.link} className="block hover:bg-[var(--color-bg-hover)] -mx-2 px-2 rounded-lg transition-colors">{row}</Link>
                : <div key={n.id}>{row}</div>;
            })}
          </div>
        )}
      </section>
    </div>
  );
}
