'use client';
import { ClientCardDrawer } from '@/features/client-module/ui/ClientCardDrawer';

// Открытие карточки клиента из произвольного места (карточка сделки, дрилл-даун
// отчёта, канбан повторных, диагностика) по сырому id из сделки.
//
// С 20.10 (владелец: «две карточки — в одну») это ЕДИНАЯ карточка клиента — та же,
// что во вкладке Битрикса (ClientModuleWidget), панелью справа. Прежний двухшаговый
// путь (resolve clientKey → строка списка «Моих заказчиков» → CustomerCard) снят:
// раздел «Мои заказчики» упраздняется, отметки «Отложить/Не звонить» не нужны.
// Доступ проверяет сервер модуля: владелец клиента (менеджер последней сделки) должен
// быть в срезе сессии (lib/auth/modulesAccess.ts canSessionSeeClientRef).
export function CustomerCardLoader({ contactId, companyId, onClose, zIndex }: {
  contactId?: string | number | null;
  companyId?: string | number | null;
  onClose: () => void;
  /** Поверх чего открылись: из DealCard (z-70) нужен z повыше её. */
  zIndex?: number;
}) {
  return <ClientCardDrawer contactId={contactId} companyId={companyId} onClose={onClose} zIndex={zIndex} />;
}
