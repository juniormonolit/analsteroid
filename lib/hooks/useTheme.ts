'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'theme';

// Тёмная тема (задача Николая, макет owners-inbox/analsteroid-dark-theme-mock.html):
// серверное состояние per-user (users.theme), общий queryKey ['theme'] — тот же
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
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
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

  return { theme, setTheme };
}
