import { NextRequest, NextResponse } from 'next/server';
import { getClientIp } from '@/lib/auth/pin';
import { cacheVersion } from '@/lib/cache/redis';
import { departmentNameMap } from '@/features/tv/engine/access';
import { buildScreenFeed } from '@/features/tv/engine/feed';
import { buildTvTree, nodeWithin } from '@/features/tv/engine/orgTree';
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
  // node — проваливание с телевизора в под-узел (карточка кликнута); только внутри
  // поддеревьев узлов экрана, иначе 403.
  const nodeParam = req.nextUrl.searchParams.get('node');
  const nodeFor = async (deptIds: string[]): Promise<string | null | Response> => {
    if (!nodeParam) return null;
    if (!/^[a-z0-9:-]{4,64}$/i.test(nodeParam)) return json({ state: 'error', v, now, message: 'Плохой узел' }, 400);
    const tree = await buildTvTree();
    if (!nodeWithin(tree, deptIds, nodeParam)) return json({ state: 'error', v, now, message: 'Узел вне экрана' }, 403);
    return nodeParam;
  };

  try {
    if (s) {
      const screen = await getScreenByToken(s);
      if (!screen) return json({ state: 'unknown_screen', v, now }, 404);
      const names = await departmentNameMap();
      const node = await nodeFor(screen.departmentIds);
      if (node instanceof Response) return node;
      return json(await buildScreenFeed(screen, names, v, { bypassCache: fresh, node }));
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
      const node = await nodeFor(screen.departmentIds);
      if (node instanceof Response) return node;
      return json(await buildScreenFeed(screen, names, v, { bypassCache: fresh, node }));
    }
    return json({ state: 'error', v, now, message: 'Нет токена' }, 400);
  } catch (e) {
    console.error('[tv/feed]', e instanceof Error ? e.message : e);
    return json({ state: 'error', v, now, message: 'Ошибка сервера' }, 500);
  }
}
