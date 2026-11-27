'use client';
// Черновик формы, переживающий размонтирование и перезагрузку вкладки (ТЗ 26.11 «Канбан больших чеков», п.1:
// директор трижды за день терял текст задачи менеджеру). Причины пропажи были разные: шторку закрыли кликом
// мимо/Esc, переключились на связанную задачу (форма размонтировалась) и — главное — вкладку перезагрузил service
// worker после выкатки (ServiceWorkerRegister: controllerchange → reload, срабатывает, когда приложение открывают
// в другой вкладке) или браузер выгрузил фоновую вкладку. Поэтому храним в localStorage, а не в sessionStorage:
// standalone-PWA на iOS, выгруженное из памяти, sessionStorage теряет. Срок жизни — DRAFT_TTL_MS.
//
// Только для компонентов, которые не рендерятся на сервере (портал после mount, dynamic ssr:false): начальное
// значение читается из хранилища сразу, без эффекта, — иначе форма мигнула бы пустой.
// Хранилище может быть недоступно (приватный режим, iframe Битрикса с запретом) — тогда это обычный useState.
import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'draft:';
export const DRAFT_TTL_MS = 3 * 86_400_000;

type Stored<T> = { v: T; at: number };

export function readDraft<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored<T>;
    if (!s || typeof s.at !== 'number' || Date.now() - s.at > DRAFT_TTL_MS) {
      window.localStorage.removeItem(PREFIX + key);
      return null;
    }
    return s.v;
  } catch { return null; }
}

function writeDraft<T>(key: string, v: T | null) {
  try {
    if (v === null) window.localStorage.removeItem(PREFIX + key);
    else window.localStorage.setItem(PREFIX + key, JSON.stringify({ v, at: Date.now() } satisfies Stored<T>));
  } catch { /* квота/запрет — черновик просто живёт в памяти */ }
}

/** Есть ли сохранённый черновик (для пометки «черновик» на кнопке). */
export const hasDraft = (key: string) => readDraft(key) !== null;

/**
 * Состояние формы с автосохранением. `isEmpty(value)` — черновик пуст: ключ удаляется (после отправки форма
 * сбрасывает поля — черновик исчезает сам). `clear()` — явный сброс к `initial`.
 */
export function useStoredDraft<T extends object>(key: string, initial: T, isEmpty: (v: T) => boolean) {
  const [value, setValue] = useState<T>(() => (typeof window === 'undefined' ? initial : { ...initial, ...(readDraft<T>(key) ?? {}) }));
  const empty = useRef(isEmpty);
  empty.current = isEmpty;
  const skipFirst = useRef(true);
  useEffect(() => {
    // Первый проход — значение только что прочитано из хранилища: не продлевать ему срок жизни.
    if (skipFirst.current) { skipFirst.current = false; return; }
    const t = setTimeout(() => writeDraft(key, empty.current(value) ? null : value), 300);
    return () => clearTimeout(t);
  }, [key, value]);
  // Уход со страницы/перезагрузка в пределах 300 мс после ввода — дописать сразу.
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const flush = () => writeDraft(key, empty.current(latest.current) ? null : latest.current);
    const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', onHide); flush(); };
  }, [key]);
  const clear = useCallback(() => { setValue(initial); writeDraft(key, null); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue, clear] as const;
}
