import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { superadminError } from '@/lib/auth/perms';
import { getRedis } from '@/lib/cache/redis';
import { BX_STATS_PREFIX, bxStatsHour } from '@/lib/bitrix/notify';

// Наши запросы к Битриксу (счётчик в bx(), lib/bitrix/notify.ts; владелец 23.10: «дёргать как можно
// меньше»). По часам МСК за 48 ч и итог по методам за 24 ч: HTTP-вызовы, команды внутри batch, ошибки.
// Только супер-админ — рядом с логами сервера Битрикса.
export const dynamic = 'force-dynamic';

export async function GET() {
  const err = superadminError(await getSession());
  if (err) return err;
  const r = getRedis();
  if (!r) return NextResponse.json({ error: 'Redis недоступен — счётчик не ведётся' }, { status: 503 });
  const hours = Array.from({ length: 48 }, (_, i) => bxStatsHour(Date.now() - i * 3600_000));
  const raw = await Promise.all(hours.map(h => r.hgetall(`${BX_STATS_PREFIX}${h}`)));
  const byHour = hours.map((hour, i) => {
    const m = raw[i] ?? {};
    let calls = 0, cmds = 0, errs = 0;
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v) || 0;
      if (k.endsWith('#cmd')) cmds += n; else if (k.endsWith('#err')) errs += n; else calls += n;
    }
    return { hour, calls, cmds, errs };
  });
  const methods = new Map<string, { calls: number; cmds: number; errs: number }>();
  raw.slice(0, 24).forEach(m => {
    for (const [k, v] of Object.entries(m ?? {})) {
      const [name, kind] = k.split('#');
      const cur = methods.get(name) ?? { calls: 0, cmds: 0, errs: 0 };
      const n = Number(v) || 0;
      if (kind === 'cmd') cur.cmds += n; else if (kind === 'err') cur.errs += n; else cur.calls += n;
      methods.set(name, cur);
    }
  });
  return NextResponse.json({
    byHour,
    methods24h: [...methods].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.cmds - a.cmds),
  }, { headers: { 'Cache-Control': 'no-store' } });
}
