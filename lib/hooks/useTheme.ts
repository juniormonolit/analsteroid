'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Theme = 'classic' | 'light' | 'dark' | 'mono';
const STORAGE_KEY = 'theme';
// Порядок и НАЗВАНИЯ — формулировки владельца (04.08): классическая первая, она же
// значение по умолчанию; стеклянные — по желанию. «Синее стекло» — это прежняя dark
// (она тёмно-синяя, см. --bg-app в theme-dark.css), «Серое стекло» — прежняя mono.
// Значения в БД НЕ переименованы намеренно: 'light'/'dark'/'mono' уже лежат в
// users.theme у 33 пользователей и в CHECK-ограничении, переименование потребовало бы
// миграции данных без всякой пользы — меняется только подпись в интерфейсе.
export const THEME_ORDER: Theme[] = ['classic', 'light', 'dark', 'mono'];
export const THEME_LABEL: Record<Theme, string> = {
  classic: 'Классическая',
  light: 'Светлое стекло',
  dark: 'Синее стекло',
  mono: 'Серое стекло',
};
export const DEFAULT_THEME: Theme = 'classic';

// Тёмная тема (задача Николая, макет owners-inbox/analsteroid-dark-theme-mock.html),
// расширено до трёх тем (задача 2999, дизайн-система «Монолитика Glass» — light/dark/mono,
// mono сворачивает палитру графиков в серую, но статусы/тиры остаются цветными, см.
// tokens/theme-mono.css) и до ЧЕТЫРЁХ (04.08, решение владельца: редизайн выехал на прод
// как безальтернативный, вернули прежний плоский вид отдельной темой 'classic' —
// tokens/theme-classic.css — и сделали его дефолтом; стекло теперь опция).
// Механика: серверное состояние per-user (users.theme), общий queryKey ['theme'] — тот же
// паттерн, что useTableScale/useUiMode. Переключатель — в ProfilePage, рядом с
// «Масштаб таблиц».
//
// Анти-вспышка: инлайн-скрипт в app/layout.tsx применяет data-theme из зеркала
// localStorage.theme ДО первой отрисовки (страница логина в т.ч. — она не может
// дёрнуть /api/me/theme, т.к. неавторизована). Этот хук досинхронизирует зеркало с
// серверным значением ПОСЛЕ логина/загрузки (на случай другого устройства/сессии,
// где localStorage ещё пуст или устарел) и применяет его к <html> оптимистично при
// переключении в ЛК.
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  // data-theme ставится ЯВНО для всех значений (в т.ч. 'light') — раньше при
  // light атрибут просто снимался, т.к. :root-дефолты и так были светлыми; теперь
  // и 'mono', и 'classic' обязаны перекрыть те же токены, поэтому атрибут нужен
  // всегда одним и тем же способом (см. tokens/theme-light.css — есть и явный
  // [data-theme="light"] блок для симметрии).
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* приватный режим и т.п. — не критично */ }
}

export function useTheme() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const { data } = useQuery<{ theme: Theme }>({
    queryKey: ['theme'],
    queryFn: async () => {
      const res = await fetch('/api/me/theme');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 60_000,
  });

  const theme = data?.theme ?? DEFAULT_THEME;

  useEffect(() => {
    if (data?.theme) applyTheme(data.theme);
  }, [data?.theme]);

  async function setTheme(next: Theme) {
    qc.setQueryData(['theme'], { theme: next });
    applyTheme(next); // мгновенно — не ждём ответ сервера
    setError(null);
    // Статус ответа проверяем ОБЯЗАТЕЛЬНО. Живой инцидент 04.08: в БД лежало
    // CHECK (theme IN ('light','dark')) — миграция 145 на этот контур не накатилась,
    // PATCH падал 500, а пользователь видел лишь «мигнуло серым и откатилось»
    // (оптимистичный applyTheme красил, invalidate возвращал старое значение с
    // сервера, useEffect перекрашивал обратно). Молчаливый провал выглядит как баг
    // темы, а не как ошибка сохранения — поэтому теперь возвращаем текст ошибки в UI.
    let ok = false;
    try {
      const res = await fetch('/api/me/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
      ok = res.ok;
      if (!ok) setError(`Не удалось сохранить тему (${res.status}). Оформление вернётся к прежнему.`);
    } catch {
      setError('Не удалось сохранить тему: нет связи с сервером.');
    }
    qc.invalidateQueries({ queryKey: ['theme'] });
    return ok;
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  }

  return { theme, setTheme, cycleTheme, error };
}
