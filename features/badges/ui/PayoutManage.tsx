'use client';
// Заявки на вывод рублей в ЗП — блок руководителя (доп. Серёги 31.07):
// РОП видит заявки СВОИХ подчинённых (managed-depts, как «Моя команда»),
// админ — всех (тот же блок в «Настройки → Награды»). «Выплачено» = списание
// с рублёвого баланса записью в леджер; «Отклонить» — с обязательной причиной,
// менеджер видит её в своём списке заявок. Фактическая выплата — бухгалтерией.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface ManagedPayout {
  id: number; bitrix_id: number; managerName: string; amount: number;
  status: 'requested' | 'paid' | 'rejected'; comment: string | null;
  resolver_login: string | null; requested_at: string; resolved_at: string | null;
  rub_balance: number;
}

export function PayoutManageBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<{ canManage: boolean; requests: ManagedPayout[] }>({
    queryKey: ['badges-payouts-manage'],
    queryFn: async () => {
      const res = await fetch('/api/badges/payout?scope=manage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const act = useMutation({
    mutationFn: async ({ id, action, comment }: { id: number; action: 'paid' | 'rejected'; comment?: string }) => {
      const res = await fetch('/api/badges/payout', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, comment }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['badges-payouts-manage'] });
      void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    },
  });

  const requests = data?.requests ?? [];
  if (!data?.canManage || requests.length === 0) return null;
  const pending = requests.filter(r => r.status === 'requested');
  const resolved = requests.filter(r => r.status !== 'requested').slice(0, 10);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">💸 Заявки на вывод в ЗП</h2>
        {pending.length > 0 && <span className="text-xs font-semibold text-[var(--color-accent)]">{pending.length} ждут решения</span>}
      </div>
      <div className="flex flex-col">
        {pending.map(r => (
          <div key={r.id} className="flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] py-2 text-[13px] first:border-t-0">
            <span className="tabular-nums text-[var(--color-text-muted)]">{r.requested_at.slice(0, 10).split('-').reverse().join('.')}</span>
            <span className="font-semibold text-[var(--color-text)]">{r.managerName}</span>
            <span className="font-bold tabular-nums text-[var(--color-text)]">{r.amount.toLocaleString('ru-RU')} ₽</span>
            <span className="text-xs text-[var(--color-text-muted)]">(баланс {r.rub_balance.toLocaleString('ru-RU')} ₽)</span>
            <span className="ml-auto flex gap-2">
              <button type="button"
                onClick={() => {
                  if (window.confirm(`Отметить выплаченным ${r.amount} ₽ для ${r.managerName}? Сумма спишется с рублёвого баланса.`)) {
                    act.mutate({ id: r.id, action: 'paid' });
                  }
                }}
                className="rounded-lg bg-[var(--color-positive,#2f9e44)] px-3 py-1 text-xs font-semibold text-white">
                Выплачено
              </button>
              <button type="button"
                onClick={() => {
                  const comment = window.prompt('Причина отклонения (менеджер её увидит):');
                  if (comment && comment.trim()) act.mutate({ id: r.id, action: 'rejected', comment: comment.trim() });
                }}
                className="rounded-lg border border-[var(--color-negative,#e03131)] px-3 py-1 text-xs font-semibold text-[var(--color-negative,#e03131)]">
                Отклонить
              </button>
            </span>
          </div>
        ))}
        {resolved.map(r => (
          <div key={r.id} className="flex flex-wrap items-baseline gap-2.5 border-t border-[var(--color-border)] py-1.5 text-[12.5px] opacity-70">
            <span className="tabular-nums text-[var(--color-text-muted)]">{r.requested_at.slice(0, 10).split('-').reverse().join('.')}</span>
            <span className="text-[var(--color-text)]">{r.managerName}</span>
            <span className="tabular-nums">{r.amount.toLocaleString('ru-RU')} ₽</span>
            <span className="text-xs font-semibold" style={{ color: r.status === 'paid' ? 'var(--color-positive,#2f9e44)' : 'var(--color-negative,#e03131)' }}>
              {r.status === 'paid' ? 'выплачено' : 'отклонено'}
            </span>
            {r.comment && <span className="text-xs text-[var(--color-text-muted)]">{r.comment}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
