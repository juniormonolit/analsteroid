// Ежедневный обходчик систем (ТЗ владельца 28.09: «придумай ежедневный обходчик,
// который пишет мне в „Аналитика“ каждое утро в 9, что все системы работают»).
//
// Повод — реальный инцидент: ночной синк оргструктуры падал с «permission denied
// for table employees», сообщение ушло в app.log, и никто об этом не знал.
//
// Принцип: проверяем НАБЛЮДАЕМЫЕ СЛЕДСТВИЯ (свежесть данных, доступность записи),
// а не факт запуска джобы. Умершая джоба сама о себе не сообщит, а протухшие
// данные видно всегда. Плюс отдельная проба прав там, где мы уже обожглись.
//
// Расписание в instrumentation.ts: тик раз в 10 минут. Сводка — раз в сутки в час
// из настроек канала (по умолчанию 9 МСК). О НОВОЙ поломке пишем сразу, но не чаще
// раза в 6 часов на одну проверку — чтобы сторож не превратился в спам.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { getBotFunctionConfig, sendBitrixBotMessage } from '@/lib/bitrix/notify';
import { redisReady } from '@/lib/cache/redis';

export interface HealthCheck {
  key: string;
  title: string;
  ok: boolean;
  /** Что именно увидели — попадает в сообщение как есть. */
  detail: string;
  /** Критичная система: о поломке пишем сразу, не дожидаясь утра. */
  critical: boolean;
}

const OWNER_BITRIX_ID = '2098';
const ALERT_COOLDOWN_HOURS = 6;

const hoursAgo = (iso: string | null): number | null =>
  iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : null;
const fmtAge = (h: number | null): string =>
  h == null ? 'данных нет'
    : h < 1 ? `${Math.round(h * 60)} мин назад`
    : h < 48 ? `${h.toFixed(1)} ч назад`
    : `${Math.round(h / 24)} дн назад`;

/** Рабочее время МСК — ночью тишина в сделках и звонках это норма, не поломка. */
function mskHour(): number {
  return Number(new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).slice(11, 13));
}

async function check(key: string, title: string, critical: boolean, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<HealthCheck> {
  try {
    const r = await fn();
    return { key, title, critical, ...r };
  } catch (e) {
    return { key, title, critical, ok: false, detail: `проверка упала: ${e instanceof Error ? e.message : e}` };
  }
}

export async function runHealthChecks(): Promise<HealthCheck[]> {
  const workHours = mskHour() >= 10 && mskHour() <= 20;

  return Promise.all([
    // 1. Оргструктура: ночной пересчёт sa.org_resolved_hierarchy.
    check('org_sync', 'Оргструктура', true, async () => {
      const r = await analyticsDb().query<{ last: string | null; n: string }>(
        `SELECT max(resolved_at)::text AS last, count(*)::text AS n FROM sa.org_resolved_hierarchy WHERE is_active`);
      const age = hoursAgo(r.rows[0]?.last ?? null);
      return {
        ok: age != null && age < 26,
        detail: `${r.rows[0]?.n ?? 0} чел., пересчёт ${fmtAge(age)}`,
      };
    }),

    // 2. Права на запись в sa.employees — ровно то, на чём падал синк (инцидент 28.09).
    //    UPDATE ... WHERE false ничего не меняет, но требует тех же прав.
    check('org_sync_perms', 'Права синка на sa.employees', true, async () => {
      await analyticsDb().query(`UPDATE sa.employees SET work_phone = work_phone WHERE false`);
      return { ok: true, detail: 'запись разрешена' };
    }),

    // 3. Сделки: приезжают вебхуками Битрикса в sa.deals.
    check('deals', 'Поток сделок', true, async () => {
      const r = await analyticsDb().query<{ last: string | null; today: string }>(
        `SELECT max(updated_at)::text AS last,
                count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow'))::text AS today
           FROM deals`);
      const age = hoursAgo(r.rows[0]?.last ?? null);
      return {
        ok: age != null && age < (workHours ? 3 : 14),
        detail: `сегодня создано ${r.rows[0]?.today ?? 0}, последнее изменение ${fmtAge(age)}`,
      };
    }),

    // 4. Телефония: va.calls.
    check('calls', 'Звонки', false, async () => {
      const r = await analyticsDb().query<{ last: string | null; today: string }>(
        `SELECT max(called_at)::text AS last,
                count(*) FILTER (WHERE called_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Moscow'))::text AS today
           FROM va.calls`);
      const age = hoursAgo(r.rows[0]?.last ?? null);
      return {
        ok: age != null && age < (workHours ? 4 : 16),
        detail: `сегодня ${r.rows[0]?.today ?? 0}, последний ${fmtAge(age)}`,
      };
    }),

    // 5. Планы на текущий месяц — без них все проценты плана нули.
    check('plans', 'Планы месяца', true, async () => {
      const r = await systemDb().query<{ n: string; sum: string }>(
        `SELECT count(*)::text AS n, COALESCE(sum(plan_shipments), 0)::text AS sum
           FROM manager_plans WHERE to_char(month, 'YYYY-MM') = to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM')`);
      const n = Number(r.rows[0]?.n ?? 0);
      return { ok: n > 0, detail: `${n} логинов, план отгрузок ${Math.round(Number(r.rows[0]?.sum ?? 0) / 1e6)} млн ₽` };
    }),

    // 6. Бот «Контроль звонков»: разбор кейсов и доставка.
    check('call_control', 'Контроль звонков', false, async () => {
      const r = await systemDb().query<{ last_case: string | null; last_sent: string | null; open: string; rules: string }>(
        `SELECT (SELECT max(created_at)::text FROM call_control_cases) AS last_case,
                (SELECT max(sent_at)::text FROM call_control_deliveries) AS last_sent,
                (SELECT count(*)::text FROM call_control_cases WHERE status = 'open') AS open,
                (SELECT count(*)::text FROM call_control_rules WHERE is_active) AS rules`);
      const row = r.rows[0];
      const caseAge = hoursAgo(row?.last_case ?? null);
      const rules = Number(row?.rules ?? 0);
      return {
        ok: rules > 0 && caseAge != null && caseAge < (workHours ? 6 : 20),
        detail: `правил ${rules}, открытых кейсов ${row?.open ?? 0}, последний кейс ${fmtAge(caseAge)}, отправка ${fmtAge(hoursAgo(row?.last_sent ?? null))}`,
      };
    }),

    // 7. Redis: без него отчёты считаются каждый раз заново и прод тормозит.
    check('redis', 'Кэш Redis', false, async () => {
      const c = await redisReady();
      if (!c) return { ok: false, detail: 'недоступен' };
      const t = Date.now();
      await c.ping();
      return { ok: true, detail: `отвечает за ${Date.now() - t} мс` };
    }),

    // 8. Фоновые расчёты: их результат лежит в Redis и должен быть свежим.
    check('jobs_cache', 'Фоновые расчёты', false, async () => {
      const c = await redisReady();
      if (!c) return { ok: false, detail: 'Redis недоступен — проверить нечем' };
      const keys = await c.keys('*plan:summary*');
      const wk = await c.keys('*widget:metrics*');
      const ttl = keys.length ? await c.ttl(keys[0]) : -2;
      return {
        ok: keys.length > 0 || wk.length > 0,
        detail: `сводка планов ${keys.length ? `есть (TTL ${ttl} с)` : 'нет'}, метрики виджета ${wk.length ? 'есть' : 'нет'}`,
      };
    }),

    // 9. Телевизоры: сколько привязанных экранов выходило на связь.
    check('tv', 'Телевизоры', false, async () => {
      const r = await systemDb().query<{ screens: string; devices: string; online: string }>(
        `SELECT (SELECT count(*)::text FROM tv_screens) AS screens,
                (SELECT count(*)::text FROM tv_devices WHERE screen_id IS NOT NULL) AS devices,
                (SELECT count(*)::text FROM tv_devices WHERE screen_id IS NOT NULL AND last_seen_at > now() - interval '10 minutes') AS online`);
      const row = r.rows[0];
      const devices = Number(row?.devices ?? 0), online = Number(row?.online ?? 0);
      return {
        ok: devices === 0 || online > 0,
        detail: `экранов ${row?.screens ?? 0}, телевизоров ${devices}, на связи ${online}`,
      };
    }),
  ]);
}

/** Строка состояния для одной проверки + признак «поломка только что появилась». */
interface StateRow { key: string; ok: boolean; failed_since: string | null; last_alert_at: string | null }

async function saveState(checks: HealthCheck[]): Promise<Map<string, StateRow>> {
  const prev = new Map<string, StateRow>();
  try {
    const r = await systemDb().query<StateRow>(`SELECT key, ok, failed_since::text, last_alert_at::text FROM system_health_state`);
    for (const row of r.rows) prev.set(row.key, row);
  } catch { /* таблицы нет — первый запуск до миграции 222 */ }

  for (const c of checks) {
    const was = prev.get(c.key);
    const failedSince = c.ok ? null : (was && !was.ok && was.failed_since ? was.failed_since : new Date().toISOString());
    await systemDb().query(
      `INSERT INTO system_health_state (key, ok, detail, checked_at, failed_since)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (key) DO UPDATE SET ok = EXCLUDED.ok, detail = EXCLUDED.detail,
             checked_at = now(), failed_since = EXCLUDED.failed_since`,
      [c.key, c.ok, c.detail, failedSince],
    ).catch(() => {});
  }
  return prev;
}

function line(c: HealthCheck): string {
  return `${c.ok ? '✅' : '❌'} ${c.title} — ${c.detail}`;
}

/** Утренняя сводка. Возвращает текст, который отправили (или null, если канал выключен). */
export async function sendHealthSummary(checks: HealthCheck[]): Promise<string | null> {
  const bad = checks.filter(c => !c.ok);
  const head = bad.length === 0
    ? `🟢 Все системы работают (${checks.length} проверок)`
    : `🔴 Проблем: ${bad.length} из ${checks.length}`;
  const text = [head, '', ...checks.map(line)].join('\n');
  const cfg = await getBotFunctionConfig('system_health');
  const to = cfg.recipients?.length ? cfg.recipients : [OWNER_BITRIX_ID];
  let sent = 0;
  for (const id of to) sent += await sendBitrixBotMessage(id, text, undefined, 'system_health');
  return sent > 0 ? text : null;
}

/** Срочное сообщение о ТОЛЬКО ЧТО появившейся поломке критичной системы. */
async function alertNewFailures(checks: HealthCheck[], prev: Map<string, StateRow>): Promise<void> {
  const fresh = checks.filter(c => {
    if (c.ok || !c.critical) return false;
    const was = prev.get(c.key);
    if (was && !was.ok) {
      // уже падала: повторяем не чаще, чем раз в ALERT_COOLDOWN_HOURS
      const since = hoursAgo(was.last_alert_at);
      return since == null || since >= ALERT_COOLDOWN_HOURS;
    }
    return true;
  });
  if (fresh.length === 0) return;

  const text = ['🔴 Сломалось:', '', ...fresh.map(line), '', 'Остальное проверю в утренней сводке.'].join('\n');
  const cfg = await getBotFunctionConfig('system_health');
  const to = cfg.recipients?.length ? cfg.recipients : [OWNER_BITRIX_ID];
  for (const id of to) await sendBitrixBotMessage(id, text, undefined, 'system_health');
  for (const c of fresh) {
    await systemDb().query(`UPDATE system_health_state SET last_alert_at = now() WHERE key = $1`, [c.key]).catch(() => {});
  }
}

/**
 * Один тик обходчика. `summary` — слать ли утреннюю сводку (решает расписание).
 * Возвращает проверки, чтобы их можно было показать в админке/логе.
 */
export async function healthTick(summary: boolean): Promise<HealthCheck[]> {
  const checks = await runHealthChecks();
  const prev = await saveState(checks);
  await alertNewFailures(checks, prev);
  if (summary) await sendHealthSummary(checks);
  return checks;
}
