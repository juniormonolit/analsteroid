'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Theme = 'light' | 'dark' | 'mono';
const STORAGE_KEY = 'theme';
export const THEME_ORDER: Theme[] = ['light', 'dark', 'mono'];
export const THEME_LABEL: Record<Theme, string> = { light: 'Светлая', dark: 'Тёмная', mono: 'Моно' };

// Тёмная тема (задача Николая, макет owners-inbox/analsteroid-dark-theme-mock.html),
// расширено до трёх тем (задача 2999, дизайн-система «Монолитика Glass» — light/dark/mono,
// mono сворачивает палитру графиков в серую, но статусы/тиры остаются цветными, см.
// tokens/theme-mono.css): серверное состояние per-user (users.theme), общий queryKey
// ['theme'] — тот же паттерн, что useTableScale/useUiMode. Переключатель — в ProfilePage,
// рядом с «Масштаб таблиц».
//
// Анти-вспышка: инлайн-скрипт в app/layout.tsx применяет data-theme из зеркала
// localStorage.theme ДО первой отрисовки (страница логина в т.ч. — она не может
// дёрнуть /api/me/theme, т.к. неавторизована). Этот хук досинхронизирует зеркало с
// серверным значением ПОСЛЕ логина/загрузки (на случай другого устройства/сессии,
// где localStorage ещё пуст или устарел) и применяет его к <html> оптимистично при
// переключении в ЛК.
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  // data-theme ставится ЯВНО для всех трёх значений (в т.ч. 'light') — раньше при
  // light атрибут просто снимался, т.к. :root-дефолты и так были светлыми; теперь
  // третье значение 'mono' обязано перекрыть те же токены, поэтому атрибут нужен
  // всегда одним и тем же способом (см. tokens/theme-light.css — есть и явный
  // [data-theme="light"] блок для симметрии).
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* приватный режим и т.п. — не критично */ }
}

export function useTheme() {
  const qc = useQueryClient();
  const { data } = useQuery<{ theme: Theme }>({
    queryKey: ['theme'],
    queryFn: async () => {
      const res = await fetch('/api/me/theme');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 60_000,
  });

  const theme = data?.theme ?? 'light';

  useEffect(() => {
    if (data?.theme) applyTheme(data.theme);
  }, [data?.theme]);

  async function setTheme(next: Theme) {
    qc.setQueryData(['theme'], { theme: next });
    applyTheme(next); // мгновенно — не ждём ответ сервера
    await fetch('/api/me/theme', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: next }),
    });
    qc.invalidateQueries({ queryKey: ['theme'] });
  }

  function cycleTheme() {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];
    setTheme(next);
  }

  return { theme, setTheme, cycleTheme };
}
