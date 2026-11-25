// «Большой брат» — дисциплина задач по сотрудникам (продажи + логисты; BIG_BROTHER_SPEC.md, «Дисциплина задач»).
//
// Источник — sa.bitrix_task_current (копия Roan, лаг ≤ 5 мин). Ограничение копии: в ней только ТЕКУЩЕЕ состояние задачи,
// истории статусов нет. Поэтому:
//  - «вовремя / с опозданием» — по closed_at против deadline_at на момент чтения (если срок переносили, сравниваем
//    с последним сроком — перенос «спасает» опоздание);
//  - «без движения N дней» — открытая задача (не начата / в работе), у которой changed_at старше N дней (любое изменение
//    задачи, включая комментарий, считается движением);
//  - «возвращено» — ручные возвраты канбана повторки (repeat_kanban_events.task_returned) + переходы «ждёт контроля (4) →
//    открыта» из событий Битрикса sa.bitrix_task_payload_raw (ONTASKUPDATE, prev/task/changed — сверено на проде 25.11).
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadLogins, loadOrg, serviceGroups } from '../rop/sources';
import { periodBounds, type BbPeriod } from '../rop/period';
import type { DisciplineResponse, DisciplineRow, PersonKind, TaskScope } from './types';

export const STALE_DAYS_DEFAULT = 7;

interface BxReturn { rid: string; task_id: string; at: Date }

interface AggRow {
  rid: string; received: number; closed: number; on_time: number; late: number; no_deadline: number;
  open: number; overdue: number; stale: number; waiting: number;
}

const kindOf = (login: string | undefined): PersonKind => {
  const l = (login ?? '').toLowerCase();
  return l.startsWith('manager') ? 'sales' : l.startsWith('logist') ? 'logist' : 'other';
};

/**
 * managerIds — срез сессии (null — все). scope: all — все задачи сотрудника в Битриксе; services — только группы
 * трёх сервисов (Задачник, большие, повторка).
 */
export async function buildDiscipline(o: {
  period: BbPeriod; managerIds: string[] | null; scope: TaskScope; staleDays: number; now?: number;
}): Promise<DisciplineResponse> {
  const now = o.now ?? Date.now();
  const notes: string[] = [];
  const [org, logins, groups] = await Promise.all([loadOrg(), loadLogins(), serviceGroups()]);
  const allow = o.managerIds ? new Set(o.managerIds) : null;
  // Продажи + логисты (по логину Битрикса); без карты логинов — все из оргструктуры.
  const people = org.filter(p => (!allow || allow.has(p.id)) && (!logins.size || kindOf(logins.get(p.id)) !== 'other'));
  const ids = people.map(p => Number(p.id)).filter(Number.isFinite);
  const { fromIso, toExclIso } = periodBounds(o.period);
  const groupIds = [...(groups.tasker != null ? [groups.tasker] : []), ...groups.big, groups.repeat];
  const groupWhere = o.scope === 'services' ? 'AND group_id = ANY($5::int[])' : '';
  const staleBefore = new Date(now - o.staleDays * 86_400_000).toISOString();

  const params: unknown[] = [ids, fromIso, toExclIso, staleBefore];
  if (o.scope === 'services') params.push(groupIds);

  const [agg, repeatReturns, bxReturns] = await Promise.all([
    ids.length ? analyticsDb().query<AggRow>(
      `SELECT responsible_id::text AS rid,
              count(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz)::int AS received,
              count(*) FILTER (WHERE status = 5 AND closed_at >= $2::timestamptz AND closed_at < $3::timestamptz)::int AS closed,
              count(*) FILTER (WHERE status = 5 AND closed_at >= $2::timestamptz AND closed_at < $3::timestamptz
                                 AND deadline_at IS NOT NULL AND closed_at <= deadline_at)::int AS on_time,
              count(*) FILTER (WHERE status = 5 AND closed_at >= $2::timestamptz AND closed_at < $3::timestamptz
                                 AND deadline_at IS NOT NULL AND closed_at > deadline_at)::int AS late,
              count(*) FILTER (WHERE status = 5 AND closed_at >= $2::timestamptz AND closed_at < $3::timestamptz
                                 AND deadline_at IS NULL)::int AS no_deadline,
              count(*) FILTER (WHERE status IN (1, 2, 3, 6))::int AS open,
              count(*) FILTER (WHERE status IN (1, 2, 3, 6) AND deadline_at < now())::int AS overdue,
              count(*) FILTER (WHERE status IN (1, 2, 3) AND changed_at < $4::timestamptz)::int AS stale,
              count(*) FILTER (WHERE status = 4)::int AS waiting
         FROM sa.bitrix_task_current
        WHERE NOT is_deleted AND responsible_id = ANY($1::int[])
          AND (status IN (1, 2, 3, 4, 6) OR closed_at >= $2::timestamptz OR created_at >= $2::timestamptz)
          ${groupWhere}
        GROUP BY 1`, params,
    ).then(r => r.rows) : Promise.resolve([] as AggRow[]),
    systemDb().query<{ manager_id: string; task_id: string | null; ts: Date }>(
      `SELECT manager_id, task_id::text, ts FROM repeat_kanban_events
        WHERE event_type = 'task_returned' AND manager_id IS NOT NULL
          AND ts >= $1::timestamptz AND ts < $2::timestamptz`, [fromIso, toExclIso],
    ).then(r => r.rows).catch(() => [] as { manager_id: string; task_id: string | null; ts: Date }[]),
    // События Битрикса ONTASKUPDATE: prev — состояние до изменения, task — после (сверено на проде 25.11). STATUS «после»
    // бывает мета-статусом открытой задачи: −1 просрочена, −2 не просмотрена, −3 почти просрочена — это тоже «в работе».
    ids.length ? analyticsDb().query<BxReturn>(
      `SELECT t.responsible_id::text AS rid, p.task_id::text, p.received_at AS at
         FROM sa.bitrix_task_payload_raw p
         JOIN sa.bitrix_task_current t ON t.task_id = p.task_id
        WHERE p.received_at >= $2::timestamptz AND p.received_at < $3::timestamptz
          AND t.responsible_id = ANY($1::int[]) AND NOT t.is_deleted
          AND p.event = 'ONTASKUPDATE' AND (p.payload->'changed') ? 'STATUS'
          AND coalesce(p.payload#>>'{prev,REAL_STATUS}', p.payload#>>'{prev,STATUS}', p.payload#>>'{prev,status}') = '4'
          AND coalesce(p.payload#>>'{task,REAL_STATUS}', p.payload#>>'{task,STATUS}', p.payload#>>'{task,status}') IN ('1', '2', '3', '-1', '-2', '-3')
          ${o.scope === 'services' ? 'AND t.group_id = ANY($4::int[])' : ''}`, o.scope === 'services' ? [ids, fromIso, toExclIso, groupIds] : [ids, fromIso, toExclIso],
    ).then(r => ({ ok: true, rows: r.rows })).catch(e => {
      console.warn('[big-brother tasks] возвраты из событий Битрикса', e instanceof Error ? e.message : e);
      return { ok: false, rows: [] as BxReturn[] };
    }) : Promise.resolve({ ok: true, rows: [] as BxReturn[] }),
  ]);

  const aggBy = new Map(agg.map(r => [r.rid, r]));
  const returns = new Map<string, number>();
  for (const r of bxReturns.rows) returns.set(r.rid, (returns.get(r.rid) ?? 0) + 1);
  // Возврат из канбана повторки сам меняет статус в Битриксе (сверка 25.11: каждый task_returned виден как 4 → −1 в
  // событиях) — добавляем только те, у которых в событиях Битрикса нет перехода по той же задаче в пределах часа.
  const bxAt = new Map<string, number[]>();
  for (const r of bxReturns.rows) { const l = bxAt.get(r.task_id) ?? []; l.push(new Date(r.at).getTime()); bxAt.set(r.task_id, l); }
  for (const r of repeatReturns) {
    const t = new Date(r.ts).getTime();
    if (r.task_id && (bxAt.get(r.task_id) ?? []).some(x => Math.abs(x - t) < 3600_000)) continue;
    returns.set(r.manager_id, (returns.get(r.manager_id) ?? 0) + 1);
  }

  const rows: DisciplineRow[] = people.map(p => {
    const a = aggBy.get(p.id);
    const onTime = a?.on_time ?? 0, late = a?.late ?? 0;
    return {
      id: p.id, name: p.name, deptName: p.deptName, ropName: p.ropName, kind: kindOf(logins.get(p.id)),
      received: a?.received ?? 0, closed: a?.closed ?? 0, onTime, late, noDeadline: a?.no_deadline ?? 0,
      onTimePct: onTime + late ? onTime / (onTime + late) : null,
      open: a?.open ?? 0, overdue: a?.overdue ?? 0, stale: a?.stale ?? 0, waitingControl: a?.waiting ?? 0,
      returned: returns.get(p.id) ?? 0,
    };
  }).filter(r => r.received || r.closed || r.open || r.waitingControl || r.returned)
    .sort((a, b) => b.overdue - a.overdue || b.stale - a.stale || a.name.localeCompare(b.name, 'ru'));

  const sum = (k: keyof DisciplineRow) => rows.reduce((s, r) => s + (r[k] as number), 0);
  const tOn = sum('onTime'), tLate = sum('late');
  const total = {
    received: sum('received'), closed: sum('closed'), onTime: tOn, late: tLate, noDeadline: sum('noDeadline'),
    onTimePct: tOn + tLate ? tOn / (tOn + tLate) : null,
    open: sum('open'), overdue: sum('overdue'), stale: sum('stale'), waitingControl: sum('waitingControl'), returned: sum('returned'),
  };

  notes.push(
    'Истории статусов в копии Битрикса нет: «вовремя / с опозданием» — закрытие против последнего срока задачи (перенос срока снимает опоздание).',
    `«Без движения» — открытая задача без единого изменения (включая комментарии) дольше ${o.staleDays} дн.`,
    'Сотрудники без задач в периоде и без открытых задач не показаны. Состав — продажи и логисты по логину Битрикса.',
  );
  if (!bxReturns.ok) notes.push('Возвраты из событий Битрикса не прочитались — в «Возвращено» только канбан повторки.');
  return {
    period: o.period, scope: o.scope, staleDays: o.staleDays, generatedAt: new Date(now).toISOString(),
    rows, total, returnsFromBitrix: bxReturns.ok, notes,
  };
}
