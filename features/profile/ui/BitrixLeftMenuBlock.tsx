'use client';
// Супер-админ: «Монолитика» в левом меню Битрикса для всех сотрудников (17.09).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Status { hasToken: boolean; bindings: { placement: string; handler: string; title?: string }[]; hint?: string; error?: string; handler?: string }

export function BitrixLeftMenuBlock() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Status>({ queryKey: ['bitrix-left-menu'], queryFn: () => fetch('/api/admin/bitrix/left-menu').then(r => r.json()), refetchOnWindowFocus: false });
  const call = useMutation({
    mutationFn: async (method: 'POST' | 'DELETE') => {
      const res = await fetch('/api/admin/bitrix/left-menu', { method });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bitrix-left-menu'] }),
  });
  const bound = (data?.bindings ?? []).some(b => b.placement === 'LEFT_MENU');
  const btn = 'min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-40';
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 flex flex-col gap-2">
      <h2 className="text-base font-bold text-[var(--color-text)]">Битрикс: пункт в левом меню</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Привязка «Монолитики» в левое меню портала для всех, у кого есть доступ к приложению. Методы placement.* работают только
        токеном приложения — он появляется, когда вы открываете «Монолитику» внутри Битрикса, и живёт около часа.
      </p>
      {isLoading ? <div className="text-xs text-[var(--color-text-muted)]">Проверяем…</div> : data && (
        <div className="text-sm">
          {!data.hasToken ? <div className="text-[var(--color-warning,#d9840c)]">{data.hint}</div>
            : data.error ? <div className="text-[var(--color-negative)]">{data.error}</div>
            : <div>Сейчас привязано: {data.bindings.length ? data.bindings.map(b => <code key={b.placement + b.handler} className="ml-1 rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-xs">{b.placement}</code>) : <span className="text-[var(--color-text-muted)]">ничего</span>}</div>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${btn} !border-transparent bg-[var(--color-accent)] text-[var(--color-text-inverse)]`} disabled={call.isPending || !data?.hasToken} onClick={() => call.mutate('POST')}>
          {bound ? 'Перепривязать' : 'Добавить в левое меню'}
        </button>
        {bound && <button type="button" className={btn} disabled={call.isPending} onClick={() => call.mutate('DELETE')}>Убрать из меню</button>}
      </div>
      {call.isError && <div className="text-xs text-[var(--color-negative)]">{(call.error as Error).message}</div>}
      {call.isSuccess && <div className="text-xs text-[var(--color-positive,#16a34a)]">Готово — обновите страницу Битрикса.</div>}
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Если пункт видят не все: в Битриксе → Приложения → Установленные → «Монолитика» → права доступа → «Все сотрудники». Это настройка портала, из нашего приложения её не поменять.
      </p>
    </section>
  );
}
