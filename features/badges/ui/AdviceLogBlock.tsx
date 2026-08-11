'use client';

// Журнал подсказок «кому звонить» — сами строки (владелец 11.08: «хочу видеть
// реальный журнал. А тут только цифры»).
//
// Показываем не только «что советовали», но и НА ЧЁМ основано и что стало:
// без этого журнал не отвечает на вопрос, ради которого его открывают —
// «подсказка была толковая или мимо».

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';

interface Row {
  id: number; managerId: string; managerName: string | null;
  clientKey: string; clientName: string | null;
  recommendedGroup: string; basedOnGroups: string[]; fallback: boolean;
  confidencePct: number | null; callSignal: string | null; digestKind: string;
  status: string; reminderCount: number;
  advisedAt: string | null; contactedAt: string | null;
  resolvedAt: string | null; resolvedReason: string | null;
}
interface Payload { total: number; page: number; pageSize: number; rows: Row[]; error?: string }

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  active: { label: 'В работе', color: 'var(--color-text-muted)' },
  contacted: { label: 'Контакт был', color: '#1c7ed6' },
  success: { label: 'Сработало', color: '#2f9e44' },
  closed_no_contact: { label: 'Не дозвонились', color: '#e8590c' },
  closed_no_deal: { label: 'Контакт без сделки', color: '#9c36b5' },
};
const SIGNAL_LABELS: Record<string, string> = {
  overdue_repeat: 'просрочен цикл повтора',
  active_no_call: 'сделка без звонка',
};
const REASON_LABELS: Record<string, string> = {
  no_contact_timeout: 'исчерпаны напоминания, контакта не было',
  no_deal_after_contact: 'контакт был, сделки за 21 день нет',
};

const FILTERS: { key: string; label: string }[] = [
  { key: '', label: 'Все' },
  { key: 'active', label: 'В работе' },
  { key: 'contacted', label: 'Контакт был' },
  { key: 'success', label: 'Сработало' },
  { key: 'closed_no_contact', label: 'Не дозвонились' },
  { key: 'closed_no_deal', label: 'Без сделки' },
];

const fmt = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

export function AdviceLogBlock() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [page, setPage] = useState(0);

  const { data } = useQuery<Payload>({
    queryKey: ['digest-log', status, q, page],
    queryFn: async () => {
      const sp = new URLSearchParams();
      if (status) sp.set('status', status);
      if (q) sp.set('q', q);
      if (page) sp.set('page', String(page));
      const res = await fetch(`/api/settings/digest/log?${sp}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  if (!data) return null;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <section className="mt-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold">Журнал подсказок — строки</h2>
        <span className="text-[11px] text-[var(--color-text-muted)]">найдено {data.total}</span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1">
        {FILTERS.map(f => (
          <button
            key={f.key} type="button"
            onClick={() => { setStatus(f.key); setPage(0); }}
            className={`min-h-11 rounded-lg px-2.5 text-[13px] sm:min-h-8 ${
              status === f.key ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto inline-flex items-center gap-1">
          <Search size={13} className="text-[var(--color-text-muted)]" />
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { setQ(draft.trim()); setPage(0); } }}
            onBlur={() => { setQ(draft.trim()); setPage(0); }}
            placeholder="заказчик или группа"
            className="min-h-11 w-44 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:min-h-8 sm:text-xs"
          />
        </span>
      </div>

      {data.error && <div className="mb-2 text-xs text-[var(--color-text-muted)]">{data.error}</div>}

      {data.rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Ничего не нашлось.</div>
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th className="py-1 pr-2 font-medium">Выдана</th>
                <th className="py-1 pr-2 font-medium">Менеджер</th>
                <th className="py-1 pr-2 font-medium">Заказчик</th>
                <th className="py-1 pr-2 font-medium">Советовали</th>
                <th className="py-1 pr-2 font-medium">На основании</th>
                <th className="py-1 pr-2 font-medium">Почему звонить</th>
                <th className="py-1 pr-2 font-medium">Статус</th>
                <th className="py-1 font-medium">Итог</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => {
                const st = STATUS_LABELS[r.status] ?? { label: r.status, color: 'var(--color-text-muted)' };
                return (
                  <tr key={r.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">{fmt(r.advisedAt)}</td>
                    <td className="py-1.5 pr-2">{r.managerName ?? r.managerId}</td>
                    <td className="py-1.5 pr-2">{r.clientName ?? r.clientKey}</td>
                    <td className="py-1.5 pr-2">
                      {r.recommendedGroup}
                      {r.confidencePct !== null && (
                        <span className="ml-1 text-[var(--color-text-muted)]">{r.confidencePct}%</span>
                      )}
                      {/* fallback = советовали общий топ базы, а не по этому клиенту.
                          Это надо видеть: такие подсказки слабее по определению. */}
                      {r.fallback && <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">(общий топ)</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-[var(--color-text-muted)]">
                      {r.basedOnGroups.length > 0 ? r.basedOnGroups.join(', ') : '—'}
                    </td>
                    <td className="py-1.5 pr-2 text-[var(--color-text-muted)]">
                      {r.callSignal ? (SIGNAL_LABELS[r.callSignal] ?? r.callSignal) : '—'}
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <span style={{ color: st.color }}>{st.label}</span>
                      {r.reminderCount > 0 && (
                        <span className="ml-1 text-[11px] text-[var(--color-text-muted)]">
                          напом. {r.reminderCount}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-[var(--color-text-muted)]">
                      {r.status === 'success' && r.resolvedAt ? `сделка ${fmt(r.resolvedAt)}`
                        : r.resolvedReason ? (REASON_LABELS[r.resolvedReason] ?? r.resolvedReason)
                        : r.contactedAt ? `контакт ${fmt(r.contactedAt)}`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs">
          <button
            type="button" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
            className="tap-target rounded p-1 disabled:opacity-30 hover:bg-[var(--color-bg-hover)]"
            aria-label="Предыдущая страница"
          ><ChevronLeft size={14} /></button>
          <span className="tabular-nums text-[var(--color-text-muted)]">{page + 1} / {pages}</span>
          <button
            type="button" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)}
            className="tap-target rounded p-1 disabled:opacity-30 hover:bg-[var(--color-bg-hover)]"
            aria-label="Следующая страница"
          ><ChevronRight size={14} /></button>
        </div>
      )}
    </section>
  );
}
