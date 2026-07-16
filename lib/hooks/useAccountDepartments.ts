'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

// Выбор отделов — настройка АККАУНТА (users.selected_department_ids, миграция 102,
// задача Иосифа 15.07): выбрал отделы один раз — применяются во всех отчётах, у
// сохранённых отчётов их прежний departmentIds из конфига игнорируется. Паттерн —
// useUiMode: общий queryKey, оптимистичное обновление (отчёты перезапрашиваются
// сразу, PATCH уходит в фоне). `ready` — для гейта первого запроса отчёта, чтобы
// не мигать нефильтрованными данными, пока настройка не загрузилась.
export function useAccountDepartments() {
  const qc = useQueryClient();
  const { data } = useQuery<{ departmentIds: string[] }>({
    queryKey: ['account-departments'],
    queryFn: async () => {
      const res = await fetch('/api/me/departments');
      if (!res.ok) throw new Error('failed');
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  function setDepartmentIds(ids: string[]) {
    qc.setQueryData(['account-departments'], { departmentIds: ids });
    void fetch('/api/me/departments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departmentIds: ids }),
    }).catch(() => { /* сеть моргнула — состояние останется в кэше, применится при следующем сохранении */ });
  }

  return {
    departmentIds: data?.departmentIds ?? [],
    ready: data !== undefined,
    setDepartmentIds,
  };
}
