import { NextResponse } from 'next/server';
import { publicBaseUrl } from '@/lib/mcp/oauth';

// RFC 8414 — метаданные сервера авторизации (Монолитика сама себе AS, lib/mcp/oauth.ts).
// Регистрация клиента — DCR (registration_endpoint); PKCE только S256; клиент публичный
// (token_endpoint_auth_method none) — секретов у Claude-клиента нет.
export function GET() {
  const base = publicBaseUrl();
  return NextResponse.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/api/oauth/token`,
    registration_endpoint: `${base}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['analytics'],
  }, { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
}
