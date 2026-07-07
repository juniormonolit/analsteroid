import { InviteAcceptClient } from './InviteAcceptClient';

// Токен неизвестен на этапе сборки — без явного force-dynamic Next в проде
// пытается статически оптимизировать страницу и реальные токены не находят
// маршрут (404 → редирект в /login через (app)-layout).
export const dynamic = 'force-dynamic';

export default async function InviteAcceptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InviteAcceptClient token={token} />;
}
