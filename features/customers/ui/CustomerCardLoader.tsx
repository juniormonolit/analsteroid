'use client';
import { useQuery } from '@tanstack/react-query';
import { CustomerCard } from './CustomerCard';
import type { ApiRow } from './shared';

// Открытие карточки заказчика ИЗ ПРОИЗВОЛЬНОГО места (карточка сделки, дрилл-даун
// отчёта — задача владельца 17.08 «из одного другое выгружать»), где полного ApiRow
// нет — только clientKey и менеджер. Строку добирает существующий деп-линк
// GET /api/customers?bitrixId=…&key=… (задача 2822, кликабельные имена в дайджесте):
// он ищет клиента в ПОЛНОМ списке заказчиков менеджера, минуя фильтры вкладок.
//
// managerId — чьими глазами открываем (обычно текущий менеджер сделки): доступ
// проверяет сервер (canViewManager), чужому менеджеру вернётся 403 — показываем
// честный отказ, а не пустую карточку.
//
// markControls здесь пустой: «Отложить»/«Не звонить» — операции владельца списка
// заказчиков, из карточки сделки/дрилла они не нужны (и не всегда позволены).
export function CustomerCardLoader({ clientKey, managerId, onClose, zIndex }: {
  clientKey: string;
  managerId: string;
  onClose: () => void;
  /** Поверх чего открылись: из DealCard (z-70) нужен z повыше её. */
  zIndex?: number;
}) {
  const { data, isLoading, isError } = useQuery<{ row: ApiRow | null }>({
    queryKey: ['customer-row', clientKey, managerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers?bitrixId=${managerId}&key=${encodeURIComponent(clientKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex" style={{ zIndex: zIndex ?? 50 }}>
        <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40" onClick={onClose} />
        <div className="w-full sm:w-[720px] sm:max-w-[85vw] shrink-0 bg-[var(--color-bg)] flex items-center justify-center shadow-2xl">
          <div className="text-sm text-[var(--color-text-muted)]">Загрузка карточки заказчика…</div>
        </div>
      </div>
    );
  }
  if (isError || !data?.row) {
    return (
      <div className="fixed inset-0 flex" style={{ zIndex: zIndex ?? 50 }}>
        <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40" onClick={onClose} />
        <div className="w-full sm:w-[720px] sm:max-w-[85vw] shrink-0 bg-[var(--color-bg)] flex flex-col items-center justify-center gap-3 shadow-2xl p-6 text-center">
          <div className="text-sm text-[var(--color-text)]">
            {isError
              ? 'Карточка заказчика недоступна — нет доступа к заказчикам этого менеджера.'
              : 'Заказчик не найден в списке этого менеджера.'}
          </div>
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <CustomerCard
      row={data.row}
      managerId={managerId}
      isSelf={false}
      onClose={onClose}
      markControls={null}
      zIndex={zIndex}
    />
  );
}
