// «Телевизоры» — realtime-канал (задача #5636). Один LISTEN-коннект на процесс,
// фан-аут по подписчикам (route.ts /api/tv/stream). Архитектура —
// owners-inbox/monolitika-tv-realtime-sales-design-20260907.html, раздел 6.
//
// ГРАБЛЯ: LISTEN нельзя вешать на Pool из lib/db/clients.ts (analyticsDb()) — пул
// отдаёт разные коннекты и рвёт простаивающие через idle-обработчик. Нужен
// отдельный долгоживущий pg.Client в прямое соединение на session-порт
// (SA_PG_PORT=5432 — уже не пуллер, см. .env.local), не через Supavisor/6543.

import { Client } from 'pg';
import { saConnectionConfig } from '@/lib/db/clients';

type Sub = (ev: unknown) => void;

const subs = new Set<Sub>();
let client: Client | null = null;
let retry = 0;
let connecting: Promise<void> | null = null;
// Единственная цепочка переподключения. 05.11 прод упал по OOM: неудачный коннект звал
// reconnect() из catch И из своих 'error'/'end', цепочки множились, а брошенные клиенты не
// закрывались — за двое суток ~270 тыс. попыток, кончились локальные порты (EADDRNOTAVAIL)
// и 2 ГБ кучи. Теперь: таймер один, события чужих (уже брошенных) клиентов игнорируются.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

async function connect(): Promise<void> {
  const c = new Client({ ...saConnectionConfig(), keepAlive: true }); // keepAlive — чтобы NAT не убил тихий коннект
  const drop = () => {
    if (client === c) client = null;
    c.removeAllListeners();
    c.on('error', () => {}); // поздние ошибки сокета брошенного клиента не должны ронять процесс
    c.end().catch(() => {});
  };
  c.on('notification', (msg) => {
    if (msg.channel !== 'sa_deals_changed' || !msg.payload) return;
    let ev: unknown;
    try {
      ev = JSON.parse(msg.payload);
    } catch {
      return;
    }
    subs.forEach((fn) => fn(ev));
  });
  // Обрыв живого коннекта. Ошибки во время connect() сюда тоже прилетают — их ловит
  // catch в startConnect, а не этот обработчик (client === c ещё не выставлен).
  const onLost = (err?: Error) => {
    if (client !== c) return;
    console.warn('[tv/notifier] connection lost:', err?.message ?? 'end');
    drop();
    scheduleReconnect();
  };
  c.on('error', onLost);
  c.on('end', () => onLost());
  try {
    await c.connect();
    await c.query('LISTEN sa_deals_changed');
  } catch (err) {
    drop();
    throw err;
  }
  client = c;
  retry = 0;
  console.log('[tv/notifier] LISTEN sa_deals_changed — connected');
  // Коннект новый — картинка на экранах могла устареть за время реконнекта.
  subs.forEach((fn) => fn({ type: 'resync' }));
}

function startConnect(): void {
  connecting = connect()
    .catch((err) => {
      console.warn('[tv/notifier] connect failed:', err instanceof Error ? err.message : err);
      scheduleReconnect();
    })
    .finally(() => {
      connecting = null;
    });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 500 * 2 ** retry++); // экспонента до 30 c
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!client && !connecting) startConnect();
  }, delay);
}

function ensureConnected(): void {
  if (client || connecting || reconnectTimer) return;
  startConnect();
}

/** Подписка на события sa.deals. Первый подписчик поднимает LISTEN-коннект. */
export function subscribe(fn: Sub): () => void {
  ensureConnected();
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Диагностика (не используется в проде, для ручной проверки при желании). */
export function notifierStatus() {
  return { connected: !!client, subscribers: subs.size, retry };
}
