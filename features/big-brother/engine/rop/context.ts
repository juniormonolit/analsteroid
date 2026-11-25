// «Большой брат» → «РОПы»: контекст рядом с рейтингом (итерация 26.11, одобрено владельцем). Это НЕ баллы и в рейтинг
// не суммируется — показываем рядом, чтобы видеть, ставит ли РОП задачи «по цифрам» и кого из подчинённых не видит.
//
//  1) «Отчёт → задача»: задача РОПа «осознанная», если поставлена из строки отчёта / карточки (payload.origin у
//     mono_action/task_create — поток A, с 26.11) или в течение 30 мин после просмотра отчёта либо карточки
//     /manager/<id> того же менеджера (эвристика — для задач без origin и для больших / повторки). Задачи до начала
//     журнала (activity_events, с 25.11 ~14:40 МСК) не классифицируются.
//  2) Внимание: РОП × подчинённые — последний просмотр карточки / дрилл отчёта по менеджеру, число за период;
//     «слепая зона» — не открыт N недель, отдельно — при просадке продаж (> 20 % к предыдущему такому же периоду).
//  3) Ритм: день недели × час (МСК) просмотров отчётов и карточек; подготовка к сессиям Задачника (tasker_sessions) —
//     был просмотр за 3 ч до начала.
import { systemDb } from '@/lib/db/clients';
import { isReportSection, sectionOfPath } from '@/lib/activity/section';
import { loadRopTasks, loadTeams } from './sources';
import { memberMetrics } from './deptMetrics';
import { addDays, daysOf, periodBounds, type BbPeriod } from './period';
import type { AttentionRow, ReportToTaskRow, RhythmRow, RopContextResponse, TaskBasis } from './types';

const WINDOW_MS = 30 * 60_000;
/** task_create пишется после ответа Битрикса — допуск, чтобы просмотр «в ту же минуту» не потерялся. */
const SLACK_MS = 2 * 60_000;
const PREP_MS = 3 * 3600_000;
const INFORMED_FROM = new Set(['report_row', 'drilldown_deal', 'manager_card']);

interface Ev {
  actor: string; ts: Date; kind: string; action: string | null; section: string | null;
  entity_type: string | null; entity_id: string | null; path: string | null;
  origin: { from?: string; target_manager_id?: string | null } | null; manager_id: string | null;
}

/** Событие — «смотрел цифры»: отчёт (загрузка / дрилл / просмотр страницы отчёта) или карточка менеджера. */
function lookedAt(e: Ev): { report: boolean; managerId: string | null } {
  const managerId = e.entity_type === 'manager' ? e.entity_id
    : e.manager_id ?? (e.path?.match(/^\/manager\/(\d{1,15})(?:[/?#]|$)/)?.[1] ?? null);
  if (e.kind === 'mono_action' && (e.action === 'report_load' || e.action === 'report_drill')) return { report: true, managerId };
  if (e.kind === 'mono_view') {
    const section = e.path ? sectionOfPath(e.path) : e.section ?? '';
    return { report: isReportSection(section), managerId };
  }
  return { report: false, managerId: null };
}

const mskParts = (d: Date) => {
  const m = new Date(d.getTime() + 3 * 3600_000);
  return { dow: (m.getUTCDay() + 6) % 7, hour: m.getUTCHours() };
};

export async function buildRopContext(period: BbPeriod, blindWeeks: number, now = Date.now()): Promise<RopContextResponse> {
  const notes: string[] = [];
  const { byId, teams, shortLoginById } = await loadTeams();
  const ropIds = [...teams.keys()];
  const { fromIso, toExclIso } = periodBounds(period);
  const days = daysOf(period).length;
  const prev: BbPeriod = { from: addDays(period.from, -days), to: addDays(period.from, -1) };
  const evFromIso = new Date(Date.parse(fromIso) - PREP_MS).toISOString();

  const [since, events, lastSeen, act, sessions, nowM, prevM] = await Promise.all([
    systemDb().query<{ first: Date | null; origin_first: Date | null }>(
      `SELECT min(ts) AS first,
              min(ts) FILTER (WHERE kind = 'mono_action' AND action = 'task_create' AND payload ? 'origin') AS origin_first
         FROM activity_events`,
    ).then(r => r.rows[0]).catch(() => ({ first: null, origin_first: null })),
    systemDb().query<Ev>(
      `SELECT bitrix_user_id AS actor, ts, kind, action, section, entity_type, entity_id, payload->>'path' AS path,
              payload->'origin' AS origin, payload->>'manager_id' AS manager_id
         FROM activity_events
        WHERE bitrix_user_id = ANY($1::text[]) AND ts >= $2::timestamptz AND ts < $3::timestamptz
          AND kind IN ('mono_view', 'mono_action')
          AND (kind = 'mono_view' OR action IN ('report_load', 'report_drill', 'task_create'))
        ORDER BY ts`, [ropIds, evFromIso, toExclIso],
    ).then(r => r.rows).catch(e => { console.warn('[big-brother rop context] журнал', e instanceof Error ? e.message : e); return [] as Ev[]; }),
    // Последний взгляд на менеджера — за всё время журнала (90 дней), не только за период.
    systemDb().query<{ actor: string; mid: string; at: Date }>(
      `SELECT bitrix_user_id AS actor, mid, max(ts) AS at FROM (
         SELECT bitrix_user_id, ts,
                COALESCE(CASE WHEN entity_type = 'manager' THEN entity_id END,
                         payload->>'manager_id',
                         substring(payload->>'path' from '^/manager/([0-9]+)')) AS mid
           FROM activity_events
          WHERE bitrix_user_id = ANY($1::text[])
            AND ((kind = 'mono_view' AND (entity_type = 'manager' OR payload->>'path' LIKE '/manager/%'))
                 OR (kind = 'mono_action' AND action = 'report_drill' AND payload ? 'manager_id'))
       ) x WHERE mid IS NOT NULL GROUP BY 1, 2`, [ropIds],
    ).then(r => r.rows).catch(() => [] as { actor: string; mid: string; at: Date }[]),
    loadRopTasks(ropIds, fromIso, toExclIso),
    systemDb().query<{ rop: string; slot_start: Date }>(
      `SELECT rop_bitrix_id AS rop, slot_start FROM tasker_sessions
        WHERE rop_bitrix_id = ANY($1::text[]) AND slot_start >= $2::timestamptz AND slot_start < $3::timestamptz`,
      [ropIds, fromIso, toExclIso],
    ).then(r => r.rows).catch(() => [] as { rop: string; slot_start: Date }[]),
    memberMetrics(period, shortLoginById).catch(() => null),
    memberMetrics(prev, shortLoginById).catch(() => null),
  ]);
  const journalSince = since.first ? new Date(since.first).getTime() : null;

  // task_create с origin — по id задачи Задачника.
  const originByTasker = new Map<string, string>();
  const evBy = new Map<string, Ev[]>();
  for (const e of events) {
    if (e.kind === 'mono_action' && e.action === 'task_create' && e.entity_type === 'tasker_task' && e.entity_id && e.origin?.from) {
      originByTasker.set(e.entity_id, e.origin.from);
    }
    const l = evBy.get(e.actor) ?? [];
    l.push(e);
    evBy.set(e.actor, l);
  }

  // ── 1. Отчёт → задача ──
  const r2t = new Map<string, ReportToTaskRow>();
  for (const id of ropIds) {
    r2t.set(id, { ropId: id, name: byId.get(id)?.name ?? teams.get(id)?.[0]?.ropName ?? `#${id}`, tasks: 0, origin: 0, heuristic: 0, blind: 0, beforeJournal: 0, informedPct: null });
  }
  for (const t of act.tasks) {
    const row = r2t.get(t.creatorId);
    if (!row) continue;
    const at = Date.parse(t.createdAt);
    let basis: TaskBasis;
    const from = t.service === 'tasker' ? originByTasker.get(t.key.replace('tasker:', '')) : undefined;
    if (journalSince == null || at < journalSince) basis = 'before_journal';
    else if (from && INFORMED_FROM.has(from)) basis = 'origin';
    else {
      const hit = (evBy.get(t.creatorId) ?? []).some(e => {
        const ts = new Date(e.ts).getTime();
        if (ts < at - WINDOW_MS || ts > at + SLACK_MS) return false;
        const l = lookedAt(e);
        return l.report || (!!l.managerId && l.managerId === t.assigneeId);
      });
      basis = hit ? 'heuristic' : 'blind';
    }
    row.tasks++;
    if (basis === 'origin') row.origin++;
    else if (basis === 'heuristic') row.heuristic++;
    else if (basis === 'blind') row.blind++;
    else row.beforeJournal++;
  }
  for (const r of r2t.values()) {
    const known = r.tasks - r.beforeJournal;
    r.informedPct = known > 0 ? (r.origin + r.heuristic) / known : null;
  }

  // ── 2. Внимание ──
  const lastBy = new Map<string, number>();
  for (const r of lastSeen) lastBy.set(`${r.actor}:${r.mid}`, new Date(r.at).getTime());
  const viewsBy = new Map<string, { views: number; drills: number }>();
  const fromMs = Date.parse(fromIso);
  for (const e of events) {
    if (new Date(e.ts).getTime() < fromMs) continue;
    const l = lookedAt(e);
    if (!l.managerId) continue;
    const k = `${e.actor}:${l.managerId}`;
    const v = viewsBy.get(k) ?? { views: 0, drills: 0 };
    if (e.kind === 'mono_action' && e.action === 'report_drill') v.drills++; else if (e.kind === 'mono_view') v.views++;
    viewsBy.set(k, v);
  }
  const blindBefore = now - blindWeeks * 7 * 86_400_000;
  const attention: AttentionRow[] = ropIds.map(rid => {
    const subs = (teams.get(rid) ?? []).map(p => {
      const last = lastBy.get(`${rid}:${p.id}`) ?? null;
      const v = viewsBy.get(`${rid}:${p.id}`);
      const salesNow = nowM?.get(p.id)?.salesAmount ?? (nowM ? 0 : null);
      const salesPrev = prevM?.get(p.id)?.salesAmount ?? (prevM ? 0 : null);
      return {
        id: p.id, name: p.name, lastSeenAt: last ? new Date(last).toISOString() : null,
        views: v?.views ?? 0, drills: v?.drills ?? 0, salesNow, salesPrev,
        drop: salesNow != null && salesPrev != null && salesPrev > 0 && salesNow < salesPrev * 0.8,
        blind: last == null || last < blindBefore,
      };
    }).sort((a, b) => Number(b.blind && b.drop) - Number(a.blind && a.drop) || Number(b.blind) - Number(a.blind) || a.name.localeCompare(b.name, 'ru'));
    return {
      ropId: rid, name: r2t.get(rid)!.name,
      blindCount: subs.filter(s => s.blind).length, blindWithDrop: subs.filter(s => s.blind && s.drop).length, subs,
    };
  });

  // ── 3. Ритм ──
  const rhythm: RhythmRow[] = ropIds.map(rid => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    let total = 0;
    const looks: number[] = [];
    for (const e of evBy.get(rid) ?? []) {
      const l = lookedAt(e);
      if (!l.report && !l.managerId) continue;
      const d = new Date(e.ts);
      looks.push(d.getTime());
      if (d.getTime() < fromMs) continue;
      const { dow, hour } = mskParts(d);
      grid[dow][hour]++;
      total++;
    }
    const mine = sessions.filter(s => s.rop === rid);
    const prepared = mine.filter(s => { const st = new Date(s.slot_start).getTime(); return looks.some(x => x >= st - PREP_MS && x <= st); }).length;
    return { ropId: rid, name: r2t.get(rid)!.name, grid, total, sessions: mine.length, sessionsPrepared: prepared };
  });

  const order = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'ru');
  const journalAge = journalSince ? (now - journalSince) / 86_400_000 : 0;
  notes.push(
    'Это контекст, не баллы: в рейтинг не суммируется.',
    `Журнал просмотров ведётся с ${journalSince ? new Date(journalSince).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }) : '—'} МСК; задачи раньше — «до журнала», не классифицируются.`,
    since.origin_first
      ? `Источник задачи (строка отчёта / карточка) пишется с ${new Date(since.origin_first).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })} и только в Задачнике; всё остальное — по эвристике: просмотр отчёта или карточки этого менеджера за 30 мин до постановки.`
      : 'Источник задачи (строка отчёта / карточка) ещё не пишется — всё по эвристике: просмотр отчёта или карточки этого менеджера за 30 мин до постановки.',
    'Внимание: карточка /manager/<id> и дрилл отчёта по менеджеру. Просадка — продажи ниже предыдущего такого же периода больше чем на 20 %.',
  );
  if (journalAge < blindWeeks * 7) notes.push(`Журналу меньше ${blindWeeks} нед. — «слепые зоны» пока означают «не открывал с начала журнала».`);
  return {
    period, journalSince: journalSince ? new Date(journalSince).toISOString() : null,
    originSince: since.origin_first ? new Date(since.origin_first).toISOString() : null, blindWeeks,
    reportToTask: [...r2t.values()].sort((a, b) => b.tasks - a.tasks || order(a, b)),
    attention: attention.sort((a, b) => b.blindWithDrop - a.blindWithDrop || b.blindCount - a.blindCount || order(a, b)),
    rhythm: rhythm.sort((a, b) => b.total - a.total || order(a, b)),
    notes,
  };
}
