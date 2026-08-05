'use client';
// Заявки на активацию предметов магазина — блок руководителя (MVP магазина,
// 31.07), та же логика managed-depts, что у заявок на вывод в ЗП (PayoutManage):
// РОП видит заявки СВОИХ подчинённых, админ — всех (в «Настройки → Награды»).
// «Одобрить» = предмет использован (эффект — организационно); «Отклонить» —
// с обязательной причиной, предмет ВОЗВРАЩАЕТСЯ в инвентарь менеджера.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';

interface ManagedActivation {
  id: number; bitrix_id: number; managerName: string; item_name: string;
  price_paid: number; currency: 'EBALL' | 'RUB';
  status: 'activation_requested' | 'used' | 'owned';
  activation_comment: string | null; resolver_login: string | null; resolve_comment: string | null;
  requested_at: string | null; expires_at: string; resolved_at: string | null;
}

export function InventoryManageBlock({ standalone = false }: { standalone?: boolean } = {}) {
  const qc = useQueryClient();
  // Подтверждение/отклонение — вместо window.confirm+window.prompt (задача 2764).
  const [approving, setApproving] = useState<ManagedActivation | null>(null);
  const [rejecting, setRejecting] = useState<ManagedActivation | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  // «Одобрить» — расход предмета менеджера, пин ВСЕГДА (спека §3, задача
  // #2995/#3020); «Отклонить» деньги не двигает, пин бэк не спрашивает.
  const [pinSetupFor, setPinSetupFor] = useState<ManagedActivation | null>(null);
  const [pinVerifyFor, setPinVerifyFor] = useState<ManagedActivation | null>(null);
  const { data } = useQuery<{ canManage: boolean; requests: ManagedActivation[] }>({
    queryKey: ['shop-activations-manage'],
    queryFn: async () => {
      const res = await fetch('/api/shop/activate?scope=manage');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['shop-activations-manage'] });
    void qc.invalidateQueries({ queryKey: ['shop'] });
  };

  const act = useMutation({
    mutationFn: async ({ row, action, comment }: { row: ManagedActivation; action: 'approve' | 'reject'; comment?: string }) => {
      const r = await fetchPinGated('/api/shop/activate', 'PATCH', { id: row.id, action, comment });
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
  if (!data?.canManage) return null;
  if (!standalone && requests.length === 0) return null;
  const pending = requests.filter(r => r.status === 'activation_requested');
  const resolved = requests.filter(r => r.status !== 'activation_requested').slice(0, standalone ? 100 : 10);

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🎟️ Заявки на активацию призов</h2>
        {pending.length > 0 && <span className="text-xs font-semibold text-[var(--color-accent)]">{pending.length} ждут решения</span>}
        {error && <span className="text-xs text-[var(--color-negative,#e03131)]">{error}</span>}
      </div>
      <div className="flex flex-col">
        {pending.map(r => (
          <div key={r.id} className="flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] py-2 text-[13px] first:border-t-0">
            {r.requested_at && (
              <span className="tabular-nums text-[var(--color-text-muted)]">{r.requested_at.slice(0, 10).split('-').reverse().join('.')}</span>
            )}
            <span className="font-semibold text-[var(--color-text)]">{r.managerName}</span>
            <span className="text-[var(--color-text)]">{r.item_name}</span>
            {r.activation_comment && <span className="text-xs text-[var(--color-text-muted)]">«{r.activation_comment}»</span>}
            <span className="text-xs text-[var(--color-text-muted)]">годен до {r.expires_at.split('-').reverse().join('.')}</span>
            <span className="ml-auto flex gap-2">
              <button type="button"
                onClick={() => setApproving(r)}
                className="rounded-lg bg-[var(--color-positive,#2f9e44)] px-3 py-1 text-xs font-semibold text-white">
                Одобрить
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
            {r.resolved_at && (
              <span className="tabular-nums text-[var(--color-text-muted)]">{r.resolved_at.slice(0, 10).split('-').reverse().join('.')}</span>
            )}
            <span className="text-[var(--color-text)]">{r.managerName}</span>
            <span className="text-[var(--color-text-muted)]">{r.item_name}</span>
            <span className="text-xs font-semibold"
              style={{ color: r.status === 'used' ? 'var(--color-positive,#2f9e44)' : 'var(--color-negative,#e03131)' }}>
              {r.status === 'used' ? 'одобрено' : 'отклонено (предмет возвращён)'}
            </span>
            {r.resolve_comment && r.status !== 'used' && <span className="text-xs text-[var(--color-text-muted)]">{r.resolve_comment}</span>}
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!approving}
        title="Одобрить активацию?"
        description={approving ? `Одобрить «${approving.item_name}» для ${approving.managerName}? Предмет будет отмечен использованным.` : ''}
        confirmLabel="Одобрить"
        pending={act.isPending}
        onConfirm={() => { if (approving) { act.mutate({ row: approving, action: 'approve' }); setApproving(null); } }}
        onCancel={() => setApproving(null)}
      />
      <Modal
        open={!!rejecting}
        onOpenChange={(o) => { if (!o) setRejecting(null); }}
        title={`Отклонить заявку: ${rejecting?.managerName ?? ''}`}
        desktopWidth="sm:max-w-sm"
      >
        <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Причина отклонения (менеджер её увидит; предмет вернётся в его инвентарь)
          <textarea autoFocus value={rejectComment} onChange={e => setRejectComment(e.target.value)} rows={3}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm" />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setRejecting(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={act.isPending || !rejectComment.trim()}
            onClick={() => { if (rejecting) { act.mutate({ row: rejecting, action: 'reject', comment: rejectComment.trim() }); setRejecting(null); } }}
            className="rounded-lg bg-[var(--color-negative,#e03131)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            Отклонить
          </button>
        </div>
      </Modal>
      <PinSetupDialog
        open={!!pinSetupFor}
        onOpenChange={(o) => { if (!o) setPinSetupFor(null); }}
        onSuccess={() => { const row = pinSetupFor; setPinSetupFor(null); if (row) act.mutate({ row, action: 'approve' }); }}
      />
      <PinDialog
        open={!!pinVerifyFor}
        onOpenChange={(o) => { if (!o) setPinVerifyFor(null); }}
        title="Подтвердите одобрение пином"
        description={pinVerifyFor ? `«${pinVerifyFor.item_name}» — ${pinVerifyFor.managerName}` : undefined}
        onConfirm={async (pin) => {
          if (!pinVerifyFor) return { ok: false, error: 'Нет заявки' };
          const r = await fetchPinGated('/api/shop/activate', 'PATCH', { id: pinVerifyFor.id, action: 'approve', pin });
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
