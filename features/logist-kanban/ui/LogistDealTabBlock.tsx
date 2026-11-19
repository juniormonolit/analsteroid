'use client';
// Встройка вкладки «Запросы логисту» в карточку сделки Битрикса (владелец 19.11). Только супер-админ: placement.bind
// меняет интерфейс портала для всех сотрудников. По образцу BitrixTabBlock («Карточка клиента»).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface Status { hasToken: boolean; bound: boolean; handler?: string; hint?: string; error?: string }
const URL_ = '/api/admin/bitrix/logist-deal-tab';

export function LogistDealTabBlock() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Status>({
    queryKey: ['bitrix-logist-deal-tab'],
    queryFn: () => fetch(URL_).then(r => r.json()),
    refetchOnWindowFocus: false,
  });
  const call = useMutation({
    mutationFn: async (method: 'POST' | 'DELETE') => {
      const r = await fetch(URL_, { method });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['bitrix-logist-deal-tab'] }),
  });
  if (data && data.error === 'Forbidden') return null;
  const btn = 'min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm font-semibold disabled:opacity-40';

  return (
    <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[12.5px]">
      <div className="font-semibold">Вкладка «Запросы логисту» в сделке</div>
      <div className="mt-0.5 text-[var(--color-text-muted)]">
        Вкладка в карточке сделки Битрикса — для всех сотрудников: запросы логистам по сделке, варианты, чат и новый запрос с
        товарами сделки. Каждый видит только сделки, доступные ему в Битриксе, и запросы по правилам канбана.
      </div>
      <div className="mt-2">
        {isLoading ? 'Проверяем…'
          : !data?.hasToken ? <span className="text-[var(--color-text-muted)]">{data?.hint ?? 'Нет токена приложения.'}</span>
          : data.error ? <span className="text-[var(--color-negative)]">{data.error}</span>
          : <>Сейчас: {data.bound ? 'встроена' : 'не встроена'}</>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={`${btn} !border-transparent bg-[var(--color-accent)] text-white`} disabled={call.isPending || !data?.hasToken}
          onClick={() => call.mutate('POST')}>{data?.bound ? 'Привязать заново' : 'Встроить вкладку'}</button>
        {data?.bound && <button type="button" className={btn} disabled={call.isPending} onClick={() => call.mutate('DELETE')}>Убрать вкладку</button>}
      </div>
      {call.error && <div className="mt-1.5 text-[var(--color-negative)]">{(call.error as Error).message}</div>}
    </div>
  );
}
