import crypto from 'crypto';
import { redisReady } from '@/lib/cache/redis';

// Одноразовый ключ передачи входа из iframe Битрикса в обычную вкладку
// (инцидент 21.09: «Сейчас у менеджеров не открывается»).
//
// Почему понадобилось. Вход в приложении сделан на cookie, которую ставит
// POST-обработчик: `SameSite=None; Secure; Partitioned`. В Chrome такая
// (CHIPS) переживает третьесторонний контекст, а в браузерах, которые режут
// третьесторонние cookie без поддержки CHIPS — Яндекс.Браузер, Safari,
// встроенный webview десктопного Битрикс24 — не переживает. Живой замер того
// дня: сессии в БД создаются (rop1 12:40, ropyl3 12:44, bx2050 12:45), то есть
// обработчик отрабатывает и человек аутентифицирован, но на следующем же GET
// /bx/manager cookie не приходит — и кабинет показывает «не удалось открыть».
//
// Решение — не воевать с браузером, а увести вход в ПЕРВОСТОРОННИЙ контекст:
// обработчик кладёт одноразовый ключ в Redis и отдаёт его странице, а та даёт
// кнопку «Открыть кабинет» в новой вкладке. На monolitika.mlt-it.com как на
// собственном сайте cookie обычная (Lax) и работает везде.
//
// Ключ: 256 бит, живёт 10 минут, сгорает при первом использовании — по силе
// это тот же вход, что и cookie, только одноразовый.

const TTL_SEC = 10 * 60;
const key = (token: string) => `bxapp:handoff:${token}`;

export async function mintHandoff(userId: string): Promise<string | null> {
  const r = await redisReady();
  if (!r) return null;                      // без Redis обходной путь просто не предлагаем
  const token = crypto.randomBytes(32).toString('base64url');
  try {
    await r.set(key(token), userId, 'EX', TTL_SEC);
    return token;
  } catch {
    return null;
  }
}

/** Возвращает userId и СРАЗУ удаляет ключ: второй раз по той же ссылке не войти. */
export async function consumeHandoff(token: string): Promise<string | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const r = await redisReady();
  if (!r) return null;
  try {
    const k = key(token);
    const userId = await r.get(k);
    if (!userId) return null;
    await r.del(k);
    return userId;
  } catch {
    return null;
  }
}
