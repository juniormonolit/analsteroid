'use client';
// Единая «Карточка клиента» в приложении (владелец 20.10: «две карточки — в одну»):
// та же ClientModuleWidget, что во вкладке Битрикса и в «Ещё → Модули», только панелью
// справа поверх текущей страницы. Сделки открываются карточкой сделки Монолитики.
// Заменяет карточку «Моих заказчиков» (CustomerCard) во всех местах.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Check, Link2, X } from 'lucide-react';
import { ClientModuleWidget, type ClientCardTab } from './ClientModuleWidget';

// DealCard сам открывает карточку клиента — статический импорт дал бы цикл модулей.
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });

export function ClientCardDrawer({ contactId, companyId, onClose, zIndex, sideActions, initialTab, onTabChange, shareUrl }: {
  initialTab?: ClientCardTab;
  onTabChange?: (tab: ClientCardTab) => void;
  /** Ссылка на эту карточку с открытой вкладкой (канбан: адрес страницы) — кнопка «Скопировать ссылку». */
  shareUrl?: () => string;
  contactId?: string | number | null;
  companyId?: string | number | null;
  onClose: () => void;
  /** Поверх чего открылись: из карточки сделки (z-70) нужен z выше её. */
  zIndex?: number;
  /** Действия раздела, откуда открыли (канбан повторных, владелец 21.10: «кнопки — в карточке
   *  клиента, но только при работе через канбан; приклеить к слайду слева сверху, в карточку не
   *  вмешивать»). На компьютере — слева от панели сверху, на телефоне — полосой снизу. */
  sideActions?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!shareUrl) return;
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); } catch { window.prompt('Скопируйте ссылку', url); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    // Открыто модальное окно поверх (окно задачи канбана из sideActions) — Esc закрывает только его.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openDealId === null && !document.querySelector('[role="dialog"]')) onClose(); };
    // capture на window — раньше, чем Radix (document, capture) закроет своё окно и уберёт его из DOM:
    // иначе проверка выше не видит открытого окна, и Esc закрывал заодно и карточку.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, openDealId]);
  if (!mounted) return null;

  const z = zIndex ?? 50;
  return createPortal(
    <div className="fixed inset-0 flex" style={{ zIndex: z }}>
      <div className="relative hidden min-w-[10%] flex-1 cursor-pointer bg-black/40 sm:block" onClick={onClose}>
        {sideActions && (
          <div className="absolute right-3 top-3 w-72 max-w-[calc(100%-24px)] cursor-default" onClick={e => e.stopPropagation()}>{sideActions}</div>
        )}
      </div>
      <div className="flex h-dvh w-full max-w-full shrink-0 flex-col overflow-hidden bg-[var(--color-bg)] shadow-2xl sm:w-[1100px] sm:max-w-[96vw]">
        <div className="flex shrink-0 justify-end gap-1 px-2 pt-2">
          {shareUrl && (
            <button type="button" onClick={copy} title="Скопировать ссылку на эту карточку с открытой вкладкой"
              className="tap-target inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
              {copied ? <Check size={15} className="text-[#38761d]" /> : <Link2 size={15} />} {copied ? 'Скопировано' : 'Ссылка'}
            </button>
          )}
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
            initialTab={initialTab}
            onTabChange={onTabChange}
          />
        </div>
        {sideActions && <div className="shrink-0 border-t border-[var(--color-border)] p-2 sm:hidden">{sideActions}</div>}
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} stackZ={z + 10} />}
    </div>,
    document.body,
  );
}
