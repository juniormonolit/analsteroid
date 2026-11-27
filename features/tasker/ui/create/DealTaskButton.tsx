'use client';
// «В Задачник» — поставить задачу по сделке прямо из карточки канбана (владелец 26.11: «из карточки большой сделки
// ставить задачу в задачник; и из канбана повторки тоже»). Та же форма «Задача по сделке», что в дриллдауне отчёта
// (DealTaskDrawer, миграция 289): исполнитель — менеджер сделки, РОП — соисполнитель, к сроку Задачник сам проверит
// движение сделки. Кнопки нет без права action.tasker.assign; зону (менеджер сделки — в зоне ставящего) проверяет
// сервер при предпросмотре сделки — форма покажет, если нельзя.
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { ListPlus } from 'lucide-react';
import { useCanAssignTasks } from './useCanAssignTasks';
import { hasDraft } from '@/lib/hooks/useStoredDraft';

const DealTaskDrawer = dynamic(() => import('./DealTaskDrawer').then(m => m.DealTaskDrawer), { ssr: false });

export function DealTaskButton({ dealId, className, label = 'В Задачник' }: { dealId: number | null | undefined; className?: string; label?: string }) {
  const can = useCanAssignTasks(true);
  const [open, setOpen] = useState(false);
  // Есть недописанный черновик (DealTaskDrawer хранит его по сделке) — точка на кнопке. После mount: без рассинхрона гидрации.
  const [draft, setDraft] = useState(false);
  useEffect(() => { if (!open && dealId) setDraft(hasDraft(`tasker-deal:${dealId}`)); }, [open, dealId]);
  if (!can || !dealId) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="Поставить задачу по этой сделке в Задачник — исполнитель менеджер сделки, к сроку Задачник проверит движение сделки"
        className={className ?? 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)]'}>
        <ListPlus size={14} aria-hidden /> {label}
        {draft && <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-warning)]" title="Есть недописанный черновик" aria-label="есть черновик" />}
      </button>
      {open && <DealTaskDrawer open onClose={() => setOpen(false)} dealIds={[dealId]} />}
    </>
  );
}
