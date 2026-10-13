import { ClientCardTab } from './ClientCardTab';

// Вкладка «Карточка клиента» в карточке контакта/компании Битрикса (задача
// владельца 13.10). Вход — POST от Битрикса на /api/bitrix/app/client-card:
// там сотрудник и его право видеть клиента проверены, выдан пропуск виджета (w).
// Превью того же виджета для админов — «Ещё → Модули».
export const metadata = { title: 'Карточка клиента — Монолитика' };

export default async function Page({ searchParams }: { searchParams: Promise<{ contactId?: string; companyId?: string; w?: string }> }) {
  const sp = await searchParams;
  const contactId = /^\d{1,12}$/.test(sp.contactId ?? '') ? sp.contactId : undefined;
  const companyId = /^\d{1,12}$/.test(sp.companyId ?? '') ? sp.companyId : undefined;
  const token = typeof sp.w === 'string' && sp.w.length >= 20 && sp.w.length <= 100 ? sp.w : null;
  if ((!contactId && !companyId) || !token) {
    return (
      <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">
        Откройте вкладку «Карточка клиента» из карточки контакта или компании в Битриксе.
      </div>
    );
  }
  return <ClientCardTab contactId={contactId} companyId={companyId} token={token} />;
}
