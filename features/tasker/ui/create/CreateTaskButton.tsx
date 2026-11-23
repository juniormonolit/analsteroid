'use client';
import { useState } from 'react';
import { ListPlus } from 'lucide-react';
import { CreateTaskDrawer, type CreateTaskDrawerProps } from './CreateTaskDrawer';
import { useCanAssignTasks } from './useCanAssignTasks';

/** Кнопка «Поставить задачу» + форма — для шапки карточки менеджера. Без права
 *  action.tasker.assign не рендерится. */
export function CreateTaskButton({ className, ...drawer }: Omit<CreateTaskDrawerProps, 'open' | 'onClose'> & { className?: string }) {
  const can = useCanAssignTasks();
  const [open, setOpen] = useState(false);
  if (!can) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-sm font-medium text-[var(--color-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${className ?? ''}`}>
        <ListPlus size={16} /> Поставить задачу
      </button>
      <CreateTaskDrawer open={open} onClose={() => setOpen(false)} {...drawer} />
    </>
  );
}
