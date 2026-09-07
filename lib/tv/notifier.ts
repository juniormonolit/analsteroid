// «Телевизоры» — realtime-канал (задача #5636). Один LISTEN-коннект на процесс,
// фан-аут по подписчикам (route.ts /api/tv/stream). Архитектура —
// owners-inbox/monolitika-tv-realtime-sales-design-20260907.html, раздел 6.
//
// ГРАБЛЯ: LISTEN нельзя вешать на Pool из lib/db/clients.ts (analyticsDb()) — пул
// отдаёт разные коннекты и рвёт простаивающие через idle-обработчик. Нужен
// отдельный долгоживущий pg.Client в прямое соединение на session-порт
// (SA_PG_PORT=5432 — уже не пуллер, см. .env.local), не через Supavisor/6543.

import { Client } from 'pg';

type Sub = (ev: unknown) => void;

const subs = new Set<Sub>();
let client: Client | null = null;
let retry = 0;
let connecting: Promise<void> | null = null;

function saConfig() {
  return {
    host: process.env.SA_PG_HOST ?? '127.0.0.1',
    port: Number(process.env.SA_PG_PORT ?? 5432),
    user: process.env.SA_PG_USER,
    password: process.env.SA_PG_PASSWORD,
    database: 'postgres',
    ssl: false as const,
    keepAlive: true, // чтобы NAT/файрвол не убил тихий коннект
  };
}

async function connect(): Promise<void> {
  const c = new Client(saConfig());
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
  c.on('error', (err) => {
    console.warn('[tv/notifier] connection error:', err.message);
    void reconnect();
  });
  c.on('end', () => {
    void reconnect();
  });
  await c.connect();
  await c.query('LISTEN sa_deals_changed');
  client = c;
  retry = 0;
  console.log('[tv/notifier] LISTEN sa_deals_changed — connected');
  // Коннект новый — картинка на экранах могла устареть за время реконнекта.
  subs.forEach((fn) => fn({ type: 'resync' }));
}

async function reconnect(): Promise<void> {
  if (client) {
    try {
      await client.end();
    } catch {
      /* уже мёртв */
    }
    client = null;
  }
  const delay = Math.min(30_000, 500 * 2 ** retry++); // экспонента до 30 c
  setTimeout(() => {
    connecting = connect().catch((err) => {
      console.warn('[tv/notifier] reconnect failed:', err instanceof Error ? err.message : err);
      connecting = null;
      void reconnect();
    });
  }, delay);
}

function ensureConnected(): void {
  if (client || connecting) return;
  connecting = connect().catch((err) => {
    console.warn('[tv/notifier] initial connect failed:', err instanceof Error ? err.message : err);
    connecting = null;
    void reconnect();
  });
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
