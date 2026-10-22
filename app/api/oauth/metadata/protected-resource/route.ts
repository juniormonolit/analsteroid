import { NextResponse } from 'next/server';
import { mcpResourceUrl, publicBaseUrl } from '@/lib/mcp/oauth';

// RFC 9728 — метаданные защищённого ресурса (/api/mcp). Сюда Claude приходит по ссылке из
// WWW-Authenticate ответа 401; отдаётся по /.well-known/oauth-protected-resource[/api/mcp]
// (rewrites в next.config.ts). resource — строго тот URL, что вставлен в коннектор.
export function GET() {
  return NextResponse.json({
    resource: mcpResourceUrl(),
    authorization_servers: [publicBaseUrl()],
    bearer_methods_supported: ['header'],
    resource_name: 'Монолитика',
  }, { headers: { 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' } });
}
