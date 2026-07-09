'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type UiMode = 'basic' | 'pro';

// Тумблер «Про/Лайт» (п.3а спеки; переименование «Обычная»→«Лайт» — правка 09.07/2,
// п.1): серверное состояние per-user (users.ui_mode), общий queryKey ['ui-mode'] —
// используется и тумблером в ЛК (ProfilePage), и компактным тумблером в сайдбаре
// (AppShell), переключение в одном месте мгновенно видно в другом (общий кэш
// react-query в пределах QueryProvider).
export function useUiMode() {
  const qc = useQueryClient();
  const { data } = useQuery<{ uiMode: UiMode; isOverride: boolean }>({
    queryKey: ['ui-mode'],
    queryFn: async () => {
      const res = await fetch('/api/me/ui-mode');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 60_000,
  });

  async function setUiMode(mode: UiMode) {
    // Оптимистично обновляем кэш, чтобы тумблер(ы) и отчёты (тот же queryKey) не мигали
    qc.setQueryData(['ui-mode'], { uiMode: mode, isOverride: true });
    await fetch('/api/me/ui-mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiMode: mode }),
    });
    qc.invalidateQueries({ queryKey: ['ui-mode'] });
  }

  return { uiMode: data?.uiMode ?? 'pro', isOverride: data?.isOverride ?? false, setUiMode };
}
