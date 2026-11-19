// Кто нажимает: права (canManageLogistKanban), очереди логиста, зона РОПа. Одна сборка на HTTP-запрос.
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm } from '@/lib/auth/perms';
import { systemDb } from '@/lib/db/clients';
import { ropScope } from '@/features/tv/engine/access';
import { scopeManagers } from '@/features/rop-kanban/engine/kanban';
import type { ActorInfo } from './contract';
import { mergeSettings } from './priority';
import { isQueueLogist } from './recipients';
import type { ActorCtx } from './status';

/** Настройки очередей и весов, видит всё, переназначает: супер-админ, «Администратор»,
 *  либо пофамильное право action.logist_kanban.manage («руководитель логистики»). */
export function canManageLogistKanban(s: SessionUser | null): boolean {
  if (!s) return false;
  return s.isSuperadmin || s.roleName === 'Администратор' || hasPerm(s, 'action.logist_kanban.manage');
}

export interface LogistActor extends ActorCtx { name: string; info: ActorInfo }

/** zone: true — посчитать зону РОПа (ropScope → менеджеры). Для действий без РОП-прав можно false. */
export async function buildActor(session: SessionUser, opts: { zone?: boolean } = {}): Promise<LogistActor> {
  const canManage = canManageLogistKanban(session);
  const me = session.bitrixUserId;
  const queueIds = new Set<number>(), leadQueueIds = new Set<number>();
  if (me) {
    // Логист очереди = участник проекта, прошедший правило по должности (recipients.ts, решение владельца 19.11):
    // CEO/COO/РОПы/разработчики/админ-аккаунты из проекта очередь как логисты не видят и запросы не берут.
    const [r, st] = await Promise.all([
      systemDb().query<{ queue_id: number; role: 'logist' | 'lead'; work_position: string | null }>(
        `SELECT m.queue_id, m.role, m.work_position FROM logist_queue_members m JOIN logist_queues q ON q.id = m.queue_id
          WHERE m.user_bitrix_id = $1 AND q.active`, [me]),
      systemDb().query<{ value: unknown }>(`SELECT value FROM logist_request_settings WHERE key = 'main'`),
    ]);
    const rule = mergeSettings(st.rows[0]?.value).notify;
    for (const x of r.rows) {
      if (!isQueueLogist({ bitrixId: me, workPosition: x.work_position, role: x.role }, rule)) continue;
      queueIds.add(Number(x.queue_id));
      if (x.role === 'lead') leadQueueIds.add(Number(x.queue_id));
    }
  }
  let zone: Set<string> | 'all' = new Set();
  if (opts.zone !== false && !canManage) {
    try {
      const scope = await ropScope(session);
      if (scope.full) zone = 'all';
      else if (!scope.selfOnly) {
        zone = new Set((await scopeManagers(scope)).map(m => m.id));
        if (me) zone.delete(me);
      }
    } catch (e) {
      console.warn('[logist-requests] зона РОПа недоступна:', e instanceof Error ? e.message : e);
    }
  }
  const name = session.displayName || session.login;
  const isRop = zone === 'all' || zone.size > 0;
  return {
    bitrixId: me, login: session.login, canManage, queueIds, leadQueueIds, zone, name,
    info: { bitrixId: me, name, canManage, isLogist: queueIds.size > 0, isRop, queueIds: [...queueIds] },
  };
}
