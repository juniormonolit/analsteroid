import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { BrandLogo } from '@/components/ui/BrandLogo';
import {
  canUseMcp, createConsentRequest, getClient, isAllowedRedirect, redirectMatches,
} from '@/lib/mcp/oauth';

// Страница согласия OAuth для MCP-коннектора Claude (задача 22.10, lib/mcp/oauth.ts).
// Сюда Claude отправляет человека при подключении коннектора. Без сессии — на /login с
// возвратом сюда же; без права action.mcp — объяснение, кого просить; иначе кнопка
// «Разрешить». Кнопка шлёт только id запроса согласия (одноразовый, привязан к человеку),
// поэтому подделать нажатие с чужого сайта нельзя.
export const dynamic = 'force-dynamic';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="w-full max-w-sm bg-[var(--color-bg-surface)] rounded-xl shadow-lg p-6 sm:p-8">
        <h1 className="flex items-center justify-center gap-2.5 text-xl font-semibold text-[var(--color-text)] mb-5">
          <BrandLogo size={30} />
          Монолитика
        </h1>
        {children}
      </div>
    </div>
  );
}

function Problem({ text }: { text: string }) {
  return (
    <Shell>
      <p className="text-sm text-[var(--color-text)] leading-relaxed">{text}</p>
    </Shell>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const clientId = one(sp.client_id);
  const redirectUri = one(sp.redirect_uri);
  const codeChallenge = one(sp.code_challenge);

  // Пока redirect_uri не проверен, ошибки показываем здесь, а не редиректом: иначе
  // страница стала бы открытым редиректом на любой адрес.
  const client = clientId ? await getClient(clientId) : null;
  if (!client) return <Problem text="Неизвестное приложение. Удалите коннектор в Claude и добавьте его заново." />;
  if (!redirectUri || !isAllowedRedirect(redirectUri) || !redirectMatches(client.redirectUris, redirectUri)) {
    return <Problem text="Адрес возврата не совпадает с зарегистрированным. Удалите коннектор в Claude и добавьте его заново." />;
  }

  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const state = one(sp.state);
    if (state) u.searchParams.set('state', state);
    return u.toString();
  };
  if (one(sp.response_type) !== 'code') redirect(back({ error: 'unsupported_response_type' }));
  if (!codeChallenge || one(sp.code_challenge_method) !== 'S256') {
    redirect(back({ error: 'invalid_request', error_description: 'PKCE S256 обязателен' }));
  }

  const session = await getSession();
  if (!session) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) { const s = one(v); if (s) qs.set(k, s); }
    redirect(`/login?next=${encodeURIComponent(`/oauth/authorize?${qs.toString()}`)}`);
  }

  if (!canUseMcp(session)) {
    return (
      <Problem text={`${session.displayName}, подключение Claude к Монолитике пока открыто не всем. Попросите администратора выдать вашей роли право «Claude (MCP)» в «Настройки → Роли».`} />
    );
  }

  const requestId = await createConsentRequest(session.id, {
    clientId,
    redirectUri,
    codeChallenge,
    state: one(sp.state) || null,
    scope: one(sp.scope) || null,
    resource: one(sp.resource) || null,
  });

  return (
    <Shell>
      <p className="text-base text-[var(--color-text)] font-medium mb-2">
        Разрешить {client.clientName || 'Claude'} доступ к аналитике?
      </p>
      <p className="text-sm text-[var(--color-text-muted)] leading-relaxed mb-1">
        Вы — <span className="text-[var(--color-text)]">{session.displayName}</span>.
      </p>
      <ul className="text-sm text-[var(--color-text-muted)] leading-relaxed mb-5 list-disc pl-5 space-y-1">
        <li>Claude увидит те же показатели, что вы видите в Монолитике, — не больше.</li>
        <li>Только чтение: ничего не меняет и не пишет менеджерам.</li>
        <li>Контактов и звонков клиентов не получит.</li>
        <li>Отключить можно в Claude, удалив коннектор.</li>
      </ul>
      <form method="post" action="/api/oauth/approve" className="flex flex-col-reverse sm:flex-row gap-2">
        <input type="hidden" name="request_id" value={requestId} />
        <button
          type="submit" name="decision" value="deny"
          className="min-h-11 flex-1 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]"
        >
          Отмена
        </button>
        <button
          type="submit" name="decision" value="allow"
          className="min-h-11 flex-1 rounded-lg bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-[var(--color-text-inverse)] text-sm font-medium transition-colors"
        >
          Разрешить
        </button>
      </form>
    </Shell>
  );
}
