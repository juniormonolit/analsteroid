// Цикл обратной связи по журналу подсказок (задача 2765) — сердце фичи.
// Идёт по ВСЕМ открытым (active/contacted) строкам advice_log и решает, что с
// ними делать дальше: подтвердить успех, тихо закрыть или мягко напомнить.
// Тон строго «помощь, а не надзор» (правило брифа) — реального «ты не
// позвонил» тут НЕТ: закрытие без контакта/без сделки происходит МОЛЧА, менеджер
// получает пуш только на позитивных или нейтрально-напоминающих поводах.
//
// Источники истины (та же семантика, что features/customers/engine/customers.ts):
//  - «звонок был» = запись в va.calls на ЛЮБОЙ сделке клиента с called_at позже
//    advised_at (в JOIN sa.deals, funnel_id IN (0,1,2,3) — та же сегментация
//    клиента, что и во всём разделе «Мои заказчики»);
//  - «сделка ожила» = sold_at на любой сделке клиента позже advised_at (покрывает
//    и «появилась новая сделка», и «активная сделка перешла в продажу» — sold_at
//    проставляется ровно в момент перехода).
//
// Тик лёгкий (открытых строк — единицы на менеджера), гоняется чаще, чем сами
// дайджесты, чтобы подтверждение «как я и говорил» приходило скоро после
// реальной продажи, а не только на следующее утро.

import { analyticsDb, systemDb } from '@/lib/db/clients';
import { sendManagerBotMessage } from '@/features/badges/engine/notifications';
import { fetchDigestSettings, fetchManagerBotPrefs } from './managerDigest';

const REMINDER_INTERVAL_DAYS = 3;   // не чаще одного напоминания в 3 дня
const WATCH_DAYS_AFTER_CONTACT = 21; // сколько ждём сделку после «контакт был»
const COOLDOWN_DAYS = 30;            // не возвращаться к закрытой паре

interface OpenAdvice {
  id: string;
  manager_bitrix_id: number;
  client_key: string;
  client_type: 'contact' | 'company';
  client_name: string | null;
  recommended_group: string;
  status: 'active' | 'contacted';
  reminder_count: number;
  advised_at: string;
  last_nudge_at: string | null;
  contacted_at: string | null;
}

// Экспортированы для lib/jobs/ropAdviceFeedback.ts (задача 2769, дайджест РОПа):
// подсказка «крупный заказчик отдела без касания» проверяется ТЕМ ЖЕ фактом
// «звонок/продажа после совета», просто клиент атрибутирован не одному
// менеджеру, а отделу — сам факт («была ли продажа/звонок по client_key после
// timestamp») от получателя не зависит, повторного SQL не нужно.
export async function hasSaleSince(clientKey: string, sinceIso: string): Promise<boolean> {
  const res = await analyticsDb().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sa.deals d
      WHERE d.sold_at IS NOT NULL AND d.sold_at > $2 AND d.funnel_id IN (0,1,2,3)
        AND (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END) = $1`,
    [clientKey, sinceIso],
  );
  return Number(res.rows[0]?.n ?? '0') > 0;
}

export async function firstCallSince(clientKey: string, sinceIso: string): Promise<Date | null> {
  const res = await analyticsDb().query<{ first_call: string | Date | null }>(
    `SELECT min(c.called_at) AS first_call
       FROM va.calls c JOIN sa.deals d ON d.deal_id = c.deal_id
      WHERE c.called_at > $2 AND d.funnel_id IN (0,1,2,3)
        AND (CASE WHEN d.funnel_id IN (0,2) THEN 'c'||d.contact_id ELSE 'k'||d.company_id END) = $1`,
    [clientKey, sinceIso],
  );
  const v = res.rows[0]?.first_call;
  return v ? new Date(v) : null;
}

// Именительная метка перед двоеточием — не объект глагола (правка владельца
// 02.08: живые баги «позвонить Николай» — дательный падеж на произвольное ФИО
// из CRM склонять небезопасно — и скрытые родовые формы «созрел»/«он брал»,
// пол клиента нам неизвестен). «Клиент»/«компания» как generic-заглушка при
// отсутствии имени — грамматически муж.р. по умолчанию, это норма для
// родовых существительных в русском (как «менеджер», «сотрудник»), не
// привязано к реальному полу конкретного человека.
function label(row: OpenAdvice): string {
  const name = row.client_name ?? (row.client_type === 'contact' ? 'заказчик' : 'компания');
  return row.client_type === 'company' ? `«${name}»` : name;
}

function successMessage(row: OpenAdvice): string {
  return `🎉 Смотри-ка: ${label(row)} — интерес к «${row.recommended_group}» подтвердился! Как я и говорил! Кайф 😎`;
}
function nudgeMessage(row: OpenAdvice): string {
  // Мягкий тон (правка владельца 02.08): «клиент ещё ждёт, момент хороший» —
  // НЕ «ты не позвонил»/«почему не сделал». Предложение, а не укор.
  return `${label(row)}: момент всё ещё хороший, чтобы позвонить и предложить «${row.recommended_group}» 🙂`;
}

// Через sendManagerBotMessage (единая точка + рубильник dry-run + личные
// настройки подписки, см. features/badges/engine/notifications.ts и
// managerDigest.ts::fetchManagerBotPrefs). Применяется НЕМЕДЛЕННО — если
// менеджер выключил подсказки по заказчикам ПОСЛЕ того, как совет уже
// открыт, дальнейшие напоминания/подтверждение по нему всё равно
// формируются и логируются (для журнала/статистики), но не уходят.
async function sendMsg(bitrixId: number, message: string, msgType: 'advice_nudge' | 'advice_success', reason: string, decisionTrace: Record<string, unknown>): Promise<void> {
  const prefs = await fetchManagerBotPrefs(bitrixId);
  const suppressReason = !prefs.enabled ? 'manager_opted_out_all' : !prefs.adviceCustomers ? 'manager_opted_out_advice_customers' : null;
  await sendManagerBotMessage(bitrixId, message, msgType, reason, { suppressReason, decisionTrace });
}

export interface FeedbackTickStats {
  checked: number; success: number; contacted: number; reminded: number;
  closedNoContact: number; closedNoDeal: number; errors: number;
}

export async function runAdviceFeedbackTick(): Promise<FeedbackTickStats> {
  const stats: FeedbackTickStats = { checked: 0, success: 0, contacted: 0, reminded: 0, closedNoContact: 0, closedNoDeal: 0, errors: 0 };
  const settings = await fetchDigestSettings();
  const db = systemDb();

  const open = await db.query<OpenAdvice>(
    `SELECT id::text, manager_bitrix_id, client_key, client_type, client_name, recommended_group,
            status, reminder_count, advised_at, last_nudge_at, contacted_at
       FROM advice_log WHERE status IN ('active', 'contacted') AND test_run = false`,
  ).catch(() => ({ rows: [] as OpenAdvice[] }));

  const now = Date.now();
  for (const row of open.rows) {
    stats.checked++;
    try {
      // 1) Успех — приоритет над всем остальным, проверяем всегда.
      if (await hasSaleSince(row.client_key, row.advised_at)) {
        await db.query(
          `UPDATE advice_log SET status = 'success', resolved_at = now(), resolved_reason = 'deal_won' WHERE id = $1`,
          [row.id],
        );
        await sendMsg(row.manager_bitrix_id, successMessage(row), 'advice_success', `Подтверждение: ${row.client_name ?? row.client_key} → «${row.recommended_group}»`,
          { rule: 'sale_after_advice', adviceLogId: Number(row.id), clientKey: row.client_key, recommendedGroup: row.recommended_group, advisedAt: row.advised_at });
        stats.success++;
        continue;
      }

      if (row.status === 'active') {
        const firstCall = await firstCallSince(row.client_key, row.advised_at);
        if (firstCall) {
          await db.query(
            `UPDATE advice_log SET status = 'contacted', contacted_at = $2 WHERE id = $1`,
            [row.id, firstCall.toISOString()],
          );
          stats.contacted++;
          continue; // контакт был — в этом же тике напоминание уже не шлём
        }

        const sinceLastNudge = now - new Date(row.last_nudge_at ?? row.advised_at).getTime();
        const dueForAction = sinceLastNudge >= REMINDER_INTERVAL_DAYS * 86_400_000;
        if (!dueForAction) continue;

        if (row.reminder_count < settings.maxReminders) {
          await db.query(
            `UPDATE advice_log SET reminder_count = reminder_count + 1, last_nudge_at = now() WHERE id = $1`,
            [row.id],
          );
          await sendMsg(row.manager_bitrix_id, nudgeMessage(row), 'advice_nudge', `Напоминание: ${row.client_name ?? row.client_key} → «${row.recommended_group}»`,
            { rule: 'reminder_no_contact_yet', adviceLogId: Number(row.id), clientKey: row.client_key, reminderNumber: row.reminder_count + 1, maxReminders: settings.maxReminders, daysSinceAdvice: Math.round((now - new Date(row.advised_at).getTime()) / 86_400_000) });
          stats.reminded++;
        } else {
          // Лимит напоминаний исчерпан, контакта так и не было — тихо закрываем,
          // без сообщения (см. шапку файла: закрытие без контакта — не повод для пуша).
          await db.query(
            `UPDATE advice_log SET status = 'closed_no_contact', resolved_at = now(), resolved_reason = 'no_contact_timeout',
                    next_eligible_at = now() + ($2 || ' days')::interval WHERE id = $1`,
            [row.id, COOLDOWN_DAYS],
          );
          stats.closedNoContact++;
        }
      } else { // status === 'contacted': контакт уже был, дальше только тихо ждём сделку
        const sinceContact = now - new Date(row.contacted_at ?? row.advised_at).getTime();
        if (sinceContact >= WATCH_DAYS_AFTER_CONTACT * 86_400_000) {
          await db.query(
            `UPDATE advice_log SET status = 'closed_no_deal', resolved_at = now(), resolved_reason = 'no_deal_after_contact',
                    next_eligible_at = now() + ($2 || ' days')::interval WHERE id = $1`,
            [row.id, COOLDOWN_DAYS],
          );
          stats.closedNoDeal++;
        }
      }
    } catch (e) {
      stats.errors++;
      console.error(`[adviceFeedback] advice_log #${row.id} упал:`, e instanceof Error ? e.message : e);
    }
  }
  return stats;
}

/** Сводная статистика попаданий (для «Настройки → Геймификация → Дайджест»). */
export interface AdviceStats {
  total: number; success: number; closedNoContact: number; closedNoDeal: number; open: number;
  successRatePct: number | null;
}
export async function fetchAdviceStats(): Promise<AdviceStats> {
  const res = await systemDb().query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM advice_log WHERE test_run = false GROUP BY status`,
  ).catch(() => ({ rows: [] as { status: string; n: string }[] }));
  const byStatus = new Map(res.rows.map(r => [r.status, Number(r.n)]));
  const success = byStatus.get('success') ?? 0;
  const closedNoContact = byStatus.get('closed_no_contact') ?? 0;
  const closedNoDeal = byStatus.get('closed_no_deal') ?? 0;
  const open = (byStatus.get('active') ?? 0) + (byStatus.get('contacted') ?? 0);
  const total = success + closedNoContact + closedNoDeal + open;
  const resolved = success + closedNoContact + closedNoDeal;
  return { total, success, closedNoContact, closedNoDeal, open, successRatePct: resolved > 0 ? Math.round((success / resolved) * 100) : null };
}
