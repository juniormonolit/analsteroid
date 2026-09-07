import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { cacheVersion } from '@/lib/cache/redis';
import { departmentNameMap } from '@/features/tv/engine/access';
import { buildScreenFeed } from '@/features/tv/engine/feed';
import { rateLimited, tooMany } from '@/features/tv/engine/rateLimit';
import {
  ensurePairCode, getDeviceByToken, getScreen, getScreenByToken, touchDevice,
} from '@/features/tv/engine/store';
import type { TvFeed } from '@/features/tv/shared';

// Фид телевизора. Публично: ?d=<токен устройства> (обычный режим) или
// ?s=<публичный токен экрана> (прямая ссылка / превью). Данные экрана кэшируются
// в Redis 20 с (features/tv/engine/feed.ts). Лимит — 30 запросов/мин на IP:
// телевизор ходит раз в 15 с (в режиме привязки — раз в 5 с), плюс внеочередной
// запрос сразу после события /api/tv/stream (задача #5636) с ?fresh=1 — тот
// идёт мимо Redis-кэша прямым SQL, чтобы задержка «продажа → экран» не съедалась
// оставшимся TTL кэша.
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: TvFeed, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req);
  if (rateLimited(`tv:feed:${ip ?? 'na'}`, 30, 60)) return tooMany();
  const v = cacheVersion();
  const now = new Date().toISOString();
  const d = req.nextUrl.searchParams.get('d');
  const s = req.nextUrl.searchParams.get('s');
  // fresh=1 — сигнал от клиентского SSE-хука (задача #5636, sa_deals_changed):
  // «только что пришло событие, кэш 20 с сейчас точно устарел» — идём мимо него.
  const fresh = req.nextUrl.searchParams.get('fresh') === '1';

  try {
    if (s) {
      const screen = await getScreenByToken(s);
      if (!screen) return json({ state: 'unknown_screen', v, now }, 404);
      const names = await departmentNameMap();
      return json(await buildScreenFeed(screen, names, v, { bypassCache: fresh }));
    }
    if (d) {
      const device = await getDeviceByToken(d);
      if (!device) return json({ state: 'unknown_device', v, now }, 404);
      await touchDevice(device.id, ip);
      if (!device.screenId) {
        const { code, expiresInSec } = await ensurePairCode(device);
        return json({ state: 'pairing', v, now, code, expiresInSec });
      }
      const names = await departmentNameMap();
      const screen = await getScreen(device.screenId, names);
      if (!screen) return json({ state: 'unknown_screen', v, now }, 404);
      return json(await buildScreenFeed(screen, names, v, { bypassCache: fresh }));
    }
    return json({ state: 'error', v, now, message: 'Нет токена' }, 400);
  } catch (e) {
    console.error('[tv/feed]', e instanceof Error ? e.message : e);
    return json({ state: 'error', v, now, message: 'Ошибка сервера' }, 500);
  }
}
