'use client';
// Супер-админ: «Монолитика» в левом меню Битрикса для всех сотрудников (17.09).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Status { hasToken: boolean; bindings: { placement: string; handler: string; title?: string }[]; hint?: string; error?: string; handler?: string; handlers?: Record<Target, string> }
type Target = 'profile' | 'repeat-kanban';
const ITEMS: { target: Target; title: string; hint: string }[] = [
  { target: 'profile', title: 'Монолитика', hint: 'личный кабинет' },
  { target: 'repeat-kanban', title: 'Канбан повторных', hint: 'доска повторных продаж (видят те, у кого есть право на канбан)' },
];

export function BitrixLeftMenuBlock() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Status>({ queryKey: ['bitrix-left-menu'], queryFn: () => fetch('/api/admin/bitrix/left-menu').then(r => r.json()), refetchOnWindowFocus: false });
  const call = useMutation({
    mutationFn: async ({ method, target }: { method: 'POST' | 'DELETE'; target: Target }) => {
      const res = await fetch(`/api/admin/bitrix/left-menu?target=${target}`, { method });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bitrix-left-menu'] }),
  });
  const boundTo = (t: Target) => (data?.bindings ?? []).some(b => b.placement === 'LEFT_MENU' && data?.handlers && b.handler.replace(/\/$/, '') === data.handlers[t]);
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
      {ITEMS.map(it => {
        const bound = boundTo(it.target);
        return (
          <div key={it.target} className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2">
            <div className="min-w-0 flex-1 text-sm">
              <b className="text-[var(--color-text)]">«{it.title}»</b> <span className="text-xs text-[var(--color-text-muted)]">— {it.hint}{data?.hasToken && !data.error ? (bound ? ' · в меню' : ' · не в меню') : ''}</span>
            </div>
            <button type="button" className={`${btn} !border-transparent bg-[var(--color-accent)] text-[var(--color-text-inverse)]`} disabled={call.isPending || !data?.hasToken} onClick={() => call.mutate({ method: 'POST', target: it.target })}>
              {bound ? 'Перепривязать' : 'Добавить в левое меню'}
            </button>
            {bound && <button type="button" className={btn} disabled={call.isPending} onClick={() => call.mutate({ method: 'DELETE', target: it.target })}>Убрать</button>}
          </div>
        );
      })}
      {call.isError && <div className="text-xs text-[var(--color-negative)]">{(call.error as Error).message}</div>}
      {call.isSuccess && <div className="text-xs text-[var(--color-positive,#16a34a)]">Готово — обновите страницу Битрикса.</div>}
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Если пункт видят не все: в Битриксе → Приложения → Установленные → «Монолитика» → права доступа → «Все сотрудники». Это настройка портала, из нашего приложения её не поменять.
      </p>
    </section>
  );
}
