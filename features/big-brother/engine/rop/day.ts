// «Большой брат» → «День РОПа» (собрание 26.11, ТЗ tz/2026-11-26_big-brother.md, п. 1): что руководитель сделал за день —
// списком событий по времени, каждое со ссылкой на объект. Вторых источников нет — те же данные, что рейтинг и «Люди»:
//  - поставил — loadRopTasks (sources.ts: Задачник / канбан повторки / прямо в Битриксе в группах трёх сервисов, склейка
//    и правило «задачу канбана засчитываем нажавшему» — оттуда же); название, сделка и группа — sa.bitrix_task_current,
//    тип «Теория»/«Практика»/«Сделка» и тема — tasker_tasks;
//  - закрыл / проверил — sa.bitrix_task_current.closed_by (как task.close в activity_daily); «проверил» — закрыл задачу,
//    которую ставил сам, а исполнитель другой; приёмки и возвраты канбана повторки — repeat_kanban_events, канбана больших —
//    activity_events (mono_action section big_deals, entity_id = задача Битрикса). Закрытие той же задачи, уже видное в
//    канбане, второй раз не показывается;
//  - разборы — tasker_sessions (rop_bitrix_id, слот в дне) с менеджерами из задач сессии + «Практики» один на один (задача
//    без сессии со слотом в дне, поставил этот человек);
//  - звонки — va.calls (failed_at_stage IS NULL, #10823), одна строка: всего, дозвон > 20 с, минуты;
//  - прочие действия в канбанах повторки и больших — те же журналы.
// Сбой источника не роняет ответ: имя попадает в failed, остальное показывается.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { bitrixTaskUrl, portalBaseUrl } from '@/features/tasker/engine/config';
import { REPEAT_PROJECT_GROUP_ID } from '@/features/repeat-kanban/engine/config';
import { loadMonitoredPeople } from '../daily/people';
import { ROLE_LABEL } from '../daily/types';
import { dayBounds } from '../daily/time';
import { loadRopTasks, loadTeams, REPEAT_ACCEPT_EVENTS, REPEAT_CREATE_EVENTS } from './sources';
import { SERVICE_LABEL, type RopDayItem, type RopDayPerson, type RopDayResponse, type RopDaySummary, type RopService } from './types';

const zero = (): RopDaySummary => ({
  set: 0, training: 0, done: 0, accepted: 0, returned: 0, meetings: 0, meetingMin: 0, kanban: 0, calls: 0, callsReached: 0, callMin: 0,
});

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const dealUrl = (id: number | string) => `${portalBaseUrl()}/crm/deal/details/${id}/`;
const personDayUrl = (id: string, date: string) => `/big-brother/people?id=${id}&date=${date}`;

const KANBAN_LABEL: Record<string, string> = {
  task_rescheduled: 'перенёс срок задачи', task_comment_posted: 'комментарий к задаче', queue_added: 'добавил клиента в очередь',
  queue_removed: 'убрал клиента из очереди', manager_reassigned: 'переназначил менеджера', reject_reviewed: 'разобрал отказ',
  rejected_direct: 'отказ', hidden: 'скрыл карточку',
};
const BIG_OP_LABEL: Record<string, string> = {
  move: 'перенёс карточку', reassign: 'назначил исполнителя', participants: 'изменил участников', comment: 'комментарий',
  related_comment: 'комментарий', deadline: 'перенёс срок', renew: 'продлил задачу', note: 'заметка к карточке', mass_close: 'массово закрыл',
  accept: 'принял', approve: 'утвердил', complete: 'завершил', return: 'вернул на доработку',
};
const BIG_ACCEPT_OPS = new Set(['accept', 'approve', 'complete']);

async function safe<T>(name: string, failed: string[], fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    failed.push(name);
    if ((e as { code?: string })?.code !== '42P01') console.warn(`[big-brother rop/day] ${name}:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

interface BxInfo { title: string | null; deal_id: string | null; group_id: number | null; responsible_id: string | null; responsible_name: string | null }

/**
 * День руководителей ids (все — для списка; detailId — с событиями). Дата МСК.
 */
export async function buildRopDay(date: string, detailId: string | null, now = Date.now()): Promise<RopDayResponse> {
  const failed: string[] = [];
  const { from, to } = dayBounds(date, now);
  const fromIso = from.toISOString(), toIso = to.toISOString();

  const [teamsData, people] = await Promise.all([
    loadTeams(),
    loadMonitoredPeople().catch(() => []),
  ]);
  const { byId, teams } = teamsData;
  // Руководители: РОПы с командой + все РОПы / директора мониторинга; выбранный по ?id= — даже если не руководитель.
  const roleOf = new Map<string, string>();
  for (const p of people) if (p.role === 'rop' || p.role === 'director') roleOf.set(p.id, ROLE_LABEL[p.role]);
  for (const id of teams.keys()) if (!roleOf.has(id)) roleOf.set(id, ROLE_LABEL.rop);
  if (detailId && !roleOf.has(detailId)) {
    const p = people.find(x => x.id === detailId);
    roleOf.set(detailId, p ? ROLE_LABEL[p.role] : 'Сотрудник');
  }
  const ids = [...roleOf.keys()];
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null;
    return byId.get(id)?.name ?? people.find(p => p.id === id)?.name ?? `#${id}`;
  };

  const sys = systemDb(), an = analyticsDb();
  const [act, closures, repeatEv, bigEv, sessions, solo, calls] = await Promise.all([
    safe('задачи РОПов', failed, { tasks: [], repeatAccepted: new Map(), repeatReturned: new Map() } as Awaited<ReturnType<typeof loadRopTasks>>,
      () => loadRopTasks(ids, fromIso, toIso)),
    safe('sa.bitrix_task_current (закрытия)', failed, [] as {
      task_id: string; title: string | null; deal_id: string | null; group_id: number | null; created_by: string | null;
      responsible_id: string | null; responsible_name: string | null; closed_by: string; closed_at: Date;
    }[], () => an.query(
      `SELECT task_id::text, title, deal_id::text, group_id, created_by::text, responsible_id::text, responsible_name,
              closed_by::text, closed_at
         FROM sa.bitrix_task_current
        WHERE NOT is_deleted AND status = 5 AND closed_by = ANY($1::int[]) AND closed_at >= $2 AND closed_at < $3`,
      [ids.map(Number).filter(Number.isFinite), fromIso, toIso]).then(r => r.rows)),
    safe('repeat_kanban_events', failed, [] as {
      actor: string; event_type: string; ts: Date; manager_id: string | null; deal_id: string | null; task_id: string | null; client_key: string | null;
    }[], () => sys.query(
      `SELECT actor_bitrix_id AS actor, event_type, ts, manager_id, deal_id::text, task_id::text, client_key
         FROM repeat_kanban_events
        WHERE actor_type = 'user' AND actor_bitrix_id = ANY($1::text[]) AND ts >= $2 AND ts < $3
        ORDER BY ts`, [ids, fromIso, toIso]).then(r => r.rows)),
    safe('activity_events (канбан больших)', failed, [] as { who: string; ts: Date; op: string | null; task_id: string | null; deal_id: string | null }[],
      () => sys.query(
        `SELECT bitrix_user_id AS who, ts, payload->>'op' AS op, entity_id AS task_id, deal_id::text
           FROM activity_events
          WHERE kind = 'mono_action' AND section = 'big_deals' AND bitrix_user_id = ANY($1::text[]) AND ts >= $2 AND ts < $3
          ORDER BY ts`, [ids, fromIso, toIso]).then(r => r.rows)),
    safe('tasker_sessions', failed, [] as {
      id: string; rop: string; slot_start: Date; duration_min: number; held_at: Date | null; metric: string | null; managers: string[] | null;
    }[], () => sys.query(
      `SELECT s.id::text, s.rop_bitrix_id AS rop, s.slot_start, s.duration_min, s.held_at, m.label AS metric,
              (SELECT array_agg(DISTINCT coalesce(t.manager_name, t.manager_bitrix_id)) FROM tasker_tasks t
                WHERE t.session_id = s.id AND t.cancelled_at IS NULL) AS managers
         FROM tasker_sessions s LEFT JOIN tasker_metrics m ON m.id = s.metric_id
        WHERE s.rop_bitrix_id = ANY($1::text[]) AND s.slot_start >= $2 AND s.slot_start < $3
          AND EXISTS (SELECT 1 FROM tasker_tasks t WHERE t.session_id = s.id AND t.cancelled_at IS NULL)
        ORDER BY s.slot_start`, [ids, fromIso, toIso]).then(r => r.rows)),
    safe('tasker_tasks (практики)', failed, [] as {
      id: string; creator: string; slot_start: Date; slot_end: Date | null; duration_min: number; manager: string | null;
      title: string; bitrix_task_id: string | null; deal_id: string | null;
    }[], () => sys.query(
      `SELECT id::text, creator_bitrix_id AS creator, slot_start, slot_end, duration_min, coalesce(manager_name, manager_bitrix_id) AS manager,
              title, bitrix_task_id::text, deal_id::text
         FROM tasker_tasks
        WHERE cancelled_at IS NULL AND session_id IS NULL AND kind = 'practice' AND creator_bitrix_id = ANY($1::text[])
          AND slot_start >= $2 AND slot_start < $3`, [ids, fromIso, toIso]).then(r => r.rows)),
    safe('va.calls', failed, [] as { mid: string; n: number; reached: number; sec: number; first: Date }[], () => an.query(
      `SELECT c.manager_id::text AS mid, count(*)::int AS n,
              count(*) FILTER (WHERE c.direction::text = 'outbound' AND coalesce(c.duration_seconds, 0) > 20)::int AS reached,
              coalesce(sum(c.duration_seconds), 0)::int AS sec, min(c.called_at) AS first
         FROM va.calls c
        WHERE c.failed_at_stage IS NULL -- #10823: служебные строки n8n — не звонки
          AND c.called_at >= $2 AND c.called_at < $3 AND c.manager_id::text = ANY($1)
          AND NOT (c.direction::text <> 'outbound' AND coalesce(c.result::text, '') = 'missed')
        GROUP BY 1`, [ids, fromIso, toIso]).then(r => r.rows)),
  ]);

  // Подробности задач: название / сделка / группа из копии Битрикса, тип и тема — из Задачника.
  const bxIds = new Set<number>();
  for (const t of act.tasks) if (t.bitrixTaskId) bxIds.add(t.bitrixTaskId);
  for (const e of repeatEv) if (e.task_id) bxIds.add(Number(e.task_id));
  for (const e of bigEv) if (e.task_id && /^\d+$/.test(e.task_id)) bxIds.add(Number(e.task_id));
  const taskerIds = act.tasks.filter(t => t.service === 'tasker').map(t => t.key.slice('tasker:'.length));
  const [bxInfo, taskerInfo] = await Promise.all([
    bxIds.size
      ? safe('sa.bitrix_task_current (названия)', failed, new Map<string, BxInfo>(), async () => {
        const r = await an.query<BxInfo & { task_id: string }>(
          `SELECT task_id::text, title, deal_id::text, group_id, responsible_id::text, responsible_name
             FROM sa.bitrix_task_current WHERE task_id = ANY($1::bigint[])`, [[...bxIds]]);
        return new Map(r.rows.map(x => [x.task_id, x]));
      })
      : Promise.resolve(new Map<string, BxInfo>()),
    taskerIds.length
      ? safe('tasker_tasks', failed, new Map<string, { kind: string; title: string; deal_id: string | null; metric: string | null; manager: string | null }>(), async () => {
        const r = await sys.query<{ id: string; kind: string; title: string; deal_id: string | null; metric: string | null; manager: string | null }>(
          `SELECT t.id::text, t.kind, t.title, t.deal_id::text, m.label AS metric, coalesce(t.manager_name, t.manager_bitrix_id) AS manager
             FROM tasker_tasks t LEFT JOIN tasker_metrics m ON m.id = t.metric_id WHERE t.id = ANY($1::bigint[])`, [taskerIds]);
        return new Map(r.rows.map(x => [x.id, x]));
      })
      : Promise.resolve(new Map()),
  ]);

  const taskLinks = (taskId: number | string | null | undefined, dealId: string | number | null | undefined, groupId?: number | null): RopDayItem['links'] => {
    const out: RopDayItem['links'] = [];
    if (taskId) out.push({ label: `задача ${taskId}`, href: bitrixTaskUrl(Number(taskId), groupId ?? bxInfo.get(String(taskId))?.group_id ?? null) });
    const d = dealId ?? (taskId ? bxInfo.get(String(taskId))?.deal_id : null);
    if (d) out.push({ label: `сделка ${d}`, href: dealUrl(d) });
    return out;
  };

  const items = new Map<string, RopDayItem[]>(ids.map(id => [id, []]));
  const meetingMin = new Map<string, number>(); // ключ события → длительность разбора
  const push = (id: string, it: RopDayItem) => items.get(id)?.push(it);

  // Поставил / на обучение.
  for (const t of act.tasks) {
    const bx = t.bitrixTaskId ? bxInfo.get(String(t.bitrixTaskId)) : undefined;
    const tk = t.service === 'tasker' ? taskerInfo.get(t.key.slice('tasker:'.length)) : undefined;
    const training = tk?.kind === 'theory';
    const svc = SERVICE_LABEL[t.service];
    const kindLabel = tk ? ({ theory: 'Теория', practice: 'Практика', deal: 'по сделке' } as Record<string, string>)[tk.kind] ?? '' : '';
    push(t.creatorId, {
      key: t.key, at: t.createdAt, kind: training ? 'training' : 'task_set',
      title: training ? 'Отправил на обучение (Задачник, «Теория»)'
        : `Поставил задачу — ${svc}${kindLabel ? `, ${kindLabel}` : ''}${t.via === 'direct' ? ' (прямо в Битриксе)' : ''}`,
      detail: [tk?.metric && `тема «${tk.metric}»`, bx?.title ?? tk?.title].filter(Boolean).join(' · ') || null,
      service: t.service, via: t.via,
      who: nameOf(t.assigneeId) ?? tk?.manager ?? bx?.responsible_name ?? null,
      links: taskLinks(t.bitrixTaskId, tk?.deal_id ?? bx?.deal_id ?? null),
    });
  }

  // Канбан повторки: приёмки, возвраты, прочее (постановки уже выше — из loadRopTasks).
  const seenAcceptTask = new Set<string>(); // `${actor}:${taskId}` — закрытие Битрикса по ней второй раз не показываем
  for (const e of repeatEv) {
    if ((REPEAT_CREATE_EVENTS as readonly string[]).includes(e.event_type)) continue;
    const accept = (REPEAT_ACCEPT_EVENTS as readonly string[]).includes(e.event_type);
    const ret = e.event_type === 'task_returned';
    if ((accept || ret) && e.task_id) seenAcceptTask.add(`${e.actor}:${e.task_id}`);
    const bx = e.task_id ? bxInfo.get(e.task_id) : undefined;
    push(e.actor, {
      key: `rk:${e.actor}:${e.event_type}:${new Date(e.ts).getTime()}:${e.task_id ?? e.deal_id ?? e.client_key ?? ''}`,
      at: iso(e.ts)!, kind: accept ? 'task_accept' : ret ? 'task_return' : 'kanban',
      title: accept ? `Принял задачу — Повторка${e.event_type === 'task_accepted_deal_closed' ? ', сделка закрыта' : e.event_type === 'task_accepted_postponed' ? ', отложено' : ''}`
        : ret ? 'Вернул на доработку — Повторка'
          : `Канбан повторки: ${KANBAN_LABEL[e.event_type] ?? e.event_type}`,
      detail: bx?.title ?? null, service: 'repeat', via: 'mono',
      who: nameOf(e.manager_id) ?? bx?.responsible_name ?? null,
      links: taskLinks(e.task_id, e.deal_id, e.task_id ? bx?.group_id ?? REPEAT_PROJECT_GROUP_ID : null),
    });
  }

  // Канбан больших (журнал Монолитики).
  for (const e of bigEv) {
    const op = e.op ?? 'other';
    const tid = e.task_id && /^\d+$/.test(e.task_id) ? e.task_id : null;
    const accept = BIG_ACCEPT_OPS.has(op), ret = op === 'return';
    if ((accept || ret) && tid) seenAcceptTask.add(`${e.who}:${tid}`);
    const bx = tid ? bxInfo.get(tid) : undefined;
    push(e.who, {
      key: `bd:${e.who}:${op}:${new Date(e.ts).getTime()}:${tid ?? ''}`, at: iso(e.ts)!,
      kind: accept ? 'task_accept' : ret ? 'task_return' : 'kanban',
      title: accept ? `Принял задачу — Большие чеки (${BIG_OP_LABEL[op]})` : ret ? 'Вернул на доработку — Большие чеки'
        : `Канбан больших: ${BIG_OP_LABEL[op] ?? op}`,
      detail: bx?.title ?? null, service: 'big', via: 'mono', who: bx?.responsible_name ?? null,
      links: taskLinks(tid, e.deal_id),
    });
  }

  // Закрытия в Битриксе (в т.ч. через Задачник и вручную).
  const groupsSvc = (g: number | null): RopService | null => (g === REPEAT_PROJECT_GROUP_ID ? 'repeat' : null);
  for (const c of closures) {
    if (seenAcceptTask.has(`${c.closed_by}:${c.task_id}`)) continue;
    const checked = c.created_by === c.closed_by && c.responsible_id !== c.closed_by;
    push(c.closed_by, {
      key: `cl:${c.task_id}`, at: iso(c.closed_at)!, kind: checked ? 'task_accept' : 'task_done',
      title: checked ? 'Проверил и закрыл задачу' : 'Закрыл задачу',
      detail: c.title, service: groupsSvc(c.group_id), via: null,
      who: checked ? (nameOf(c.responsible_id) ?? c.responsible_name) : null,
      links: taskLinks(c.task_id, c.deal_id, c.group_id),
    });
  }

  // Разборы: сессии Задачника и «Практики» один на один. До начала слота — «запланирован», в итог не входит.
  for (const s of sessions) {
    const started = new Date(s.slot_start).getTime() <= now;
    const mgrs = (s.managers ?? []).filter(Boolean);
    meetingMin.set(`ses:${s.id}`, s.duration_min);
    push(s.rop, {
      key: `ses:${s.id}`, at: iso(s.slot_start)!, kind: 'meeting',
      title: `${started ? 'Разбор' : 'Разбор запланирован'}${s.metric ? `: ${s.metric}` : ''} · ${s.duration_min} мин${s.held_at ? ' · отмечен «Провёл»' : ''}`,
      detail: mgrs.length ? `${mgrs.length} чел.` : null, service: 'tasker', via: 'mono', who: mgrs.join(', ') || null,
      links: [{ label: 'Задачник', href: '/tasker?view=week' }],
    });
  }
  for (const t of solo) {
    meetingMin.set(`solo:${t.id}`, t.duration_min);
    push(t.creator, {
      key: `solo:${t.id}`, at: iso(t.slot_start)!, kind: 'meeting',
      title: `${new Date(t.slot_start).getTime() <= now ? 'Практика один на один' : 'Практика запланирована'} · ${t.duration_min} мин`,
      detail: t.title, service: 'tasker', via: 'mono', who: t.manager, links: taskLinks(t.bitrix_task_id, t.deal_id),
    });
  }

  // Звонки — одна строка.
  for (const c of calls) {
    push(c.mid, {
      key: `calls:${c.mid}`, at: iso(c.first)!, kind: 'calls',
      title: `Звонки: ${c.n}, дозвон ${c.reached}, ${Math.round(c.sec / 60)} мин`, detail: 'с первого звонка дня; по минутам — в ленте дня',
      service: null, via: null, who: null, links: [{ label: 'лента дня', href: personDayUrl(c.mid, date) }],
    });
  }

  const persons: RopDayPerson[] = ids.map(id => {
    const list = (items.get(id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const s = zero();
    for (const it of list) {
      if (it.kind === 'task_set') s.set++;
      else if (it.kind === 'training') { s.training++; s.set++; }
      else if (it.kind === 'task_done') s.done++;
      else if (it.kind === 'task_accept') s.accepted++;
      else if (it.kind === 'task_return') s.returned++;
      else if (it.kind === 'kanban') s.kanban++;
      else if (it.kind === 'meeting' && Date.parse(it.at) <= now) {
        s.meetings++;
        s.meetingMin += meetingMin.get(it.key) ?? 0;
      }
    }
    const c = calls.find(x => x.mid === id);
    if (c) { s.calls = c.n; s.callsReached = c.reached; s.callMin = Math.round(c.sec / 60); }
    const acts = list.filter(it => it.kind !== 'meeting' || Date.parse(it.at) <= now);
    const team = teams.get(id) ?? [];
    return {
      id, name: nameOf(id) ?? `#${id}`, role: roleOf.get(id) ?? 'РОП',
      deptNames: [...new Set([byId.get(id)?.deptName, ...team.map(p => p.deptName)].filter((v): v is string => !!v))],
      teamSize: team.length, summary: s,
      firstAt: acts[0]?.at ?? null, lastAt: acts.length ? acts.reduce((m, x) => (x.at > m ? x.at : m), acts[0].at) : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const detailPerson = detailId ? persons.find(p => p.id === detailId) ?? null : null;
  return {
    date, generatedAt: new Date(now).toISOString(),
    rops: persons,
    detail: detailPerson ? { person: detailPerson, items: items.get(detailPerson.id) ?? [] } : null,
    failed,
    notes: [
      'Время — МСК. «Поставил» — те же задачи, что в рейтинге РОПов: Задачник, канбан повторки (засчитывается нажавшему) и задачи, созданные прямо в Битриксе в проектах трёх сервисов. Задачи вне этих проектов здесь не показываются.',
      '«Проверил» — закрыл задачу, которую ставил сам (исполнитель другой), или принял её в канбане повторки / больших. «Закрыл» — прочие закрытия, где он закрывающий (в т.ч. свои «Практики» — с 279 их исполнитель РОП).',
      'Разбор — сессия Задачника или «Практика» один на один по слоту в календаре; «отмечен «Провёл»» — РОП нажал кнопку. Собрания Задачника (повторяющиеся) пока не показываются.',
      'Возвраты на доработку прямо в Битриксе (без канбана) не видны: в копии Битрикса у перехода статуса нет автора.',
      'Звонки — без пропущенных входящих и служебных строк обработчика.',
    ],
  };
}
