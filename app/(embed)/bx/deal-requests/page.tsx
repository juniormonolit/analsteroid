import { getSession } from '@/lib/auth/session';
import { DealRequestsTab } from '@/features/logist-kanban/ui/DealRequestsTab';
import { EnterButton } from '../manager/EnterButton';

// Вкладка «Запросы логисту» в карточке сделки Битрикса (владелец 19.11). Сессию заводит /api/bitrix/app/deal-requests
// ДО этого адреса (там же проверено, что сотрудник видит сделку). Нет сессии — браузер зарезал cookie внутри окна
// Битрикса (Safari, Яндекс.Браузер, десктопный Битрикс24): одноразовый вход в обычной вкладке, как у канбанов.
// ?mock=1 — превью вёрстки без входа и БД, только в dev-сборке.
export const metadata = { title: 'Запросы логисту — Монолитика' };

export default async function Page({ searchParams }: { searchParams: Promise<{ deal?: string; t?: string; mock?: string }> }) {
  const sp = await searchParams;
  const deal = /^\d{1,12}$/.test(sp.deal ?? '') ? Number(sp.deal) : null;
  if (!deal) {
    return <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">Откройте вкладку «Запросы логисту» в карточке сделки Битрикса.</p>;
  }
  if (sp.mock === '1' && process.env.NODE_ENV !== 'production') return <DealRequestsTab dealId={deal} mock />;
  const session = await getSession();
  if (session) return <DealRequestsTab dealId={deal} />;
  const handoff = typeof sp.t === 'string' && sp.t.length > 20 ? sp.t : null;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--color-text-muted)]">
      <p className="text-base font-semibold text-[var(--color-text)]">Запросы логисту открываются в отдельной вкладке</p>
      {handoff ? (
        <>
          <p>Ваш браузер не разрешает вход внутри окна Битрикса — так устроена его защита от чужих cookie. Вы уже опознаны, нужен один клик.</p>
          <EnterButton href={`/api/bitrix/enter?t=${encodeURIComponent(handoff)}&to=deal-requests&deal=${deal}`}>Открыть запросы по сделке</EnterButton>
          <p className="text-xs">Ссылка одноразовая и действует 10 минут. Если вкладка закрылась — переключитесь на вкладку «Запросы логисту» в сделке ещё раз.</p>
        </>
      ) : (
        <>
          <p>Сессия не найдена. Переключитесь на другую вкладку сделки и обратно — вход выдаётся при открытии.</p>
          <a href="/login" target="_blank" rel="noopener noreferrer"
            className="min-h-11 inline-flex items-center rounded-xl border border-[var(--color-border)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text)]">Войти по логину</a>
        </>
      )}
    </div>
  );
}
