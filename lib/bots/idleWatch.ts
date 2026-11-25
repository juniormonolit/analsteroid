// «Большой брат», поток C — СТОРОЖ МОПов (ТЗ: ai_docs/fresh_docs/BIG_BROTHER_SPEC.md, «Сторож МОПов»).
// Бот «Аналитик» пишет, если менеджер «в работе» сегодня, но в рабочем окне N минут подряд нет ни
// одного сигнала. Правила — как в «Контроле звонков» (lib/bots/callControl.ts): порог → получатель,
// эскалация = несколько правил с растущим порогом; dry_run + дубль на зеркало.
//
// Тик раз в 5 мин (instrumentation.ts → scheduleIdleWatch, ключ idleWatch в BACKGROUND_JOBS_ALLOW):
//   рабочий день по производственному календарю + внутри окна (дефолт 9–18 МСК) →
//   сигналы за сегодня по всем МОПам → «в работе» = был хоть один сигнал сегодня (нет — молчим:
//   вероятно, отсутствует) → тишина = от последнего сигнала, не раньше начала окна →
//   случай (менеджер, начало тишины) → правила с порогом ≤ тишины → по доставке на получателя.
//
// СИГНАЛЫ (кто «автор» — см. решения владельца в ТЗ; смену стадии засчитываем ответственному):
//   va.calls (failed_at_stage IS NULL) — исходящая попытка или принятый входящий (пропущенный — не действие);
//   sa.deal_events — события по сделкам менеджера; sa.deals — новая сделка менеджеру;
//   sa.bitrix_task_current — created_at (created_by), changed_at (responsible_id), closed_at (closed_by);
//   sa.bitrix_task_payload_raw — события задачи (received_at), засчитываются ответственному;
//   Монолитика — activity_events / activity_minutes (поток A; нет таблиц → 42P01, работаем без них)
//   и repeat_kanban_events (действия пользователя на доске повторки).
//
// ЛАГ. Звонки и задачи приходят из Roan таймером раз в 5 мин, а сам va.calls наполняется n8n с лагом
// (p90 ~11 мин от звонка). Поэтому тишину оцениваем не на «сейчас», а на момент evalAt =
// min(сейчас, фронтир звонков − запас, фронтир задач) — по данным, которые уже точно доехали.
// Фронтир звонков старше часа — источник стоит: сторож не шлёт ничего (иначе завалит ложными
// «нет звонков»), а в зеркало раз в час уходит предупреждение. Задачи старше часа — предупреждение,
// но сторож работает по остальным сигналам (синк задач уже стоял неделями — не глушить из-за него всё).

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { isWorkingDayJs } from '@/lib/metrics/productionCalendar';
import { sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { effectiveRecipients, loadRecipientOverrides, getAllRopAndDirectorIds } from '@/lib/org/callControlScope';
import { managerChatUrl } from '@/lib/bots/callControlAdmin';
import { getManagerOrgMap } from '@/lib/org/deptCategories';
import {
  formatIdle, type IdleWatchRecipient, type IdleWatchRuleDto, type IdleWatchSimulationDto,
} from '@/features/big-brother/ui/watch/shared';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // МСК без перехода на летнее время
const CALLS_MARGIN_MS = 15 * 60 * 1000;   // запас на обработку звонка n8n (p90 ~11 мин)
const SOURCE_STALE_MS = 60 * 60 * 1000;   // источник не обновлялся час — считаем стоящим
const STALE_WARN_EVERY_MS = 60 * 60 * 1000;

export interface IdleWatchSettings {
  enabled: boolean;
  dryRun: boolean;
  windowStartHour: number;
  windowEndHour: number;
  mirrorBitrixUserId: string | null;
}

export type SignalKind = 'call' | 'deal' | 'deal_new' | 'task' | 'mono' | 'kanban';
const KIND_LABEL: Record<SignalKind, string> = {
  call: 'звонок', deal: 'движение сделки', deal_new: 'новая сделка', task: 'задача', mono: 'Монолитика', kanban: 'канбан повторки',
};

interface Signal { at: number; kind: SignalKind }

interface WatchedManager {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  ropId: string | null;
  ropName: string | null;
  directorId: string | null;
  directorName: string | null;
  companyDirectorId: string | null;
}

// ── время МСК ────────────────────────────────────────────────────────────────

interface MskDay { date: string; y: number; m: number; d: number; isoDow: number; dayStart: Date }

function mskDay(at: Date): MskDay {
  const shifted = new Date(at.getTime() + MSK_OFFSET_MS);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth() + 1, d = shifted.getUTCDate();
  const dow = shifted.getUTCDay();
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { date, y, m, d, isoDow: dow === 0 ? 7 : dow, dayStart: mskAt(date, 0) };
}

/** Момент «дата МСК, час:00». */
function mskAt(date: string, hour: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) - MSK_OFFSET_MS + hour * 60 * 60 * 1000);
}

function hhmm(at: number): string {
  const s = new Date(at + MSK_OFFSET_MS);
  return `${String(s.getUTCHours()).padStart(2, '0')}:${String(s.getUTCMinutes()).padStart(2, '0')}`;
}

function isWorkingDay(day: MskDay): boolean {
  return isWorkingDayJs(day.y, day.m, day.d, day.isoDow);
}

// ── настройки и правила ──────────────────────────────────────────────────────

export async function loadIdleWatchSettings(): Promise<IdleWatchSettings> {
  const r = await systemDb().query(
    `SELECT enabled, dry_run, window_start_hour, window_end_hour, mirror_bitrix_user_id FROM idle_watch_settings WHERE id = 1`,
  );
  const s = r.rows[0];
  return {
    enabled: !!s?.enabled,
    dryRun: s ? s.dry_run !== false : true,
    windowStartHour: Number(s?.window_start_hour ?? 9),
    windowEndHour: Number(s?.window_end_hour ?? 18),
    mirrorBitrixUserId: s?.mirror_bitrix_user_id || null,
  };
}

export async function loadIdleWatchRules(activeOnly: boolean): Promise<IdleWatchRuleDto[]> {
  const r = await systemDb().query(
    `SELECT id, sort_order, name, minutes_idle, recipient, fixed_bitrix_user_id, template, is_active
       FROM idle_watch_rules ${activeOnly ? 'WHERE is_active' : ''} ORDER BY sort_order, minutes_idle, id`,
  );
  return r.rows.map((x) => ({
    id: x.id, sortOrder: x.sort_order, name: x.name, minutesIdle: x.minutes_idle,
    recipient: x.recipient as IdleWatchRecipient, fixedBitrixUserId: x.fixed_bitrix_user_id,
    template: x.template, isActive: x.is_active,
  }));
}

// ── кого сторожим ────────────────────────────────────────────────────────────

/**
 * Активные МОПы: в оргструктуре, отдел относится к продажам (категория по якорям
 * lib/org/deptCategories — логистика и прочие службы туда не попадают), сам не РОП/директор
 * (по оргструктуре + ручным назначениям «Контроля звонков»), логин/отдел не логистический.
 */
export async function loadWatchedManagers(): Promise<WatchedManager[]> {
  const [org, orgMap, leaders] = await Promise.all([
    analyticsDb().query(
      `SELECT manager_bitrix_user_id AS id, manager_name, department_id::text AS department_id, department_name,
              rop_bitrix_user_id, rop_name, department_director_bitrix_user_id, department_director_name,
              company_director_bitrix_user_id, short_login
         FROM sa.org_resolved_hierarchy
        WHERE is_active`,
    ),
    getManagerOrgMap(),
    getAllRopAndDirectorIds(),
  ]);
  const out: WatchedManager[] = [];
  for (const r of org.rows) {
    const id = String(r.id);
    if (!/^\d+$/.test(id)) continue;
    if (!orgMap.get(id)?.category) continue;
    if (leaders.ropIds.has(id) || leaders.directorIds.has(id)) continue;
    if (/logist|rop/i.test(String(r.short_login ?? '')) || /логист/i.test(String(r.department_name ?? ''))) continue;
    out.push({
      id,
      name: r.manager_name ?? id,
      departmentId: r.department_id,
      departmentName: r.department_name,
      ropId: r.rop_bitrix_user_id,
      ropName: r.rop_name,
      directorId: r.department_director_bitrix_user_id,
      directorName: r.department_director_name,
      companyDirectorId: r.company_director_bitrix_user_id,
    });
  }
  return out;
}

// ── сигналы ──────────────────────────────────────────────────────────────────

function isMissingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01';
}

/**
 * Все сигналы менеджеров за [from, to), по минутам (дубли в пределах минуты схлопнуты).
 * Каждый источник — отдельный запрос: падение одного не глушит остальные (в sourceRows — -1).
 */
export async function fetchSignals(
  ids: string[], from: Date, to: Date,
): Promise<{ byManager: Map<string, Signal[]>; sourceRows: Record<string, number> }> {
  const byManager = new Map<string, Signal[]>();
  const sourceRows: Record<string, number> = {};
  const idSet = new Set(ids);
  const add = (mid: unknown, at: unknown, kind: SignalKind) => {
    const id = mid == null ? '' : String(mid);
    if (!idSet.has(id) || !at) return;
    const t = new Date(at as string).getTime();
    if (!Number.isFinite(t)) return;
    const list = byManager.get(id);
    if (list) list.push({ at: t, kind }); else byManager.set(id, [{ at: t, kind }]);
  };

  const an = analyticsDb();
  const sys = systemDb();
  const p = [ids, from, to];
  const sources: Array<{ name: string; kind: SignalKind; run: () => Promise<{ rows: Array<{ mid: unknown; at: unknown }> }> }> = [
    {
      name: 'va.calls', kind: 'call',
      run: () => an.query(
        `SELECT c.manager_id::text AS mid, date_trunc('minute', c.called_at) AS at
           FROM va.calls c
          WHERE c.failed_at_stage IS NULL -- #10823: служебные строки n8n — не звонки
            AND c.called_at >= $2 AND c.called_at < $3 AND c.manager_id::text = ANY($1)
            AND (c.direction::text = 'outbound' OR (c.direction::text = 'inbound' AND coalesce(c.result::text, '') <> 'missed'))
          GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.deal_events', kind: 'deal',
      run: () => an.query(
        `SELECT manager_id::text AS mid, date_trunc('minute', event_at) AS at FROM sa.deal_events
          WHERE event_at >= $2 AND event_at < $3 AND manager_id::text = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.deals', kind: 'deal_new',
      run: () => an.query(
        `SELECT current_manager_id::text AS mid, date_trunc('minute', created_at) AS at FROM sa.deals
          WHERE created_at >= $2 AND created_at < $3 AND current_manager_id::text = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.bitrix_task_current', kind: 'task',
      run: () => an.query(
        `SELECT mid, date_trunc('minute', at) AS at FROM (
           SELECT created_by::text AS mid, created_at AS at FROM sa.bitrix_task_current WHERE created_at >= $2 AND created_at < $3
           UNION ALL
           SELECT responsible_id::text, changed_at FROM sa.bitrix_task_current WHERE changed_at >= $2 AND changed_at < $3
           UNION ALL
           SELECT closed_by::text, closed_at FROM sa.bitrix_task_current WHERE closed_at >= $2 AND closed_at < $3
         ) x WHERE mid = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'sa.bitrix_task_payload_raw', kind: 'task',
      run: () => an.query(
        `SELECT t.responsible_id::text AS mid, date_trunc('minute', r.received_at) AS at
           FROM sa.bitrix_task_payload_raw r JOIN sa.bitrix_task_current t ON t.task_id = r.task_id
          WHERE r.received_at >= $2 AND r.received_at < $3 AND t.responsible_id::text = ANY($1)
          GROUP BY 1, 2`, p),
    },
    {
      name: 'activity_events', kind: 'mono',
      run: () => sys.query(
        `SELECT bitrix_user_id AS mid, date_trunc('minute', ts) AS at FROM activity_events
          WHERE ts >= $2 AND ts < $3 AND bitrix_user_id = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'activity_minutes', kind: 'mono',
      run: () => sys.query(
        `SELECT bitrix_user_id AS mid, bucket AS at FROM activity_minutes
          WHERE source = 'mono' AND bucket >= $2 AND bucket < $3 AND bitrix_user_id = ANY($1) GROUP BY 1, 2`, p),
    },
    {
      name: 'repeat_kanban_events', kind: 'kanban',
      run: () => sys.query(
        `SELECT actor_bitrix_id AS mid, date_trunc('minute', ts) AS at FROM repeat_kanban_events
          WHERE actor_type = 'user' AND ts >= $2 AND ts < $3 AND actor_bitrix_id = ANY($1) GROUP BY 1, 2`, p),
    },
  ];

  await Promise.all(sources.map(async (s) => {
    try {
      const r = await s.run();
      sourceRows[s.name] = r.rows.length;
      for (const row of r.rows) add(row.mid, row.at, s.kind);
    } catch (e) {
      sourceRows[s.name] = -1;
      if (!isMissingTable(e)) console.warn(`[idleWatch] источник ${s.name} не прочитан:`, e instanceof Error ? e.message : e);
    }
  }));
  for (const list of byManager.values()) list.sort((a, b) => a.at - b.at);
  return { byManager, sourceRows };
}

/** Фронтиры источников с лагом (Roan): до какого момента данные уже доехали. */
async function fetchFrontiers(): Promise<{ calls: number | null; tasks: number | null }> {
  const an = analyticsDb();
  const [c, t] = await Promise.all([
    an.query(`SELECT max(created_at) AS last FROM va.calls WHERE failed_at_stage IS NULL AND created_at > now() - interval '3 days'`)
      .catch(() => ({ rows: [{ last: null }] })),
    an.query(`SELECT max(updated_at) AS last FROM sa.bitrix_task_current WHERE updated_at > now() - interval '3 days'`)
      .catch(() => ({ rows: [{ last: null }] })),
  ]);
  const ms = (v: unknown) => (v ? new Date(v as string).getTime() : null);
  return { calls: ms(c.rows[0]?.last), tasks: ms(t.rows[0]?.last) };
}

// ── оценка тишины ────────────────────────────────────────────────────────────

interface Silence { silenceFrom: number; lastSignal: Signal | null; minutes: number }

/**
 * Тишина менеджера на момент evalAt: null — не «в работе» (сигналов за день до evalAt нет).
 * Отсчёт — от последнего сигнала ≤ evalAt, но не раньше начала окна.
 */
export function silenceAt(signals: Signal[] | undefined, evalAt: number, windowStart: number): Silence | null {
  if (!signals?.length || signals[0].at > evalAt) return null;
  let last: Signal = signals[0];
  for (const s of signals) { if (s.at > evalAt) break; last = s; }
  const from = Math.max(last.at, windowStart);
  return {
    silenceFrom: from,
    lastSignal: last.at >= windowStart ? last : null,
    minutes: Math.max(0, Math.floor((evalAt - from) / 60_000)),
  };
}

function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '—');
}

// ── цикл ─────────────────────────────────────────────────────────────────────

async function warnStale(settings: IdleWatchSettings, text: string): Promise<void> {
  console.warn(`[idleWatch] ${text}`);
  if (!settings.mirrorBitrixUserId) return;
  const db = systemDb();
  const r = await db.query(
    `UPDATE idle_watch_settings SET last_stale_warn_at = now()
      WHERE id = 1 AND (last_stale_warn_at IS NULL OR last_stale_warn_at < now() - ($1 || ' milliseconds')::interval)
      RETURNING 1`,
    [String(STALE_WARN_EVERY_MS)],
  );
  if (!r.rowCount) return;
  await sendBitrixBotMessage(settings.mirrorBitrixUserId, `[Сторож МОПов] ${text}`, undefined, 'idle_watch').catch(() => 0);
}

async function saveSummary(summary: string): Promise<string> {
  await systemDb().query(
    `UPDATE idle_watch_settings SET last_tick_at = now(), last_tick_summary = $1 WHERE id = 1`, [summary],
  ).catch(() => {});
  return summary;
}

/** Один тик сторожа. Возвращает сводку для лога. */
export async function runIdleWatchCycle(now = new Date()): Promise<string> {
  const db = systemDb();
  const settings = await loadIdleWatchSettings();
  if (!settings.enabled) return 'disabled';

  const day = mskDay(now);
  const windowStart = mskAt(day.date, settings.windowStartHour).getTime();
  const windowEnd = mskAt(day.date, settings.windowEndHour).getTime();

  // Окна прошлых дней и вне окна — случаи закрываются (тишина «через ночь» не тянется).
  await db.query(
    `UPDATE idle_watch_cases SET resolved_at = now(), updated_at = now()
      WHERE resolved_at IS NULL AND (work_date < $1::date OR $2::boolean)`,
    [day.date, now.getTime() >= windowEnd],
  );
  if (!isWorkingDay(day)) return saveSummary(`нерабочий день ${day.date}`);
  if (now.getTime() < windowStart || now.getTime() >= windowEnd) return saveSummary('вне окна');

  const rules = await loadIdleWatchRules(true);
  if (!rules.length) return saveSummary('нет активных правил');
  const minThreshold = Math.min(...rules.map((r) => r.minutesIdle));

  // Данные доехали до evalAt — дальше тишину не утверждаем.
  const fr = await fetchFrontiers();
  if (fr.calls == null || now.getTime() - fr.calls > SOURCE_STALE_MS) {
    const lag = fr.calls == null ? 'нет данных за 3 дня' : `${Math.round((now.getTime() - fr.calls) / 60_000)} мин`;
    await warnStale(settings, `звонки (va.calls) не обновлялись: ${lag}. Сторож на паузе — иначе ложные «нет звонков».`);
    return saveSummary(`пауза: va.calls отстаёт (${lag})`);
  }
  // Звонки с called_at < (фронтир − запас на обработку n8n) уже точно в базе.
  let evalAt = Math.min(now.getTime(), fr.calls - CALLS_MARGIN_MS);
  if (fr.tasks != null && now.getTime() - fr.tasks <= SOURCE_STALE_MS) evalAt = Math.min(evalAt, fr.tasks);
  else await warnStale(settings, 'задачи Битрикса (sa.bitrix_task_current) не обновлялись больше часа — сторож работает без них, возможны ложные срабатывания.');

  const managers = await loadWatchedManagers();
  const { byManager } = await fetchSignals(managers.map((m) => m.id), day.dayStart, now);

  const overrides = await loadRecipientOverrides();
  const nameById = new Map<string, string>();
  for (const m of managers) nameById.set(m.id, m.name);
  {
    const ids = new Set<string>();
    for (const list of overrides.values()) for (const id of list) ids.add(id);
    for (const r of rules) if (r.fixedBitrixUserId) ids.add(r.fixedBitrixUserId);
    for (const m of managers) for (const id of [m.ropId, m.directorId, m.companyDirectorId]) if (id) ids.add(id);
    if (ids.size) {
      const r = await analyticsDb().query(
        `SELECT manager_bitrix_user_id AS id, manager_name FROM sa.org_resolved_hierarchy WHERE manager_bitrix_user_id = ANY($1)`,
        [[...ids]],
      );
      for (const x of r.rows) if (x.manager_name) nameById.set(String(x.id), x.manager_name);
    }
  }

  let inWork = 0, openCases = 0, sent = 0, logged = 0;
  for (const m of managers) {
    const sil = silenceAt(byManager.get(m.id), evalAt, windowStart);
    if (!sil) continue;
    inWork++;
    // Новый сигнал → прежние окна тишины закрыты.
    await db.query(
      `UPDATE idle_watch_cases SET resolved_at = now(), updated_at = now()
        WHERE manager_bitrix_user_id = $1 AND resolved_at IS NULL AND silence_from <> $2`,
      [m.id, new Date(sil.silenceFrom)],
    );
    if (sil.minutes < minThreshold) continue;
    openCases++;
    const c = await db.query<{ id: string }>(
      `INSERT INTO idle_watch_cases (manager_bitrix_user_id, manager_name, work_date, silence_from, last_signal_at, last_signal_kind, max_minutes, dry_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (manager_bitrix_user_id, silence_from)
       DO UPDATE SET max_minutes = GREATEST(idle_watch_cases.max_minutes, EXCLUDED.max_minutes), updated_at = now()
       RETURNING id`,
      [m.id, m.name, day.date, new Date(sil.silenceFrom), sil.lastSignal ? new Date(sil.lastSignal.at) : null,
        sil.lastSignal?.kind ?? null, sil.minutes, settings.dryRun],
    );
    const caseId = c.rows[0].id;

    const effRop = effectiveRecipients(overrides, m.departmentId, 'rop', m.ropId);
    const effDir = effectiveRecipients(overrides, m.departmentId, 'department_director', m.directorId);
    const chatUrl = managerChatUrl(m.id);

    for (const rule of rules) {
      if (sil.minutes < rule.minutesIdle) continue;
      let recipientIds: Array<string | null> =
        rule.recipient === 'manager' ? [m.id]
          : rule.recipient === 'rop' ? effRop
            : rule.recipient === 'department_director' ? effDir
              : rule.recipient === 'company_director' ? [m.companyDirectorId]
                : [rule.fixedBitrixUserId];
      if (!recipientIds.length) recipientIds = [null];

      for (const rid of recipientIds) {
        const recipientName = (rid && nameById.get(rid)) || rid || '—';
        const toManagerSelf = rid === m.id;
        const message = renderTemplate(rule.template, {
          manager_name: chatUrl && !toManagerSelf ? `[URL=${chatUrl}]${m.name}[/URL]` : m.name,
          department: m.departmentName ?? '—',
          rop_name: effRop.map((id) => nameById.get(id) ?? id).join(', ') || m.ropName || '—',
          hours: formatIdle(sil.minutes),
          minutes: String(sil.minutes),
          since: hhmm(sil.silenceFrom),
          last_signal: sil.lastSignal ? `${KIND_LABEL[sil.lastSignal.kind]} в ${hhmm(sil.lastSignal.at)}` : `до начала окна (${hhmm(windowStart)})`,
          recipient_name: recipientName,
        });
        // Вставка ДО отправки: при гонке двух тиков второй не пройдёт по уникальности.
        const ins = await db.query<{ id: string }>(
          `INSERT INTO idle_watch_deliveries
             (case_id, rule_id, rule_name, minutes_idle, recipient_kind, recipient_bitrix_user_id, recipient_name, message, dry_run)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (case_id, rule_id, (COALESCE(recipient_bitrix_user_id, ''))) DO NOTHING
           RETURNING id`,
          [caseId, rule.id, rule.name, sil.minutes, rule.recipient, rid, recipientName, message, settings.dryRun],
        );
        if (!ins.rowCount) continue;
        logged++;

        let error: string | null = null;
        if (!settings.dryRun) {
          if (!rid) error = 'получатель не разрешился (нет в оргструктуре)';
          else if (!rule.template.trim()) error = 'шаблон пуст';
          else {
            try {
              const ok = await sendBitrixBotMessage(rid, message, undefined, 'idle_watch');
              if (ok) sent++; else error = 'функция «Сторож МОПов» бота «Аналитик» выключена — не отправлено';
            } catch (e) { error = e instanceof Error ? e.message : String(e); }
          }
        }
        let mirrored = false;
        if (settings.mirrorBitrixUserId) {
          const mirrorMsg =
            `[Сторож МОПов — дубль${settings.dryRun ? ', DRY RUN: получателю НЕ отправлено' : ''}]\n` +
            `Кому: ${recipientName} (${rule.recipient}) · правило «${rule.name}»\n\n${message}`;
          try {
            mirrored = (await sendBitrixBotMessage(settings.mirrorBitrixUserId, mirrorMsg, undefined, 'idle_watch')) > 0;
          } catch (e) { error = error ?? `зеркало: ${e instanceof Error ? e.message : String(e)}`; }
        }
        await db.query(`UPDATE idle_watch_deliveries SET mirrored = $2, error = $3 WHERE id = $1`, [ins.rows[0].id, mirrored, error]);
      }
    }
  }

  return saveSummary(
    `МОПов ${managers.length}, в работе ${inWork}, тишина ≥${minThreshold} мин: ${openCases}, ` +
    `новых записей ${logged}${settings.dryRun ? ' (dry-run)' : `, отправлено ${sent}`}, оценка на ${hhmm(evalAt)}`,
  );
}

// ── прогон «что было бы» по истории (без записи и отправки) ───────────────────

/**
 * Проигрывает день шагом 5 минут (как тик) по полным данным за день — без учёта лага (история
 * уже доехала). Дедуп как у движка: одно правило на окно тишины один раз.
 */
export async function simulateIdleWatchDay(date: string): Promise<IdleWatchSimulationDto> {
  const settings = await loadIdleWatchSettings().catch(() => ({ windowStartHour: 9, windowEndHour: 18 } as IdleWatchSettings));
  const rules = await loadIdleWatchRules(true);
  const dayStart = mskAt(date, 0);
  const day = mskDay(new Date(dayStart.getTime() + 60_000));
  const windowStart = mskAt(date, settings.windowStartHour).getTime();
  const windowEnd = Math.min(mskAt(date, settings.windowEndHour).getTime(), Date.now());

  const managers = await loadWatchedManagers();
  const result: IdleWatchSimulationDto = {
    date, workingDay: isWorkingDay(day), watched: managers.length, inWork: 0, cases: 0, managersWithCases: 0,
    byRule: rules.map((r) => ({ ruleId: r.id, name: r.name, minutesIdle: r.minutesIdle, recipient: r.recipient, fired: 0 })),
    sourceRows: {}, top: [],
  };
  if (!result.workingDay || !rules.length) return result;

  const { byManager, sourceRows } = await fetchSignals(managers.map((m) => m.id), dayStart, new Date(windowEnd));
  result.sourceRows = sourceRows;
  const minThreshold = Math.min(...rules.map((r) => r.minutesIdle));
  const perManager: IdleWatchSimulationDto['top'] = [];

  for (const m of managers) {
    const signals = byManager.get(m.id);
    if (!signals?.some((s) => s.at < windowEnd)) continue;
    result.inWork++;
    const fired = new Set<string>(); // `${silenceFrom}:${ruleId}`
    const silences = new Map<number, number>(); // silenceFrom → max minutes
    for (let t = windowStart + 5 * 60_000; t <= windowEnd; t += 5 * 60_000) {
      const sil = silenceAt(signals, t, windowStart);
      if (!sil || sil.minutes < minThreshold) continue;
      silences.set(sil.silenceFrom, Math.max(silences.get(sil.silenceFrom) ?? 0, sil.minutes));
      for (const [i, r] of rules.entries()) {
        const key = `${sil.silenceFrom}:${r.id}`;
        if (sil.minutes >= r.minutesIdle && !fired.has(key)) { fired.add(key); result.byRule[i].fired++; }
      }
    }
    if (silences.size) {
      result.cases += silences.size;
      result.managersWithCases++;
      perManager.push({ managerName: m.name, bitrixId: m.id, cases: silences.size, maxMinutes: Math.max(...silences.values()) });
    }
  }
  result.top = perManager.sort((a, b) => b.maxMinutes - a.maxMinutes).slice(0, 15);
  return result;
}
