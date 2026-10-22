import { NextRequest, NextResponse } from 'next/server';
import { getClient, issueTokens, redeemCode, rotateRefresh, verifyPkce, type TokenPair } from '@/lib/mcp/oauth';

// Token endpoint: authorization_code (+ PKCE) и refresh_token (с ротацией). Claude шлёт
// application/x-www-form-urlencoded; JSON тоже принимаем — для ручной отладки.
function err(error: string, description: string, status = 400) {
  return NextResponse.json({ error, error_description: description }, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
}

function ok(t: TokenPair) {
  return NextResponse.json({
    access_token: t.accessToken,
    token_type: 'Bearer',
    expires_in: t.expiresIn,
    refresh_token: t.refreshToken,
    ...(t.scope ? { scope: t.scope } : {}),
  }, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } });
}

async function readParams(req: NextRequest): Promise<Record<string, string>> {
  const type = req.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const j = await req.json().catch(() => ({})) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

export async function POST(req: NextRequest) {
  const p = await readParams(req);
  const clientId = p.client_id;
  if (!clientId) return err('invalid_client', 'client_id обязателен', 401);
  const client = await getClient(clientId);
  if (!client) return err('invalid_client', 'Клиент не зарегистрирован', 401);

  if (p.grant_type === 'authorization_code') {
    if (!p.code || !p.redirect_uri || !p.code_verifier) return err('invalid_request', 'code, redirect_uri и code_verifier обязательны');
    const redeemed = await redeemCode(p.code, clientId, p.redirect_uri);
    if (!redeemed) return err('invalid_grant', 'Код недействителен, просрочен или уже использован');
    if (!verifyPkce(p.code_verifier, redeemed.codeChallenge)) return err('invalid_grant', 'PKCE: code_verifier не совпал');
    return ok(await issueTokens(redeemed.userId, clientId, redeemed.scope));
  }

  if (p.grant_type === 'refresh_token') {
    if (!p.refresh_token) return err('invalid_request', 'refresh_token обязателен');
    const pair = await rotateRefresh(p.refresh_token, clientId);
    if (!pair) return err('invalid_grant', 'Refresh-токен недействителен — переподключите коннектор');
    return ok(pair);
  }

  return err('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
}
