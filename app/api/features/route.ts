import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isFeatureEnabled } from '@/lib/featureFlags';

// Флаги фич, видимые клиенту (любая авторизованная сессия — не только супер-админ:
// таб/блок должен прятаться у ВСЕХ, менеджера и РОПа). Управление — только
// супер-админ, /api/settings/feature-flags.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const planyorka = await isFeatureEnabled('planyorka_enabled');
  return NextResponse.json({ planyorka });
}
