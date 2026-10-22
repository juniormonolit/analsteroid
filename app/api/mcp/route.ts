import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { loadSessionUserById } from '@/lib/auth/session';
import { canUseMcp, publicBaseUrl, userIdByAccessToken } from '@/lib/mcp/oauth';
import { registerTools, serverInstructions } from '@/lib/mcp/tools';

// MCP-сервер Монолитики (задача владельца 22.10): Streamable HTTP, без состояния — на каждый
// запрос свой McpServer с инструментами, привязанными к человеку из Bearer-токена. Сессий
// MCP не держим: Next standalone за nginx, долгие SSE-соединения здесь ни к чему.
//
// Без токена — 401 с WWW-Authenticate: по ссылке resource_metadata Claude находит наш OAuth
// (lib/mcp/oauth.ts) и запускает вход. Ответ 200 без токена Claude за приглашение войти не считает.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function unauthorized(description: string) {
  const meta = `${publicBaseUrl()}/.well-known/oauth-protected-resource/api/mcp`;
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${meta}", error="invalid_token"`,
    },
  });
}

async function handle(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return unauthorized('Нужен вход в Монолитику');
  const userId = await userIdByAccessToken(m[1].trim());
  if (!userId) return unauthorized('Токен недействителен или истёк');
  const session = await loadSessionUserById(userId);
  if (!session) return unauthorized('Пользователь отключён');
  // Право могли отобрать после подключения — проверяем на каждом запросе, не только при входе.
  if (!canUseMcp(session)) {
    return Response.json({ error: 'insufficient_scope', error_description: 'Нет права «Claude (MCP)»' }, { status: 403 });
  }

  const server = new McpServer(
    { name: 'monolitika', title: 'Монолитика', version: '1.0.0' },
    { instructions: serverInstructions(session) },
  );
  registerTools(server, session);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // Ответ уже собран (enableJsonResponse) — закрываем, чтобы не копить серверы в памяти.
    void transport.close();
    void server.close();
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
