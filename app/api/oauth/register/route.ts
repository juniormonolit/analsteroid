import { NextRequest, NextResponse } from 'next/server';
import { isAllowedRedirect, registerClient } from '@/lib/mcp/oauth';

// DCR (RFC 7591): Claude регистрирует себя сам при добавлении коннектора. Регистрация без
// авторизации — так устроен протокол, поэтому адреса возврата закрыты списком
// (isAllowedRedirect): «клиент» с чужим redirect_uri не зарегистрируется.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (uris.length === 0 || uris.length > 10) {
    return NextResponse.json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris: 1..10' }, { status: 400 });
  }
  const bad = uris.find(u => !isAllowedRedirect(u));
  if (bad) {
    return NextResponse.json({ error: 'invalid_redirect_uri', error_description: `Адрес возврата не разрешён: ${bad}` }, { status: 400 });
  }
  const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 120) : null;
  const client = await registerClient(name, uris);
  return NextResponse.json({
    client_id: client.clientId,
    client_name: client.clientName ?? undefined,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, { status: 201 });
}
