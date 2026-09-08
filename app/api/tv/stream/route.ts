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
      // Фильтр + склейка (правка 08.09 после замера на проде: триггер стреляет на
      // КАЖДОЕ изменение stage/amount/manager любой сделки компании, и каждый
      // телевизор шёл в базу мимо кэша ~40 раз/мин). Телевизору интересны только
      // продажа/бронь СЕГОДНЯ (sold_at/reserved_at за текущие сутки МСК) — остальное
      // отбрасываем; а частые события склеиваем в одно не чаще раза в 5 с на соединение.
      let pending: ReturnType<typeof setTimeout> | undefined;
      let lastSent = 0;
      const relevant = (ev: unknown): boolean => {
        if (!ev || typeof ev !== 'object') return true; // resync и прочие служебные
        const e = ev as { type?: string; sold_at?: string | null; reserved_at?: string | null };
        if (e.type === 'resync') return true;
        const dayStart = Date.now() - 36 * 3600 * 1000; // «сегодня» с запасом на пояс/задним числом
        const ts = (v?: string | null) => (v ? Date.parse(v) : NaN);
        return ts(e.sold_at) >= dayStart || ts(e.reserved_at) >= dayStart;
      };
      unsub = subscribe((ev) => {
        if (!relevant(ev)) return;
        if (pending) return;
        const wait = Math.max(0, 5000 - (Date.now() - lastSent));
        pending = setTimeout(() => { pending = undefined; lastSent = Date.now(); send('deal', { ts: lastSent }); }, wait);
      });
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
        if (pending) clearTimeout(pending);
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
