'use client';
// Единая «Карточка клиента» в приложении (владелец 20.10: «две карточки — в одну»):
// та же ClientModuleWidget, что во вкладке Битрикса и в «Ещё → Модули», только панелью
// справа поверх текущей страницы. Сделки открываются карточкой сделки Монолитики.
// Заменяет карточку «Моих заказчиков» (CustomerCard) во всех местах.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import { Check, ChevronDown, Link2, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { ClientModuleWidget, type ClientCardTab } from './ClientModuleWidget';

// DealCard сам открывает карточку клиента — статический импорт дал бы цикл модулей.
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });

export function ClientCardDrawer({ contactId, companyId, onClose, zIndex, sideActions, sidePrimary, initialTab, onTabChange, shareUrl }: {
  /** Главное действие из раздела-источника (канбан) — в строке статуса шапки карточки. */
  sidePrimary?: ReactNode;
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
  const [kanbanOpen, setKanbanOpen] = useState(false);
  const copy = async () => {
    if (!shareUrl) return;
    const url = shareUrl();
    try { await navigator.clipboard.writeText(url); } catch { window.prompt('Скопируйте ссылку', url); return; }
    setCopied(true); setTimeout(() => setCopied(false), 1800);
  };
  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    // Открыто модальное окно поверх (окно задачи канбана из sideActions) — Esc закрывает только его.
    // Сама панель — тоже role=dialog (a11y, аудит 23.10): её из проверки исключаем.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && openDealId === null && !document.querySelector('[role="dialog"]:not([data-client-drawer])')) onClose(); };
    // capture на window — раньше, чем Radix (document, capture) закроет своё окно и уберёт его из DOM:
    // иначе проверка выше не видит открытого окна, и Esc закрывал заодно и карточку.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, openDealId]);
  if (!mounted) return null;

  const z = zIndex ?? 50;
  return createPortal(
    <div className="fixed inset-0 flex" style={{ zIndex: z }}>
      {/* Канбан-карточка слева — только где она читаема (аудит 23.10: на 1280 она была ~160 px, на планшете ~50 px);
          уже — кнопка «Канбан ▾» в шапке. */}
      <div className="relative hidden min-w-[10%] flex-1 cursor-pointer bg-black/40 sm:block" onClick={onClose}>
        {sideActions && (
          <div className="absolute right-3 top-3 hidden w-72 max-w-[calc(100%-24px)] cursor-default min-[94rem]:block" onClick={e => e.stopPropagation()}>{sideActions}</div>
        )}
      </div>
      <div role="dialog" aria-modal="true" aria-label="Карточка клиента" data-client-drawer
        className="relative flex h-dvh w-full max-w-full shrink-0 flex-col overflow-hidden bg-[var(--color-bg)] shadow-2xl sm:w-[1100px] sm:max-w-[96vw]">
        {/* Кнопки панели — поверх закреплённой шапки карточки (она оставляет им место справа). */}
        <div className="absolute right-2 top-1.5 z-30 flex items-center gap-1">
          {sideActions && (
            <span className="min-[94rem]:hidden">
              <Popover open={kanbanOpen} onOpenChange={setKanbanOpen} align="end" className="max-h-[75dvh] w-[320px] max-w-[calc(100vw-16px)] overflow-y-auto p-1"
                trigger={
                  <button type="button" title="Карточка канбана: задача, комментарий, действия"
                    className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-[12.5px] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                    Канбан <ChevronDown size={14} />
                  </button>
                }>
                {sideActions}
              </Popover>
            </span>
          )}
          {shareUrl && (
            <button type="button" onClick={copy} title="Скопировать ссылку на эту карточку с открытой вкладкой" aria-label="Скопировать ссылку"
              className="tap-target inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-[12.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
              {copied ? <Check size={15} className="text-[var(--color-positive,#2f9e44)]" /> : <Link2 size={15} />}<span className="hidden sm:inline">{copied ? 'Скопировано' : 'Ссылка'}</span>
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Закрыть"
            className="tap-target flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
            <X size={18} />
          </button>
        </div>
        <div data-card-scroll className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-1.5 sm:px-6">
          <ClientModuleWidget
            contactId={companyId ? undefined : contactId != null ? String(contactId) : undefined}
            companyId={companyId != null ? String(companyId) : undefined}
            onDealOpen={setOpenDealId}
            initialTab={initialTab}
            onTabChange={onTabChange}
            stickyHeader
            headerExtra={sidePrimary}
          />
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} stackZ={z + 10} />}
    </div>,
    document.body,
  );
}
