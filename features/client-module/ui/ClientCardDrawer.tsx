'use client';
// Единая «Карточка клиента» в приложении (владелец 20.10: «две карточки — в одну»):
// та же ClientModuleWidget, что во вкладке Битрикса и в «Ещё → Модули», только панелью
// справа поверх текущей страницы. Сделки открываются карточкой сделки Монолитики.
// Заменяет карточку «Моих заказчиков» (CustomerCard) во всех местах.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { ClientModuleWidget } from './ClientModuleWidget';

// DealCard сам открывает карточку клиента — статический импорт дал бы цикл модулей.
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });

export function ClientCardDrawer({ contactId, companyId, onClose, zIndex }: {
  contactId?: string | number | null;
  companyId?: string | number | null;
  onClose: () => void;
  /** Поверх чего открылись: из карточки сделки (z-70) нужен z выше её. */
  zIndex?: number;
}) {
  const [mounted, setMounted] = useState(false);
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openDealId === null) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, openDealId]);
  if (!mounted) return null;

  const z = zIndex ?? 50;
  return createPortal(
    <div className="fixed inset-0 flex" style={{ zIndex: z }}>
      <div className="hidden min-w-[10%] flex-1 cursor-pointer bg-black/40 sm:block" onClick={onClose} />
      <div className="flex h-dvh w-full max-w-full shrink-0 flex-col overflow-hidden bg-[var(--color-bg)] shadow-2xl sm:w-[1100px] sm:max-w-[96vw]">
        <div className="flex shrink-0 justify-end px-2 pt-2">
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="tap-target flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
            <X size={18} />
          </button>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 sm:px-6">
          <ClientModuleWidget
            contactId={companyId ? undefined : contactId != null ? String(contactId) : undefined}
            companyId={companyId != null ? String(companyId) : undefined}
            onDealOpen={setOpenDealId}
          />
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} stackZ={z + 10} />}
    </div>,
    document.body,
  );
}
