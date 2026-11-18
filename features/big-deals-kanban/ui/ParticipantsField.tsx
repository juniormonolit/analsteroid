'use client';
// «Наблюдатели» в карточке задачи канбана больших чеков (встреча: «подключаем РОПа в наблюдатели»). Список людей —
// тот же, что у участников задач повторки (/api/repeat-kanban/people: менеджеры, РОПы, руководители). Изменение сразу
// уходит action `participants` (tasks.task.update AUDITORS). Свежий состав — из GET /task/{id}, не из снимка доски.
import { useState } from 'react';
import { Eye, X } from 'lucide-react';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { usePeople } from '@/features/repeat-kanban/ui/ParticipantsPicker';
import type { BigTaskCard } from '../engine/types';
import { Section, postBigAction } from './TaskDrawerShared';

export function ParticipantsField({ taskId, auditors, me, canManage, onChanged }: {
  taskId: number; auditors: string[]; me: string | null; canManage: boolean; onChanged: (card?: BigTaskCard) => void;
}) {
  const { data } = usePeople();
  const people = data?.people ?? [];
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const nameOf = (id: string) => people.find(p => p.id === id)?.name ?? `Сотрудник ${id}`;

  const save = async (next: string[]) => {
    setBusy(true); setErr(null); setWarn(null);
    try {
      const r = await postBigAction({ type: 'participants', taskId, auditors: [...new Set(next)] });
      if (r.warnings?.length) setWarn(r.warnings.join('; '));
      onChanged(r.card);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const options = [
    ...people.map(p => ({ value: p.id, label: p.name, hint: p.dept ?? undefined })),
    // Наблюдатель не из оргструктуры — чтобы не пропал из выбора.
    ...auditors.filter(id => !people.some(p => p.id === id)).map(id => ({ value: id, label: nameOf(id) })),
  ];

  return (
    <Section title="Наблюдатели">
      <div className="flex flex-col gap-2">
        {auditors.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {auditors.map(id => (
              <li key={id} className="inline-flex min-h-8 items-center gap-1 rounded-full border border-[var(--color-border)] pl-2.5 pr-1 text-[12.5px]">
                {nameOf(id)}{id === me ? ' (вы)' : ''}
                {canManage && (
                  <button type="button" aria-label={`Убрать ${nameOf(id)}`} disabled={busy} onClick={() => void save(auditors.filter(x => x !== id))}
                    className="tap-target rounded-full p-0.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-50"><X size={12} /></button>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-[var(--color-text-muted)]">Наблюдателей нет</p>}
        {canManage && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <SearchMultiSelect ariaLabel="Наблюдатели" allLabel="Добавить наблюдателей" unitLabel="наблюдателей" searchPlaceholder="Поиск сотрудника"
              options={options} value={auditors} onChange={v => { if (!busy) void save(v); }}
              className="inline-flex min-h-11 w-full items-center justify-start gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm" />
            {me && !auditors.includes(me) && (
              <button type="button" disabled={busy} onClick={() => void save([...auditors, me])}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
                <Eye size={14} /> Добавить меня наблюдателем
              </button>
            )}
          </div>
        )}
        {busy && <p className="text-[12px] text-[var(--color-text-muted)]">Сохраняю…</p>}
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        {warn && <p className="text-[var(--color-warning)]">{warn}</p>}
      </div>
    </Section>
  );
}
