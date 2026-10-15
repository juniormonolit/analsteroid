'use client';
// Встройка модуля «Карточка клиента» вкладкой в карточки контакта, компании и сделки
// Битрикса (задача владельца 13.10). Только супер-админ: placement.bind меняет
// интерфейс портала для всех сотрудников.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Status { hasToken: boolean; bound: string[]; hint?: string; error?: string }
const LABEL: Record<string, string> = { CRM_CONTACT_DETAIL_TAB: 'контакт', CRM_COMPANY_DETAIL_TAB: 'компания', CRM_DEAL_DETAIL_TAB: 'сделка' };

export function BitrixTabBlock() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Status>({
    queryKey: ['bitrix-client-card-tab'],
    queryFn: () => fetch('/api/admin/bitrix/client-card-tab').then(r => r.json()),
    refetchOnWindowFocus: false,
  });
  const call = useMutation({
    mutationFn: async (method: 'POST' | 'DELETE') => {
      const r = await fetch('/api/admin/bitrix/client-card-tab', { method });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['bitrix-client-card-tab'] }),
  });
  if (data && 'error' in data && data.error === 'Forbidden') return null;
  const bound = data?.bound ?? [];
  const btn = 'min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-40';

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12.5px]">
      <div className="font-semibold">Вкладка в Битриксе</div>
      <div className="mt-0.5 text-[var(--color-text-muted)]">
        Вкладка «Карточка клиента» в карточках контакта, компании и сделки (там — клиент сделки) — для всех сотрудников. Каждый видит только тех клиентов,
        которые доступны ему в Битриксе.
      </div>
      <div className="mt-2">
        {isLoading ? 'Проверяем…'
          : !data?.hasToken ? <span className="text-[var(--color-text-muted)]">{data?.hint ?? 'Нет токена приложения.'}</span>
          : data.error ? <span style={{ color: 'var(--color-negative, #e03131)' }}>{data.error}</span>
          : <>Сейчас встроено: {bound.length ? bound.map(b => LABEL[b] ?? b).join(', ') : 'никуда'}</>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={`${btn} !border-transparent bg-[var(--color-accent)] text-white`} disabled={call.isPending || !data?.hasToken}
          onClick={() => call.mutate('POST')}>{bound.length === 3 ? 'Привязать заново' : bound.length > 0 ? 'Встроить во все карточки' : 'Встроить вкладку'}</button>
        {bound.length > 0 && <button type="button" className={btn} disabled={call.isPending} onClick={() => call.mutate('DELETE')}>Убрать вкладку</button>}
      </div>
      {call.error && <div className="mt-1.5" style={{ color: 'var(--color-negative, #e03131)' }}>{(call.error as Error).message}</div>}
    </div>
  );
}
