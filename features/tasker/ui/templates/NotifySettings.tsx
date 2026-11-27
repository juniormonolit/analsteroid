'use client';
// «Сообщения менеджерам» (собрание 26.11, п.2): бот «Аналитик» пишет менеджеру о разборе с РОПом / занятии с тренером
// (назначено, перенос, отмена, смена темы) и напоминает перед началом. Здесь — за сколько напоминать.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';

interface Resp { remindMinutes: number; options: number[]; canEdit: boolean }
const KEY = ['tasker', 'notify-settings'] as const;
const label = (m: number) => (m === 1440 ? 'За день' : m === 60 ? 'За час' : `За ${m} минут`);

async function call(init?: RequestInit): Promise<Resp> {
  const r = await fetch('/api/tasker/notify-settings', init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as Resp;
}

export function NotifySettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => call(), staleTime: 60_000, retry: false });
  const save = useMutation({
    mutationFn: (m: number) => call({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remindMinutes: m }) }),
    onSuccess: d => qc.setQueryData(KEY, d),
  });
  if (!q.data) return null;
  return (
    <section className="flex min-w-0 max-w-3xl flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3 sm:flex-row sm:items-center">
      <BellRing size={18} className="hidden shrink-0 text-[var(--color-accent)] sm:block" aria-hidden />
      <div className="min-w-0 flex-1 text-sm leading-snug text-[var(--color-text)]">
        <b>Сообщения менеджерам.</b>{' '}
        <span className="text-[var(--color-text-secondary)]">Бот «Аналитик» пишет менеджеру, когда с ним назначен разбор или занятие (время, кто ведёт, по какой метрике), о переносе и отмене — и напоминает перед началом.</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1 sm:w-56">
        <SearchSelect options={q.data.options.map(m => ({ value: String(m), label: label(m) }))} value={String(q.data.remindMinutes)}
          onChange={v => save.mutate(Number(v))} disabled={!q.data.canEdit || save.isPending}
          ariaLabel="Когда напоминать менеджеру" className="w-full" />
        {save.error && <span className="text-xs text-[var(--color-negative)]">{(save.error as Error).message}</span>}
      </div>
    </section>
  );
}
