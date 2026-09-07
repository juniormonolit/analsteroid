// «Телевизоры» — realtime SSE (задача #5636). Публично, как и /api/tv/feed:
// ТВ-браузер держит соединение без сессии. Данные в самом потоке НЕ передаются
// (payload служит только сигналом «что-то изменилось» — экран сам делает
// refetch /api/tv/feed?fresh=1), поэтому раскрывать наружу тут нечего.
//
// node runtime ОБЯЗАТЕЛЕН: edge-рантайм не умеет держать TCP-коннект к Postgres
// (у нас его держит lib/tv/notifier.ts на модульном уровне, отдельно от этого
// route.ts, который только подписывается).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

import { NextRequest } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { subscribe } from '@/lib/tv/notifier';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';

const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  // Долгоживущее соединение — лимит на ОТКРЫТИЯ, а не на трафик внутри: 10 новых
  // подключений в минуту с одного IP более чем достаточно (телевизор не переоткрывает
  // поток чаще реконнекта браузера).
  if (rateLimited(`tv:stream:${ip ?? 'na'}`, 10, 60)) return tooMany();

  const enc = new TextEncoder();
  let unsub: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(ctrl) {
      const send = (event: string, data: unknown) => {
        try {
          ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // контроллер уже закрыт (клиент отвалился между тиками) — молча игнорируем
        }
      };
      send('hello', { ts: Date.now() });
      unsub = subscribe((ev) => send('deal', ev));
      // heartbeat держит коннект живым сквозь nginx/proxy_read_timeout
      beat = setInterval(() => {
        try {
          ctrl.enqueue(enc.encode(': ping\n\n'));
        } catch {
          clearInterval(beat);
        }
      }, HEARTBEAT_MS);
      req.signal.addEventListener('abort', () => {
        clearInterval(beat);
        unsub();
        try {
          ctrl.close();
        } catch {
          /* уже закрыт */
        }
      });
    },
    cancel() {
      clearInterval(beat);
      unsub();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // без этого nginx буферизует SSE — поток «залипает»
    },
  });
}
