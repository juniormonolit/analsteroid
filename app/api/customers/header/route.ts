import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { canViewManager } from '@/lib/org/managerAccess';
import { fetchRepeatHeader, type RepeatHeader, type RepeatMonth } from '@/features/customers/engine/repeatHeader';
import { fetchTeamRoster } from '@/features/customers/engine/team';

// Шапка «Моих заказчиков»: метрики менеджера по повторным продажам за месяц с
// трендом к прошлому (17.09). Доступ — как у списка.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  if (url.searchParams.get('team') === '1') {
    // Командный вид (17.09): сумма по менеджерам подконтрольных отделов, проценты — от сумм.
    const roster = await fetchTeamRoster(session);
    const mgr = url.searchParams.get('mgr');
    const subset = mgr && /^\d+$/.test(mgr) ? roster.filter(m => m.id === mgr) : roster;
    const parts: RepeatHeader[] = [];
    for (let i = 0; i < subset.length; i += 4) {
      parts.push(...await Promise.all(subset.slice(i, i + 4).map(m => fetchRepeatHeader(Number(m.id)))));
    }
    const sum = (pick: (h: RepeatHeader) => RepeatMonth): RepeatMonth => {
      const ms = parts.map(pick);
      const n = (f: (m: RepeatMonth) => number) => ms.reduce((a, m) => a + f(m), 0);
      const pct = (x: number, y: number) => (y > 0 ? Math.round((x / y) * 1000) / 10 : null);
      const medians = ms.map(m => m.callDayMedian).filter((v): v is number => v !== null).sort((a, b) => a - b);
      return {
        from: ms[0]?.from ?? '', to: ms[0]?.to ?? '',
        deliveries: n(m => m.deliveries), windowsClosed: n(m => m.windowsClosed), covered: n(m => m.covered),
        coveragePct: pct(n(m => m.covered), n(m => m.windowsClosed)),
        autoDeals: n(m => m.autoDeals), autoSold: n(m => m.autoSold), autoLost: n(m => m.autoLost),
        autoLostNoCall: n(m => m.autoLostNoCall), autoLost5min: n(m => m.autoLost5min),
        ppoCrPct: pct(n(m => m.autoSold), n(m => m.autoDeals)), dumpedPct: pct(n(m => m.autoLostNoCall), n(m => m.autoDeals)),
        soldSum: n(m => m.soldSum), repeatSoldSum: n(m => m.repeatSoldSum), repeatSharePct: pct(n(m => m.repeatSoldSum), n(m => m.soldSum)),
        callDayMedian: medians.length ? medians[Math.floor(medians.length / 2)] : null,
      };
    };
    return NextResponse.json({ current: sum(h => h.current), previous: sum(h => h.previous) });
  }
  const requested = url.searchParams.get('bitrixId');
  const bitrixId = requested && /^\d+$/.test(requested) ? requested : session.bitrixUserId;
  if (!bitrixId) return NextResponse.json({ error: 'Аккаунт не привязан к менеджеру Битрикса' }, { status: 400 });
  if (bitrixId !== session.bitrixUserId && !(await canViewManager(session, bitrixId))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(await fetchRepeatHeader(Number(bitrixId)));
}
