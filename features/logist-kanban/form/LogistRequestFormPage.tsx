'use client';
// Страница /logist-requests/:id — точка входа по ссылке бота. Форма открывается сразу (Modal); после закрытия
// остаётся короткая карточка «открыть снова» — без навигации «назад», которой нет в PWA и iframe Битрикса,
// а прямой заход по ссылке истории не имеет вовсе.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL, type RequestDetails } from '../engine/requests/contract';
import { LogistRequestForm } from './LogistRequestForm';

export function LogistRequestFormPage({ requestId }: { requestId: number }) {
  const [open, setOpen] = useState(true);
  const req = useQuery<RequestDetails>({
    queryKey: ['logist-request', requestId, 'peek'],
    queryFn: async () => {
      const r = await fetch(`/api/logist-kanban/request/${requestId}?peek=1`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
      return j as RequestDetails;
    },
  });
  const r = req.data;
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-6">
        <h1 className="text-lg font-semibold">Запрос логисту №{requestId}</h1>
        {req.error && <p className="text-sm text-[var(--color-negative)]">{(req.error as Error).message}</p>}
        {r && (
          <div className="rounded-lg border border-[var(--color-border)] p-4 text-sm">
            <p className="font-medium">{REQUEST_TYPE_LABEL[r.type]} · {REQUEST_STATUS_LABEL[r.status]}</p>
            {r.deal && <p className="mt-1 break-words text-[var(--color-text-secondary)]">Сделка №{r.deal.id}{r.deal.title ? ` · ${r.deal.title}` : ''}</p>}
            <p className="mt-1 text-[var(--color-text-secondary)]">{r.itemsPreview || 'Позиций пока нет'}</p>
          </div>
        )}
        <button type="button" onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 self-start rounded-md bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:opacity-90">
          <Send size={15} aria-hidden /> {r?.status === 'draft' ? 'Заполнить и отправить' : 'Открыть форму'}
        </button>
      </div>
      <LogistRequestForm open={open} onOpenChange={setOpen} requestId={requestId} />
    </div>
  );
}
