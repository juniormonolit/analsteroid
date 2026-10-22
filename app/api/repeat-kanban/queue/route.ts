import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import { fetchQueue, managerDirectory, REMOVED_LABEL, inWorkHours } from '@/features/repeat-kanban/engine/queue';
import { fetchManagerLoad } from '@/features/repeat-kanban/engine/board';
import { fetchKanbanSettings } from '@/features/repeat-kanban/engine/settings';
import { getCachedClientNames } from '@/lib/bitrix/clientNames';
import { systemDb } from '@/lib/db/clients';

// Вкладка «Очередь» канбана повторных (миграция 237): по менеджерам — в работе / норма, в очереди,
// выдано сегодня, прогноз дней; позиции очереди с порядком (score) и недавно выданные/снятые.
// Зона — как у доски: РОП видит свою зону, полный доступ — всех.
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!hasPerm(session, 'section.repeat_kanban')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  try {
    const scope = await ropScope(session);
    const zoneIds = scope.full ? null : (await scopeManagers(scope)).map(m => m.id);
    const items = await fetchQueue(zoneIds, { includeDoneDays: 7 });
    const mgrIds = [...new Set(items.map(i => i.managerId))];
    const [settings, load, dir, names, today] = await Promise.all([
      fetchKanbanSettings(),
      fetchManagerLoad(mgrIds),
      managerDirectory(mgrIds),
      getCachedClientNames([...new Set(items.map(i => i.clientKey))]).catch(() => new Map<string, string | null>()),
      systemDb().query<{ m: string; n: string }>(
        `SELECT manager_id AS m, count(*)::text AS n FROM repeat_task_queue
          WHERE status = 'issued' AND issued_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow'
            AND manager_id = ANY($1::text[]) GROUP BY 1`, [mgrIds],
      ).then(r => new Map(r.rows.map(x => [x.m, Number(x.n)]))),
    ]);
    const managers = mgrIds.map(id => {
      const mine = items.filter(i => i.managerId === id);
      const queued = mine.filter(i => i.status === 'queued').length;
      return {
        id, name: dir.get(id)?.name ?? id, active: dir.get(id)?.active ?? false,
        load: load[id] ?? 0, queued, issuedToday: today.get(id) ?? 0,
        failed: mine.filter(i => i.status === 'failed').length,
        forecastDays: queued ? Math.ceil(queued / settings.queueDailyLimit) : 0,
      };
    }).sort((a, b) => b.queued - a.queued || a.name.localeCompare(b.name, 'ru'));
    // Позиция в очереди менеджера — по score (последний пересчёт джобом), без score — в конце по времени.
    const rank = new Map<number, number>();
    for (const m of managers) {
      items.filter(i => i.managerId === m.id && i.status === 'queued')
        .sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9) || a.createdAt.localeCompare(b.createdAt))
        .forEach((i, n) => rank.set(i.id, n + 1));
    }
    return NextResponse.json({
      settings: { managerTaskLimit: settings.managerTaskLimit, queueDailyLimit: settings.queueDailyLimit, workHoursNow: inWorkHours() },
      managers,
      items: items.map(i => ({
        ...i, clientName: names.get(i.clientKey) ?? null, managerName: dir.get(i.managerId)?.name ?? i.managerId,
        position: rank.get(i.id) ?? null, removedLabel: i.removedReason ? REMOVED_LABEL[i.removedReason] ?? i.removedReason : null,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[repeat-kanban queue]', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Не удалось собрать очередь' }, { status: 500 });
  }
}
