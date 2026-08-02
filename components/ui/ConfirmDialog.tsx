'use client';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  title: string;
  /** Текст подтверждения — то, что раньше шло вторым аргументом в window.confirm(). */
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' — красная кнопка подтверждения (штраф/сторно/списание и т.п.). */
  tone?: 'default' | 'danger';
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Общий диалог подтверждения (задача 2764, замена `window.confirm`) — построен
 * на золотом стандарте `<Modal>`, тот же паттерн, что `UnsavedChangesDialog`
 * (components/ui/UnsavedChangesDialog.tsx): не самописный `window.confirm`
 * (нативный алерт браузера — не брендируется, не подчиняется теме, ломает
 * ощущение приложения на телефоне) и не самописный `fixed inset-0`.
 *
 * Использование — вместо `if (!window.confirm(text)) return;` внутри
 * мутации: собрать `text` как раньше, подержать его в состоянии
 * (`useState<string|null>`), открыть диалог, а саму мутацию запускать из
 * `onConfirm`. Пример — `RewardsTab`/`ShopTab`/`InventoryTab` в
 * `features/manager-card/ui/ManagerTabs.tsx`.
 */
export function ConfirmDialog({
  open, title, description, confirmLabel = 'Подтвердить', cancelLabel = 'Отмена',
  tone = 'default', pending = false, onConfirm, onCancel,
}: Props) {
  return (
    <Modal open={open} onOpenChange={(v) => { if (!v) onCancel(); }} title={title} desktopWidth="sm:max-w-sm">
      <div className="text-sm text-[var(--color-text)] whitespace-pre-line">{description}</div>
      <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={onConfirm}
          className={`px-5 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50 transition-opacity hover:opacity-90 ${
            tone === 'danger' ? 'bg-[var(--color-negative,#e03131)]' : 'bg-[var(--color-accent)]'
          }`}
        >
          {pending ? 'Подождите…' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
