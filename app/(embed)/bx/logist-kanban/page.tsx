import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { EnterButton } from '../manager/EnterButton';

// Вход в «Канбан логиста» из Битрикса (19.11, по образцу повторки). Сессию заводит /api/bitrix/app/logist-kanban
// ДО этого адреса; дальше — сама доска (/logist-kanban, CSP разрешает порталу её фреймить). Нет сессии — браузер
// зарезал cookie внутри окна Битрикса (Safari, Яндекс.Браузер, десктопный Битрикс24): одноразовый вход в обычной вкладке.
export const metadata = { title: 'Канбан логиста — Монолитика' };

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const session = await getSession();
  if (session) redirect('/logist-kanban');
  const { t } = await searchParams;
  const handoff = typeof t === 'string' && t.length > 20 ? t : null;
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--color-text-muted)]">
      <p className="text-base font-semibold text-[var(--color-text)]">Канбан открывается в отдельной вкладке</p>
      {handoff ? (
        <>
          <p>Ваш браузер не разрешает вход внутри окна Битрикса — так устроена его защита от чужих cookie. Вы уже опознаны, нужен один клик.</p>
          <EnterButton href={`/api/bitrix/enter?t=${encodeURIComponent(handoff)}&to=logist-kanban`}>Открыть канбан</EnterButton>
          <p className="text-xs">Ссылка одноразовая и действует 10 минут. Если вкладка закрылась — нажмите пункт меню в Битриксе ещё раз.</p>
        </>
      ) : (
        <>
          <p>Сессия не найдена. Откройте «Канбан логиста» из меню Битрикса заново — вход выдаётся при открытии.</p>
          <a href="/login" target="_blank" rel="noopener noreferrer"
            className="min-h-11 inline-flex items-center rounded-xl border border-[var(--color-border)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text)]">Войти по логину</a>
        </>
      )}
    </div>
  );
}
