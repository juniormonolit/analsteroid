'use client';
import { Modal } from './Modal';

interface Props {
  open: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Общий диалог «есть несохранённые изменения» (правка собрания 09.07/2, п.4) — при
 * ЛЮБОМ закрытии панели с несохранёнными изменениями (клик по затемнению, крестик
 * PanelCloseTab, Esc). Построен на золотом стандарте `<Modal>` (components/ui/Modal.tsx,
 * Radix Dialog) — тот же паттерн, что и остальные модалки приложения (SaveReportModal
 * и т.п.), а не самописный fixed-оверлей.
 *
 * Три действия (порядок владельца): «Сохранить» (primary, = кнопке «Сохранить» самой
 * панели) / «Не сохранять» (закрыть, отбросив изменения) / «Отмена» (остаться, диалог
 * закрывается, панель остаётся открытой).
 *
 * Подключение — через `useUnsavedGuard` (lib/hooks/useUnsavedGuard.ts): панель сама
 * решает, что считать «изменением» (это специфично — какие поля гейтятся Save, а
 * какие применяются мгновенно), хук и этот диалог — только общий механизм диалога.
 */
export function UnsavedChangesDialog({ open, onSave, onDiscard, onCancel }: Props) {
  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!v) onCancel(); }}
      title="Есть несохранённые изменения"
      desktopWidth="sm:max-w-sm"
    >
      <div className="text-sm text-[var(--color-text-muted)] mb-5">
        Изменения не сохранены. Сохранить их перед закрытием или закрыть без сохранения?
      </div>
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="px-4 py-2 text-sm font-medium text-[var(--color-negative)] hover:underline"
        >
          Не сохранять
        </button>
        <button
          type="button"
          onClick={onSave}
          className="px-5 py-2 text-sm font-semibold bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity"
        >
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
