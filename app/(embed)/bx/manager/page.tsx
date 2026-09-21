import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getSession, SESSION_COOKIE } from '@/lib/auth/session';
import { EnterButton } from './EnterButton';

// Вход из локального приложения Битрикса (правка владельца 05.08: «в локальное
// приложение Битрикса надо выводить по сути /profile, сейчас там заглушка»).
//
// Раньше здесь жила ОТДЕЛЬНАЯ страница с одной карточкой менеджера. Пока ЛК был
// одной карточкой, это работало; после переезда кабинета на /profile с рельсой
// разделов внутри портала оставался огрызок: ссылки ведут на /profile/*, а CSP
// их фреймить не давал. Теперь портал имеет право фреймить /profile/* (см.
// next.config.ts), и этот адрес — просто вход. Сессию заводит /api/bitrix/app
// ДО этого редиректа.
export const metadata = { title: 'Мой кабинет — Монолитика' };

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const session = await getSession();
  if (session) redirect('/profile');

  // Сессии нет — это НЕ «не получилось войти». Обработчик /api/bitrix/app к
  // этому моменту человека уже опознал и сессию в БД завёл; не доехала только
  // cookie: браузер зарезал её как третьесторонюю внутри окна Битрикса
  // (инцидент 21.09 — Яндекс.Браузер, Safari, встроенный webview десктопного
  // Битрикс24; в Chrome Partitioned-cookie проходит). Поэтому вместо тупика
  // предлагаем одноразовую ссылку в обычную вкладку, где cookie своя.
  const { t } = await searchParams;
  const handoff = typeof t === 'string' && t.length > 20 ? t : null;

  // Диагностика инцидента: различаем «cookie не пришла вовсе» и «пришла, но
  // сессия не опознана» — это разные болезни, а по экрану они одинаковые.
  const h = await headers();
  const hadCookie = (h.get('cookie') ?? '').includes(`${SESSION_COOKIE}=`);
  console.warn('[bx/manager] нет сессии', {
    cookiePresent: hadCookie,
    handoff: !!handoff,
    ua: (h.get('user-agent') ?? '').slice(0, 120),
  });

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 p-6 text-center text-sm text-[var(--color-text-muted)]">
      <p className="text-base font-semibold text-[var(--color-text)]">Кабинет открывается в отдельной вкладке</p>
      {handoff ? (
        <>
          <p>
            Ваш браузер не разрешает вход внутри окна Битрикса — так устроена его защита
            от чужих cookie. Это не ошибка доступа: вы уже опознаны, нужен один клик.
          </p>
          <EnterButton href={`/api/bitrix/enter?t=${encodeURIComponent(handoff)}`}>Открыть кабинет</EnterButton>
          <p className="text-xs">
            Ссылка одноразовая и действует 10 минут. Если вкладка закрылась — вернитесь
            в этот раздел портала и нажмите кнопку ещё раз.
          </p>
        </>
      ) : (
        <>
          <p>
            Сессия не найдена. Откройте «Монолитику» из меню Битрикса заново — вход
            выдаётся при открытии приложения.
          </p>
          <a
            href="/login"
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11 inline-flex items-center rounded-xl border border-[var(--color-border)] px-5 py-2.5 text-sm font-semibold text-[var(--color-text)]"
          >
            Войти по логину
          </a>
        </>
      )}
    </div>
  );
}
