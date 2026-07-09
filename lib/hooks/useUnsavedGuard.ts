'use client';
import { useCallback, useRef, useState } from 'react';

/**
 * Единый гейт «есть несохранённые изменения» (правка собрания 09.07/2, п.4): при
 * ЛЮБОМ закрытии панели с явной кнопкой «Сохранить» (клик по затемнению, крестик
 * PanelCloseTab, Esc) — если есть несохранённые изменения, не закрывать панель
 * сразу, а поднять диалог (см. `components/ui/UnsavedChangesDialog.tsx`):
 * «Сохранить» / «Не сохранять» / «Отмена». Правило задокументировано в
 * `ai_docs/fresh_docs/DESIGN_GUIDELINES.md`, секция «Панели с сохранением».
 *
 * Панели, где изменения применяются МГНОВЕННО (нет отдельной кнопки «Сохранить»,
 * напр. `ReportSettingsPanel` — Фильтры/Вид применяются сразу) этот хук подключать
 * НЕ нужно: там нечего терять при закрытии — см. комментарий в самой панели.
 *
 * Хук не знает, ЧТО именно считается «изменением» — это специфично для каждой
 * панели (какие поля гейтятся Save, какие применяются мгновенно и уже сохранены).
 * Вызывающий компонент сам считает `isDirty` и передаёт его в `requestGuardedClose`
 * при каждой попытке закрытия.
 */
export function useUnsavedGuard() {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Отложенное реальное закрытие (обычно — requestClose из useSlideClose), которое
  // нужно выполнить, если пользователь подтвердит «Не сохранять» или «Сохранить».
  const pendingCloseRef = useRef<(() => void) | null>(null);

  /** Вызывать вместо прямого requestClose() на всех триггерах закрытия панели. */
  const requestGuardedClose = useCallback((isDirty: boolean, close: () => void) => {
    if (isDirty) {
      pendingCloseRef.current = close;
      setDialogOpen(true);
    } else {
      close();
    }
  }, []);

  /** «Не сохранять» — закрыть, отбросив изменения. */
  const confirmDiscard = useCallback(() => {
    setDialogOpen(false);
    const close = pendingCloseRef.current;
    pendingCloseRef.current = null;
    close?.();
  }, []);

  /** «Сохранить» — выполнить переданное сохранение панели, затем закрыть. */
  const confirmSave = useCallback((save: () => void) => {
    save();
    setDialogOpen(false);
    const close = pendingCloseRef.current;
    pendingCloseRef.current = null;
    close?.();
  }, []);

  /** «Отмена» — просто закрыть диалог, панель остаётся открытой. */
  const cancel = useCallback(() => {
    setDialogOpen(false);
    pendingCloseRef.current = null;
  }, []);

  return { dialogOpen, requestGuardedClose, confirmDiscard, confirmSave, cancel };
}
