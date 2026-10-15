'use client';
import { setWidgetToken } from '@/lib/client/apiFetch';
import { ClientModuleWidget } from '@/features/client-module/ui/ClientModuleWidget';

// Пропуск ставим синхронно при рендере (до первого запроса react-query), а не в
// useEffect — иначе первый запрос карточки ушёл бы без него и получил 403.
export function ClientCardTab({ contactId, companyId, token }: { contactId?: string; companyId?: string; token: string }) {
  setWidgetToken(token);
  return (
    <div className="w-full px-3 py-3 sm:px-5">
      <ClientModuleWidget contactId={contactId} companyId={companyId} />
    </div>
  );
}
