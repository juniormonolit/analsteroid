'use client';
import { ClientCardDrawer } from '@/features/client-module/ui/ClientCardDrawer';
import type { ClientCardTab } from '@/features/client-module/ui/ClientModuleWidget';

// Открытие карточки клиента из произвольного места (карточка сделки, дрилл-даун
// отчёта, канбан повторных, диагностика) по сырому id из сделки.
//
// С 20.10 (владелец: «две карточки — в одну») это ЕДИНАЯ карточка клиента — та же,
// что во вкладке Битрикса (ClientModuleWidget), панелью справа. Прежний двухшаговый
// путь (resolve clientKey → строка списка «Моих заказчиков» → CustomerCard) снят:
// раздел «Мои заказчики» упраздняется, отметки «Отложить/Не звонить» не нужны.
// Доступ проверяет сервер модуля: владелец клиента (менеджер последней сделки) должен
// быть в срезе сессии (lib/auth/modulesAccess.ts canSessionSeeClientRef).
export function CustomerCardLoader({ contactId, companyId, onClose, zIndex, sideActions, initialTab, onTabChange, shareUrl }: {
  onTabChange?: (tab: ClientCardTab) => void;
  shareUrl?: () => string;
  /** С какой вкладки открыть карточку клиента. */
  initialTab?: ClientCardTab;
  contactId?: string | number | null;
  companyId?: string | number | null;
  onClose: () => void;
  /** Поверх чего открылись: из DealCard (z-70) нужен z повыше её. */
  zIndex?: number;
  /** Действия раздела, откуда открыли (канбан повторных) — рядом с карточкой, не внутри. */
  sideActions?: React.ReactNode;
}) {
  return <ClientCardDrawer contactId={contactId} companyId={companyId} onClose={onClose} zIndex={zIndex} sideActions={sideActions} initialTab={initialTab} onTabChange={onTabChange} shareUrl={shareUrl} />;
}
