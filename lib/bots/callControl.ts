// Бот «Контроль звонков» — порт missedcalls-робота в Монолитику (задача Иосифа, 13.07).
// ИСТОЧНИК ДАННЫХ (решение Иосифа 13.07 вечером, после сверки): Мишина va.calls.
// Сверка показала: va.calls получает те же звонки, что и наш вебхук, НО только
// связанные со сделкой (n8n резолвит сделку сразу), лаг p50 ~0 мин / p90 ~11 мин.
// Звонок без сделки (жена/спамер/8800) в va.calls не попадает — и по бизнес-правилу
// такие пропущенные игнорируются. Синк перекладывает новые строки va.calls в наш
// call_events (event_name='VA_CALLS_SYNC', дедуп по (bitrix_call_id, event_name),
// TTL 7 дней) — вся механика курсора/кейсов переиспользуется. События вебхука
// (/api/telephony/webhook) движок ИГНОРИРУЕТ — приём оставлен как запасной канал.
// Риск: пайплайн n8n может встать на часы (наблюдали 5-часовой разрыв) — за этим
// следит сторожок свежести (warn в зеркало раз в час в рабочее время).
// Цикл (тик раз в минуту из instrumentation.ts, Redis-замок):
//   синк va.calls → новые события → кейсы (телефон+менеджер) → резолв успешным
//   исходящим → оценка правил (кол-во пропущенных / минуты без перезвона / И-ИЛИ) →
//   рендер кастомного шаблона → отправка ботом Bitrix «Контроль звонков» (BOT_ID 15010).
// Гардрейлы: enabled (выкл из коробки), dry_run (по умолчанию), зеркало-дубль.

import { systemDb, analyticsDb } from '@/lib/db/clients';
import { sendCallControlBotMessage } from '@/lib/bitrix/notify';
// DEAL_URL_PREFIX живёт в callControlAdmin (клиент-безопасный модуль): страница
// отчёта импортирует его в браузерный бандл, а этот файл тянет pg/fs.
import { DEAL_URL_PREFIX } from '@/lib/bots/callControlAdmin';

export { DEAL_URL_PREFIX };

export interface CallControlSettings {
  enabled: boolean;
  dryRun: boolean;
  mirrorBitrixUserId: string | null;
  lastProcessedEventId: number;
}

export interface CallControlRule {
  id: number;
  sortOrder: number;
  name: string;
  missedCountGte: number | null;
  minutesWithoutCallback: number | null;
  operator: 'and' | 'or';
  recipient: 'manager' | 'rop' | 'department_director' | 'company_director' | 'fixed';
  fixedBitrixUserId: string | null;
  templateId: number | null;
  isActive: boolean;
}

interface CaseRow {
  id: string;
  phone_normalized: string;
  manager_bitrix_user_id: string | null;
  deal_id: string | null;
  missed_count: number;
  first_missed_at: Date | null;
  last_missed_at: Date | null;
  last_outgoing_at: Date | null;
}

interface OrgRow {
  manager_name: string | null;
  department_id: string | null;
  department_name: string | null;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  company_director_bitrix_user_id: string | null;
}

// Телефон к каноническому виду: только цифры, ПОСЛЕДНИЕ 11 (АТС дописывает мусорные
// префиксы линий, реальный номер — хвост: жалоба Иосифа на «+024789111500177»),
// 8XXXXXXXXXX → 7XXXXXXXXXX, префикс '+'. Совпадает с форматом va.calls.phone_number.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 11) digits = digits.slice(-11);
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return `+${digits}`;
}

// Для сообщений: +79181286521 → «+7 (918) 128-65-21» (формат старого missedcalls-бота).
export function formatPhoneDisplay(phone: string | null | undefined): string {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone ?? '');
  return m ? `+7 (${m[1]}) ${m[2]}-${m[3]}-${m[4]}` : (phone ?? '—');
}

export async function loadCallControlSettings(): Promise<CallControlSettings> {
  const db = systemDb();
  const res = await db.query(
    `SELECT enabled, dry_run, mirror_bitrix_user_id, last_processed_event_id
     FROM call_control_settings WHERE id = 1`
  );
  const r = res.rows[0];
  return {
    enabled: !!r?.enabled,
    dryRun: r ? !!r.dry_run : true,
    mirrorBitrixUserId: r?.mirror_bitrix_user_id || null,
    lastProcessedEventId: Number(r?.last_processed_event_id ?? 0),
  };
}

export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '—');
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

// Успешный исходящий = дозвонились (для резолва кейса). Порог 5с отсекает
// мгновенные сбросы, которые АТС всё равно репортит с duration 1-2с.
const SUCCESS_MIN_DURATION_SEC = 5;

// --- Синк из va.calls ---
const VA_EVENT_NAME = 'VA_CALLS_SYNC';
// Перекрытие окна курсора: строки с одинаковым created_at на границе не теряются,
// дубли отсекает unique (bitrix_call_id, event_name).
const VA_SYNC_OVERLAP_MS = 60_000;
// Сторожок свежести: порог отставания и рабочее окно МСК.
const VA_STALE_MINUTES = 60;
const WORK_HOURS_MSK: [number, number] = [9, 21];
let lastStaleWarnAt = 0; // in-memory антиспам (процесс на инстанс один)

function mskHour(): number {
  const msk = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' });
  return parseInt(msk.slice(11, 13), 10);
}

/** Перекладывает новые строки va.calls в call_events. Возвращает max(created_at) va. */
async function syncFromVaCalls(db: ReturnType<typeof systemDb>): Promise<Date | null> {
  const an = analyticsDb();
  const cur = await db.query(`SELECT va_sync_cursor FROM call_control_settings WHERE id = 1`);
  // Первый запуск: берём с текущего момента (историю не превращаем в эскалации).
  const cursor: Date = cur.rows[0]?.va_sync_cursor ?? new Date();

  const rows = await an.query(
    `SELECT bitrix_call_id, deal_id, manager_id, direction::text AS direction,
            result::text AS result, phone_number, duration_seconds, called_at, created_at
     FROM va.calls
     WHERE created_at > $1
     ORDER BY created_at
     LIMIT 2000`,
    [new Date(cursor.getTime() - VA_SYNC_OVERLAP_MS)]
  );

  let maxCreated: Date | null = null;
  for (const r of rows.rows) {
    const direction = r.direction === 'inbound' ? 'inbound' : r.direction === 'outbound' ? 'outbound' : null;
    // Правило «без сделки — игнор» здесь избыточно (в va.calls без сделки не бывает),
    // но подстрахуемся: пропущенным считаем только missed-входящий СО сделкой.
    const isMissed = direction === 'inbound' && r.result === 'missed' && r.deal_id != null;
    await db.query(
      `INSERT INTO call_events
         (event_name, bitrix_call_id, direction, call_type_raw, phone_normalized, phone_raw,
          manager_bitrix_user_id, duration_seconds, failed_code, is_missed_inbound,
          crm_deal_id, call_started_at, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (bitrix_call_id, event_name) WHERE bitrix_call_id IS NOT NULL DO NOTHING`,
      [
        VA_EVENT_NAME, r.bitrix_call_id, direction, null,
        normalizePhone(r.phone_number), r.phone_number,
        r.manager_id != null ? String(r.manager_id) : null,
        r.duration_seconds, r.result, isMissed, r.deal_id, r.called_at,
        JSON.stringify({ source: 'va.calls', result: r.result }),
      ]
    );
    maxCreated = r.created_at;
  }
  if (maxCreated) {
    await db.query(`UPDATE call_control_settings SET va_sync_cursor = $1, updated_at = now() WHERE id = 1`, [maxCreated]);
  }
  return maxCreated;
}

/** Сторожок: va.calls отстаёт > часа в рабочее время → warn в зеркало (раз в час). */
async function warnIfVaStale(mirrorBitrixUserId: string | null): Promise<void> {
  const h = mskHour();
  if (h < WORK_HOURS_MSK[0] || h >= WORK_HOURS_MSK[1]) return;
  if (Date.now() - lastStaleWarnAt < 60 * 60 * 1000) return;
  try {
    const an = analyticsDb();
    const res = await an.query(`SELECT max(created_at) AS last FROM va.calls`);
    const last: Date | null = res.rows[0]?.last ?? null;
    const staleMin = last ? Math.round((Date.now() - last.getTime()) / 60_000) : Infinity;
    if (staleMin <= VA_STALE_MINUTES) return;
    lastStaleWarnAt = Date.now();
    console.warn(`[callControl] va.calls отстаёт на ${staleMin} мин — бот слеп до восстановления пайплайна`);
    if (mirrorBitrixUserId) {
      await sendCallControlBotMessage(
        mirrorBitrixUserId,
        `[СТОРОЖОК] va.calls не обновлялась ${staleMin} мин (рабочее время). ` +
          `Пайплайн n8n, похоже, стоит — бот «Контроль звонков» не видит новые звонки, пропущенные копятся без уведомлений.`
      );
    }
  } catch (e) {
    console.warn('[callControl] сторожок свежести не отработал:', e instanceof Error ? e.message : e);
  }
}

// TTL сырых событий: вебхук может лить и лишние типы (CALLINIT/CALLSTART, CRM-события),
// БД system не должна расти бесконтрольно (требование Иосифа, 13.07). Кейсы/доставки
// не трогаем — это рабочая история бота, она на порядки меньше.
const EVENTS_TTL_DAYS = 7;

/** Полный цикл. Возвращает краткую сводку для лога. */
export async function runCallControlCycle(): Promise<string> {
  const db = systemDb();

  // Чистка ДО гейта enabled: события копятся вебхуком независимо от того, включён ли бот.
  await db.query(`DELETE FROM call_events WHERE received_at < now() - interval '${EVENTS_TTL_DAYS} days'`);

  const settings = await loadCallControlSettings();
  if (!settings.enabled) return 'disabled';

  // --- 0. Синк источника: va.calls → call_events. Падение Мишиной БД не роняет
  // цикл (уже принятые события продолжают эскалироваться), но сторожок доложит.
  try {
    await syncFromVaCalls(db);
  } catch (e) {
    console.warn('[callControl] синк va.calls не удался:', e instanceof Error ? e.message : e);
  }
  await warnIfVaStale(settings.mirrorBitrixUserId);

  // --- 1. Обработка новых событий (по курсору, в порядке id). Источник — ТОЛЬКО
  // синк va.calls; сырые вебхук-события лежат рядом как запасной канал и в кейсы
  // не попадают (иначе задвоение: один звонок = две записи с разными event_name).
  const events = await db.query(
    `SELECT id, direction, phone_normalized, manager_bitrix_user_id, duration_seconds,
            is_missed_inbound, crm_deal_id, call_started_at, received_at
     FROM call_events
     WHERE id > $1 AND event_name = '${VA_EVENT_NAME}' AND phone_normalized IS NOT NULL
     ORDER BY id
     LIMIT 2000`,
    [settings.lastProcessedEventId]
  );

  let opened = 0;
  let resolved = 0;
  for (const ev of events.rows) {
    const at: Date = ev.call_started_at ?? ev.received_at;
    if (ev.is_missed_inbound) {
      // Пропущенный входящий: открыть/пополнить кейс (телефон+менеджер).
      await db.query(
        `INSERT INTO call_control_cases
           (phone_normalized, manager_bitrix_user_id, deal_id, missed_count, first_missed_at, last_missed_at)
         VALUES ($1, $2, $3, 1, $4, $4)
         ON CONFLICT (phone_normalized, manager_bitrix_user_id) WHERE status = 'open'
         DO UPDATE SET
           missed_count = call_control_cases.missed_count + 1,
           last_missed_at = GREATEST(call_control_cases.last_missed_at, EXCLUDED.last_missed_at),
           deal_id = COALESCE(call_control_cases.deal_id, EXCLUDED.deal_id),
           updated_at = now()`,
        [ev.phone_normalized, ev.manager_bitrix_user_id ?? '', ev.crm_deal_id, at]
      );
      opened++;
    } else if (ev.direction === 'outbound') {
      // Любая попытка исходящего — обновляет таймер «без исходящего» по всем
      // открытым кейсам этого телефона (перезвонить может и коллега).
      await db.query(
        `UPDATE call_control_cases
         SET last_outgoing_at = GREATEST(COALESCE(last_outgoing_at, 'epoch'::timestamptz), $2), updated_at = now()
         WHERE phone_normalized = $1 AND status = 'open'`,
        [ev.phone_normalized, at]
      );
      // Успешный исходящий — резолвит кейсы по телефону.
      if ((ev.duration_seconds ?? 0) >= SUCCESS_MIN_DURATION_SEC) {
        const r = await db.query(
          `UPDATE call_control_cases
           SET status = 'resolved', resolved_at = $2, resolved_call_event_id = $3, updated_at = now()
           WHERE phone_normalized = $1 AND status = 'open'`,
          [ev.phone_normalized, at, ev.id]
        );
        resolved += r.rowCount ?? 0;
      }
    }
  }
  if (events.rows.length > 0) {
    await db.query(
      `UPDATE call_control_settings SET last_processed_event_id = $1, updated_at = now() WHERE id = 1`,
      [events.rows[events.rows.length - 1].id]
    );
  }

  // --- 2. Оценка правил по открытым кейсам ---
  const [rulesRes, templatesRes, casesRes] = await Promise.all([
    db.query(
      `SELECT id, sort_order, name, missed_count_gte, minutes_without_callback, operator,
              recipient, fixed_bitrix_user_id, template_id, is_active
       FROM call_control_rules WHERE is_active ORDER BY sort_order, id`
    ),
    db.query(`SELECT id, body FROM call_control_templates`),
    db.query(
      `SELECT id, phone_normalized, manager_bitrix_user_id, deal_id, missed_count,
              first_missed_at, last_missed_at, last_outgoing_at
       FROM call_control_cases WHERE status = 'open'`
    ),
  ]);
  const templateById = new Map<number, string>(templatesRes.rows.map((t) => [t.id, t.body]));
  const cases: CaseRow[] = casesRes.rows;
  if (cases.length === 0) return `events=${events.rows.length} opened+=${opened} resolved=${resolved} cases=0`;

  // Обогащение сделкой из Мишиной va.calls по номеру телефона (Bitrix-вебхук ссылку
  // на сделку не шлёт, а дёргать Bitrix REST запрещено — решение Иосифа 13.07).
  // va.calls наполняется с лагом в часы, поэтому: в первом уведомлении (30 мин)
  // сделки может не быть — она подтянется к моменту следующих эскалаций.
  const needDeal = cases.filter((c) => !c.deal_id);
  if (needDeal.length > 0) {
    try {
      const an = analyticsDb();
      const found = await an.query(
        `SELECT DISTINCT ON (phone_number) phone_number, deal_id
         FROM va.calls
         WHERE phone_number = ANY($1) AND deal_id IS NOT NULL
         ORDER BY phone_number, called_at DESC`,
        [needDeal.map((c) => c.phone_normalized)]
      );
      const dealByPhone = new Map<string, string>(found.rows.map((r) => [r.phone_number, String(r.deal_id)]));
      for (const c of needDeal) {
        const dealId = dealByPhone.get(c.phone_normalized);
        if (!dealId) continue;
        c.deal_id = dealId;
        await db.query(`UPDATE call_control_cases SET deal_id = $2, updated_at = now() WHERE id = $1`, [c.id, dealId]);
      }
    } catch (e) {
      // Недоступность Мишиной БД не должна останавливать эскалацию — шлём без сделки.
      console.warn('[callControl] обогащение сделкой из va.calls не удалось:', e instanceof Error ? e.message : e);
    }
  }

  // Оргиерархия одним запросом по всем менеджерам открытых кейсов.
  const managerIds = [...new Set(cases.map((c) => c.manager_bitrix_user_id).filter(Boolean))] as string[];
  const orgByManager = new Map<string, OrgRow>();
  if (managerIds.length > 0) {
    const org = await db.query(
      `SELECT manager_bitrix_user_id, manager_name, department_id, department_name,
              rop_bitrix_user_id, rop_name,
              department_director_bitrix_user_id, department_director_name,
              company_director_bitrix_user_id
       FROM org_resolved_hierarchy
       WHERE manager_bitrix_user_id = ANY($1) AND is_active`,
      [managerIds]
    );
    for (const row of org.rows) orgByManager.set(row.manager_bitrix_user_id, row);
  }

  // Ручные переопределения получателей по отделам (миграция 100): если для
  // (отдел менеджера, роль) назначен человек — шлём ему в обход оргструктуры.
  const overrides = await db.query(
    `SELECT department_id, role, bitrix_user_id FROM call_control_recipient_overrides`
  );
  const overrideByDeptRole = new Map<string, string>(
    overrides.rows.map((r) => [`${r.department_id}:${r.role}`, r.bitrix_user_id])
  );
  // Имена получателей для зеркала/доставок — тоже из org_resolved_hierarchy.
  const nameByUserId = new Map<string, string>();
  {
    const ids = new Set<string>();
    for (const o of orgByManager.values()) {
      for (const id of [o.rop_bitrix_user_id, o.department_director_bitrix_user_id, o.company_director_bitrix_user_id]) {
        if (id) ids.add(id);
      }
    }
    for (const id of overrideByDeptRole.values()) ids.add(id);
    for (const r of rulesRes.rows) if (r.fixed_bitrix_user_id) ids.add(r.fixed_bitrix_user_id);
    if (ids.size > 0) {
      const res = await db.query(
        `SELECT DISTINCT manager_bitrix_user_id, manager_name FROM org_resolved_hierarchy
         WHERE manager_bitrix_user_id = ANY($1)`,
        [[...ids]]
      );
      for (const r of res.rows) if (r.manager_name) nameByUserId.set(r.manager_bitrix_user_id, r.manager_name);
    }
  }

  const now = new Date();
  let sent = 0;
  for (const c of cases) {
    const org = c.manager_bitrix_user_id ? orgByManager.get(c.manager_bitrix_user_id) : undefined;
    const minutesSince = c.last_missed_at ? minutesBetween(c.last_missed_at, now) : 0;

    // Эффективные РОП/директор отдела менеджера: ручное назначение по отделу
    // (миграция 100) имеет приоритет НАД оргструктурой — и для маршрутизации,
    // и для плейсхолдеров {rop_name}/{director_name} (решение Иосифа 14.07).
    const deptOverride = (role: 'rop' | 'department_director') =>
      (org?.department_id && overrideByDeptRole.get(`${org.department_id}:${role}`)) || null;
    const effRopId = deptOverride('rop') ?? org?.rop_bitrix_user_id ?? null;
    const effRopName = deptOverride('rop')
      ? (nameByUserId.get(deptOverride('rop')!) ?? deptOverride('rop')!)
      : org?.rop_name ?? null;
    const effDirectorId = deptOverride('department_director') ?? org?.department_director_bitrix_user_id ?? null;
    const effDirectorName = deptOverride('department_director')
      ? (nameByUserId.get(deptOverride('department_director')!) ?? deptOverride('department_director')!)
      : org?.department_director_name ?? null;

    for (const rule of rulesRes.rows as Array<Record<string, unknown>>) {
      const missedGte = rule.missed_count_gte as number | null;
      const minutesGte = rule.minutes_without_callback as number | null;
      if (missedGte == null && minutesGte == null) continue; // пустое правило

      const condCount = missedGte == null ? null : c.missed_count >= missedGte;
      const condTime = minutesGte == null ? null : minutesSince >= minutesGte;
      const conds = [condCount, condTime].filter((v): v is boolean => v !== null);
      const fired = rule.operator === 'or' ? conds.some(Boolean) : conds.every(Boolean);
      if (!fired) continue;

      // Получатель по уровню правила (эффективные РОП/директор — см. выше).
      const kind = rule.recipient as CallControlRule['recipient'];
      let recipientId: string | null = null;
      if (kind === 'manager') recipientId = c.manager_bitrix_user_id;
      else if (kind === 'rop') recipientId = effRopId;
      else if (kind === 'department_director') recipientId = effDirectorId;
      else if (kind === 'company_director') recipientId = org?.company_director_bitrix_user_id ?? null;
      else if (kind === 'fixed') recipientId = (rule.fixed_bitrix_user_id as string | null) ?? null;

      const recipientName =
        (recipientId && nameByUserId.get(recipientId)) ||
        (kind === 'manager' ? org?.manager_name ?? null : null) ||
        recipientId || '—';

      const body = templateById.get(rule.template_id as number) ?? '';
      const message = renderTemplate(body, {
        manager_name: org?.manager_name ?? c.manager_bitrix_user_id ?? '—',
        department: org?.department_name ?? '—',
        rop_name: effRopName ?? '—',
        director_name: effDirectorName ?? '—',
        phone: formatPhoneDisplay(c.phone_normalized),
        deal_url: c.deal_id ? `${DEAL_URL_PREFIX}${c.deal_id}/` : '—',
        missed_count: String(c.missed_count),
        minutes: String(minutesSince),
        case_id: c.id,
        recipient_name: recipientName,
      });

      // UNIQUE (case_id, rule_id): правило по кейсу срабатывает один раз. Вставка
      // ДО отправки — при гонке двух тиков второй просто не пройдёт по конфликту.
      const ins = await db.query(
        `INSERT INTO call_control_deliveries
           (case_id, rule_id, recipient_kind, recipient_bitrix_user_id, recipient_name, message, dry_run)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (case_id, rule_id) DO NOTHING
         RETURNING id`,
        [c.id, rule.id, kind, recipientId, recipientName, message, settings.dryRun]
      );
      if (ins.rowCount === 0) continue; // уже слали

      let sendError: string | null = null;
      if (!settings.dryRun) {
        if (!recipientId || !body) {
          sendError = !body ? 'шаблон не задан' : 'получатель не разрешился (нет в оргструктуре)';
        } else {
          try {
            await sendCallControlBotMessage(recipientId, message);
            sent++;
          } catch (e) {
            sendError = e instanceof Error ? e.message : String(e);
          }
        }
      }

      // Зеркало-дубль (как у старого бота): и в dry_run тоже — это способ обкатки.
      let mirrored = false;
      if (settings.mirrorBitrixUserId) {
        const mirrorMsg =
          `[Дубль уведомления${settings.dryRun ? ', DRY RUN — получателю НЕ отправлено' : ''}]\n` +
          `Основной получатель: ${recipientName} (${kind})\nCase ID: ${c.id}\n\n${message}`;
        try {
          await sendCallControlBotMessage(settings.mirrorBitrixUserId, mirrorMsg);
          mirrored = true;
        } catch (e) {
          sendError = sendError ?? `зеркало: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      await db.query(
        `UPDATE call_control_deliveries SET mirrored = $2, error = $3 WHERE id = $1`,
        [ins.rows[0].id, mirrored, sendError]
      );
    }
  }

  return `events=${events.rows.length} opened+=${opened} resolved=${resolved} cases=${cases.length} sent=${sent}`;
}
