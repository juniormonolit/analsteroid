'use client';
import { useQuery } from '@tanstack/react-query';
import { CustomerCard } from './CustomerCard';
import type { ApiRow } from './shared';

// Открытие карточки заказчика ИЗ ПРОИЗВОЛЬНОГО места (карточка сделки, дрилл-даун
// отчёта — задача владельца 17.08 «из одного другое выгружать») по сырому id из
// сделки. Двухшагово:
//   1) /api/customers/resolve — правильный clientKey (юр-сделки живут под
//      'k<company_id>'/'x<contact_id>', не под 'c…' — единая формула clientKey.ts)
//      и менеджер-ВЛАДЕЛЕЦ клиента (по последней сделке, как attr в движке).
//      Живой баг первой версии: слали 'c<contact_id>' + менеджера кликнутой сделки —
//      «Заказчик не найден в списке этого менеджера»;
//   2) существующий деп-линк GET /api/customers?bitrixId=…&key=… (задача 2822) —
//      полный ApiRow из списка заказчиков владельца.
//
// Доступ проверяет сервер (canViewManager): чужому менеджеру вернётся 403 —
// показываем честный отказ. markControls пустые: снузы/«не звонить» — операции
// владельца списка заказчиков, не сквозной навигации.
export function CustomerCardLoader({ contactId, companyId, onClose, zIndex }: {
  contactId?: string | number | null;
  companyId?: string | number | null;
  onClose: () => void;
  /** Поверх чего открылись: из DealCard (z-70) нужен z повыше её. */
  zIndex?: number;
}) {
  const idKey = companyId ? `k:${companyId}` : `c:${contactId}`;
  const { data: resolved, isLoading: resolving, isError: resolveError } = useQuery<{ clientKey: string | null; managerId: string | null }>({
    queryKey: ['customer-resolve', idKey],
    queryFn: async () => {
      const qs = companyId ? `companyId=${companyId}` : `contactId=${contactId}`;
      const res = await fetch(`/api/customers/resolve?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const clientKey = resolved?.clientKey ?? null;
  const managerId = resolved?.managerId ?? null;
  const { data, isLoading, isError } = useQuery<{ row: ApiRow | null }>({
    queryKey: ['customer-row', clientKey, managerId],
    enabled: !!clientKey && !!managerId,
    queryFn: async () => {
      const res = await fetch(`/api/customers?bitrixId=${managerId}&key=${encodeURIComponent(clientKey!)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const busy = resolving || (!!clientKey && !!managerId && isLoading);
  const failed = resolveError || isError;
  const notFound = !busy && !failed && (!clientKey || !managerId || !data?.row);

  if (busy) {
    return (
      <div className="fixed inset-0 flex" style={{ zIndex: zIndex ?? 50 }}>
        <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40" onClick={onClose} />
        <div className="w-full sm:w-[720px] sm:max-w-[85vw] shrink-0 bg-[var(--color-bg)] flex items-center justify-center shadow-2xl">
          <div className="text-sm text-[var(--color-text-muted)]">Загрузка карточки заказчика…</div>
        </div>
      </div>
    );
  }
  if (failed || notFound) {
    return (
      <div className="fixed inset-0 flex" style={{ zIndex: zIndex ?? 50 }}>
        <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40" onClick={onClose} />
        <div className="w-full sm:w-[720px] sm:max-w-[85vw] shrink-0 bg-[var(--color-bg)] flex flex-col items-center justify-center gap-3 shadow-2xl p-6 text-center">
          <div className="text-sm text-[var(--color-text)]">
            {failed
              ? 'Карточка заказчика недоступна — нет доступа к заказчикам менеджера-владельца.'
              : 'У заказчика нет карточки: все его сделки — юрлица без привязанной компании в Битриксе (такие в списки заказчиков не попадают).'}
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
      row={data!.row!}
      managerId={managerId!}
      isSelf={false}
      onClose={onClose}
      markControls={null}
      zIndex={zIndex}
    />
  );
}
