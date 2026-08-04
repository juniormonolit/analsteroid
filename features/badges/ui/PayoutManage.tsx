'use client';
// Заявки на вывод рублей в ЗП — блок руководителя (доп. Серёги 31.07):
// РОП видит заявки СВОИХ подчинённых (managed-depts, как «Моя команда»),
// админ — всех (тот же блок в «Настройки → Награды»). «Выплачено» = списание
// с рублёвого баланса записью в леджер; «Отклонить» — с обязательной причиной,
// менеджер видит её в своём списке заявок. Фактическая выплата — бухгалтерией.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';

interface ManagedPayout {
  id: number; bitrix_id: number; managerName: string; amount: number;
  status: 'requested' | 'paid' | 'rejected'; comment: string | null;
  resolver_login: string | null; requested_at: string; resolved_at: string | null;
  rub_balance: number;
}

export function PayoutManageBlock() {
  const qc = useQueryClient();
  // Подтверждение/отклонение — вместо window.confirm+window.prompt (задача 2764).
  const [confirmingPaid, setConfirmingPaid] = useState<ManagedPayout | null>(null);
  const [rejecting, setRejecting] = useState<ManagedPayout | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  // «Выплачено» — резолвер списывает ЧУЖИЕ рубли, пин ВСЕГДА (спека §3, задача
  // #2995/#3020); «Отклонить» деньги не двигает, бэк пин не спрашивает —
  // fetchPinGated просто не сработает для этой ветки (r.ok сразу true).
  const [pinSetupFor, setPinSetupFor] = useState<ManagedPayout | null>(null);
  const [pinVerifyFor, setPinVerifyFor] = useState<ManagedPayout | null>(null);
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

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['badges-payouts-manage'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  const act = useMutation({
    mutationFn: async ({ row, action, comment }: { row: ManagedPayout; action: 'paid' | 'rejected'; comment?: string }) => {
      const r = await fetchPinGated('/api/badges/payout', 'PATCH', { id: row.id, action, comment });
      if (r.ok) return { done: true } as const;
      if (r.needsPinSetup) return { done: false, needsSetup: row } as const;
      if (r.needsPinVerify) return { done: false, needsVerify: row } as const;
      throw new Error(r.error ?? 'Ошибка');
    },
    onSuccess: (res) => {
      if (res.done) { setError(null); refresh(); return; }
      if (res.needsSetup) setPinSetupFor(res.needsSetup);
      if (res.needsVerify) setPinVerifyFor(res.needsVerify);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
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
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
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
                onClick={() => setConfirmingPaid(r)}
                className="rounded-lg bg-[var(--color-positive,#2f9e44)] px-3 py-1 text-xs font-semibold text-white">
                Выплачено
              </button>
              <button type="button"
                onClick={() => { setRejecting(r); setRejectComment(''); }}
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
      <ConfirmDialog
        open={!!confirmingPaid}
        title="Отметить выплаченным?"
        description={confirmingPaid ? `Отметить выплаченным ${confirmingPaid.amount} ₽ для ${confirmingPaid.managerName}? Сумма спишется с рублёвого баланса.` : ''}
        confirmLabel="Выплачено"
        pending={act.isPending}
        onConfirm={() => { if (confirmingPaid) { act.mutate({ row: confirmingPaid, action: 'paid' }); setConfirmingPaid(null); } }}
        onCancel={() => setConfirmingPaid(null)}
      />
      <Modal
        open={!!rejecting}
        onOpenChange={(o) => { if (!o) setRejecting(null); }}
        title={`Отклонить заявку: ${rejecting?.managerName ?? ''}`}
        desktopWidth="sm:max-w-sm"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Причина отклонения (менеджер её увидит)
          <textarea autoFocus value={rejectComment} onChange={e => setRejectComment(e.target.value)} rows={3}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm" />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setRejecting(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={act.isPending || !rejectComment.trim()}
            onClick={() => { if (rejecting) { act.mutate({ row: rejecting, action: 'rejected', comment: rejectComment.trim() }); setRejecting(null); } }}
            className="rounded-lg bg-[var(--color-negative,#e03131)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Отклонить
          </button>
        </div>
      </Modal>
      <PinSetupDialog
        open={!!pinSetupFor}
        onOpenChange={(o) => { if (!o) setPinSetupFor(null); }}
        onSuccess={() => { const row = pinSetupFor; setPinSetupFor(null); if (row) act.mutate({ row, action: 'paid' }); }}
      />
      <PinDialog
        open={!!pinVerifyFor}
        onOpenChange={(o) => { if (!o) setPinVerifyFor(null); }}
        title="Подтвердите выплату пином"
        description={pinVerifyFor ? `${pinVerifyFor.amount.toLocaleString('ru-RU')} ₽ — ${pinVerifyFor.managerName}` : undefined}
        onConfirm={async (pin) => {
          if (!pinVerifyFor) return { ok: false, error: 'Нет заявки' };
          const r = await fetchPinGated('/api/badges/payout', 'PATCH', { id: pinVerifyFor.id, action: 'paid', pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyFor(null);
          setError(null);
          refresh();
          return { ok: true };
        }}
      />
    </div>
  );
}
