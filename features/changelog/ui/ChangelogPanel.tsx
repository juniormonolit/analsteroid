'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X, Bell } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';
import { ru } from 'date-fns/locale';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { useChangelogQuery } from './useChangelogQuery';
import type { ChangelogEntry, ChangelogListResponse } from '@/lib/changelog/types';

function dateLabel(d: Date): string {
  if (isToday(d)) return 'Сегодня';
  if (isYesterday(d)) return 'Вчера';
  return format(d, 'd MMMM', { locale: ru });
}

interface Props {
  onClose: () => void;
}

/**
 * Выезжающая справа панель «Что изменилось?» (макет владельца,
 * changelog-notifications-mock.html) — тот же паттерн, что HighlightEditor в
 * немодальном (не docked) режиме: fixed-бэкдроп + fixed-панель справа,
 * PanelCloseTab первым ребёнком, useSlideClose для плавного закрытия (п. Н3 спеки).
 */
export function ChangelogPanel({ onClose }: Props) {
  const { data } = useChangelogQuery();
  const qc = useQueryClient();
  const { closing, requestClose } = useSlideClose(onClose);

  // Снимок seenAt НА МОМЕНТ ОТКРЫТИЯ — по нему решаем, что подсвечивать
  // непрочитанным в этой сессии просмотра. POST seen ниже обнулит unreadCount в
  // кэше (бейдж в сайдбаре погаснет сразу), но подсветка внутри уже открытой
  // панели должна остаться до её закрытия — иначе пользователь не успеет увидеть,
  // что именно было новым.
  const [seenAtSnapshot] = useState<string | null>(() => data?.seenAt ?? null);
  const markedRef = useRef(false);

  useEffect(() => {
    if (markedRef.current) return;
    markedRef.current = true;
    markAllRead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function markAllRead() {
    fetch('/api/changelog/seen', { method: 'POST' })
      .then(res => (res.ok ? res.json() : null))
      .then((result: { ok: boolean; seenAt: string | null } | null) => {
        if (!result) return;
        qc.setQueryData<ChangelogListResponse | undefined>(['changelog'], prev =>
          prev ? { ...prev, unreadCount: 0, seenAt: result.seenAt } : prev
        );
      })
      .catch(() => {
        // Тихо игнорируем — счётчик просто не обнулится до следующего открытия/refetch,
        // не критично для UX ленты.
      });
  }

  const groups = useMemo(() => {
    const entries = data?.entries ?? [];
    const map = new Map<string, ChangelogEntry[]>();
    for (const e of entries) {
      const label = dateLabel(new Date(e.publishedAt));
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(e);
    }
    return Array.from(map.entries());
  }, [data]);

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/30 transition-opacity duration-150 ${closing ? 'opacity-0' : 'opacity-100'}`}
        onClick={requestClose}
      />
      <div
        className={`fixed inset-y-0 right-0 z-50 w-[380px] max-w-[94vw] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}
      >
        <PanelCloseTab onClick={requestClose} />

        {/* Header */}
        <div className="flex items-baseline gap-2.5 px-5 sm:px-6 py-4 border-b border-[var(--color-border)] shrink-0">
          <h2 className="text-[17px] font-bold text-[var(--color-text)] m-0 flex items-center gap-2">
            <Bell size={16} className="text-[var(--color-accent)]" />
            Что изменилось?
          </h2>
          <button
            onClick={markAllRead}
            className="ml-auto text-xs font-semibold text-[var(--color-accent)] hover:underline shrink-0 self-center"
          >
            Отметить всё прочитанным
          </button>
          <button
            onClick={requestClose}
            className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-2.5 py-2">
          {groups.length === 0 && (
            <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">
              Пока нет записей
            </div>
          )}
          {groups.map(([label, items]) => (
            <div key={label}>
              <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--color-text-muted)] px-3 pt-3.5 pb-2">
                {label}
              </div>
              {items.map(e => {
                const unread = !seenAtSnapshot || new Date(e.publishedAt) > new Date(seenAtSnapshot);
                return (
                  <div
                    key={e.id}
                    className={`flex gap-2.5 px-3 py-2.5 rounded-[10px] mb-0.5 ${unread ? 'bg-[var(--color-accent-soft)]' : ''}`}
                  >
                    <span
                      className={`shrink-0 w-[7px] h-[7px] rounded-full mt-1.5 ${unread ? 'bg-[var(--color-accent)]' : 'bg-transparent'}`}
                    />
                    <div className="min-w-0 flex-1">
                      <span
                        className={`inline-block text-[10px] font-bold rounded-md px-1.5 py-0.5 mb-1 ${
                          unread
                            ? 'text-[var(--color-accent)] bg-[var(--color-bg-surface)]'
                            : 'text-[var(--color-text-muted)] bg-[var(--color-bg-hover)]'
                        }`}
                      >
                        {e.category}
                      </span>
                      <div
                        className={`text-[13.5px] font-bold mb-0.5 ${unread ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
                      >
                        {e.title}
                      </div>
                      <div className="text-xs leading-[1.45] text-[var(--color-text-muted)]">
                        {e.body}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
