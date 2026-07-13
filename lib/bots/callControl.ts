// Бот «Контроль звонков» — порт missedcalls-робота в Монолитику (задача Иосифа, 13.07).
// Данные: call_events (наш приём исходящего вебхука Bitrix, /api/telephony/webhook),
// НЕ va.calls — Мишин пайплайн наполняет её с многочасовым лагом, а SLA здесь минутные.
// Цикл (тик раз в минуту из instrumentation.ts, Redis-замок):
//   новые события → кейсы (телефон+менеджер) → резолв успешным исходящим →
//   оценка правил (кол-во пропущенных / минуты без перезвона / И-ИЛИ) →
//   рендер кастомного шаблона → отправка ботом Bitrix «Контроль звонков» (BOT_ID 15010).
// Гардрейлы: enabled (выкл из коробки), dry_run (по умолчанию), зеркало-дубль.

import { systemDb } from '@/lib/db/clients';
import { sendCallControlBotMessage } from '@/lib/bitrix/notify';

export const DEAL_URL_PREFIX = 'https://td.monolit-crm.ru/crm/deal/details/';

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
  rop_bitrix_user_id: string | null;
  department_director_bitrix_user_id: string | null;
  company_director_bitrix_user_id: string | null;
}

// Телефон к каноническому виду: только цифры, 8XXXXXXXXXX → 7XXXXXXXXXX, префикс '+'.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  return `+${digits}`;
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

/** Полный цикл. Возвращает краткую сводку для лога. */
export async function runCallControlCycle(): Promise<string> {
  const db = systemDb();
  const settings = await loadCallControlSettings();
  if (!settings.enabled) return 'disabled';

  // --- 1. Обработка новых событий (по курсору, в порядке id) ---
  const events = await db.query(
    `SELECT id, direction, phone_normalized, manager_bitrix_user_id, duration_seconds,
            is_missed_inbound, crm_deal_id, call_started_at, received_at
     FROM call_events
     WHERE id > $1 AND phone_normalized IS NOT NULL
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

  // Оргиерархия одним запросом по всем менеджерам открытых кейсов.
  const managerIds = [...new Set(cases.map((c) => c.manager_bitrix_user_id).filter(Boolean))] as string[];
  const orgByManager = new Map<string, OrgRow>();
  if (managerIds.length > 0) {
    const org = await db.query(
      `SELECT manager_bitrix_user_id, manager_name, rop_bitrix_user_id,
              department_director_bitrix_user_id, company_director_bitrix_user_id
       FROM org_resolved_hierarchy
       WHERE manager_bitrix_user_id = ANY($1) AND is_active`,
      [managerIds]
    );
    for (const row of org.rows) orgByManager.set(row.manager_bitrix_user_id, row);
  }
  // Имена получателей для зеркала/доставок — тоже из org_resolved_hierarchy.
  const nameByUserId = new Map<string, string>();
  {
    const ids = new Set<string>();
    for (const o of orgByManager.values()) {
      for (const id of [o.rop_bitrix_user_id, o.department_director_bitrix_user_id, o.company_director_bitrix_user_id]) {
        if (id) ids.add(id);
      }
    }
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

    for (const rule of rulesRes.rows as Array<Record<string, unknown>>) {
      const missedGte = rule.missed_count_gte as number | null;
      const minutesGte = rule.minutes_without_callback as number | null;
      if (missedGte == null && minutesGte == null) continue; // пустое правило

      const condCount = missedGte == null ? null : c.missed_count >= missedGte;
      const condTime = minutesGte == null ? null : minutesSince >= minutesGte;
      const conds = [condCount, condTime].filter((v): v is boolean => v !== null);
      const fired = rule.operator === 'or' ? conds.some(Boolean) : conds.every(Boolean);
      if (!fired) continue;

      // Получатель по уровню правила.
      const kind = rule.recipient as CallControlRule['recipient'];
      let recipientId: string | null = null;
      if (kind === 'manager') recipientId = c.manager_bitrix_user_id;
      else if (kind === 'rop') recipientId = org?.rop_bitrix_user_id ?? null;
      else if (kind === 'department_director') recipientId = org?.department_director_bitrix_user_id ?? null;
      else if (kind === 'company_director') recipientId = org?.company_director_bitrix_user_id ?? null;
      else if (kind === 'fixed') recipientId = (rule.fixed_bitrix_user_id as string | null) ?? null;

      const recipientName =
        (recipientId && nameByUserId.get(recipientId)) ||
        (kind === 'manager' ? org?.manager_name ?? null : null) ||
        recipientId || '—';

      const body = templateById.get(rule.template_id as number) ?? '';
      const message = renderTemplate(body, {
        manager_name: org?.manager_name ?? c.manager_bitrix_user_id ?? '—',
        phone: c.phone_normalized,
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
