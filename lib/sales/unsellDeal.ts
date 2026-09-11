// «Снять с продажи» (задача #6260, санкция Серёги 11.09) — ручная очистка sold_at
// у сделки, ошибочно поставленной в продажу (сегодня Маркус чистил 252311 руками).
//
// ВАЖНО (решение владельца 11.09): sold_at залипает НАМЕРЕННО — защита рейтинга
// от накрутки. Автоочистки нет и не будет НИГДЕ в коде. Единственный путь —
// это ручное действие: право директор+ (action.deals.unsell), обязательная
// причина, запись в sa.manual_fixes (migrations/sa_org/004_manual_fixes.sql),
// и только если сделка СЕЙЧАС не в стадии продажи/отгрузки (event_type sold/shipped)
// — иначе она бы тут же «продалась» обратно первым же снимком стадии. Обратной
// кнопки «вернуть sold_at» тоже нет — нельзя «продать» сделку повторно кликом,
// это должно происходить только через реальный переход стадии в Битриксе.
//
// Логика намеренно вынесена из app/api/* в чистый модуль — permission-гейт и
// stage-guard тестируются без БД (см. scripts/assert-unsell-deal.ts), тем же
// приёмом, что scripts/assert-report-engine.ts тестирует движок отчётов.

import { randomUUID } from 'node:crypto';
import { analyticsDb } from '@/lib/db/clients';
import { invalidateReports } from '@/lib/cache/redis';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { hasPerm } from '@/lib/auth/perms';
import type { SessionUser } from '@/lib/auth/session';
import { fetchDealsByIds, type HydratedDeal } from '@/lib/reports/dealsByIds';

export const UNSELL_PERM = 'action.deals.unsell' as const;

/** Тот же гейт, что у остальных пунктов «Ещё» (задача Иосифа 10.09): админ
 * (hasFullManagerAccess — супер-админ/«Администратор») ИЛИ явное право роли.
 * По умолчанию право НЕ выдано ни одной роли — владелец выдаёт его ролям
 * уровня «Директор»+ через «Настройки → Матрица прав» (паттерн
 * action.subscriptions.view_all, задача 2765). РОП без явной выдачи — не проходит. */
export function canUnsellDeal(session: SessionUser | null): boolean {
  if (!session) return false;
  return hasFullManagerAccess(session) || hasPerm(session, UNSELL_PERM);
}

// Стадии, в которых сделка СЕЙЧАС считается проданной/отгруженной — снятие
// запрещено, пока сделку не перевели в другую стадию в Битриксе (иначе первый
// же пересчёт стадии тут же вернёт ей sold_at, и «снятие» окажется фикцией).
const LOCKED_EVENT_TYPES = new Set(['sold', 'shipped']);

export interface UnsellGuardInput {
  sold_at: string | null;
  stage_event_type: string | null;
  stage_name: string | null;
}

export type UnsellGuardResult = { ok: true } | { ok: false; reason: string };

export function checkUnsellable(deal: UnsellGuardInput): UnsellGuardResult {
  if (!deal.sold_at) {
    return { ok: false, reason: 'У сделки уже нет даты продажи (sold_at пуст) — снимать нечего.' };
  }
  if (deal.stage_event_type && LOCKED_EVENT_TYPES.has(deal.stage_event_type)) {
    return {
      ok: false,
      reason: `Сделка сейчас в стадии «${deal.stage_name ?? deal.stage_event_type}» — это стадия продажи/отгрузки. `
        + 'Сначала переведите сделку в другую стадию в Битриксе, потом снимайте sold_at.',
    };
  }
  return { ok: true };
}

/** Карточка сделки для поиска на странице — та же гидратация, что у дриллдауна
 * графиков (lib/reports/dealsByIds.ts), поэтому поля/названия совпадают с
 * остальным приложением 1-в-1 вместо повторного SQL. */
export async function lookupDeal(dealId: number): Promise<HydratedDeal | null> {
  if (!Number.isFinite(dealId) || dealId <= 0) return null;
  const { deals } = await fetchDealsByIds([dealId], 'kc');
  return deals[0] ?? null;
}

export interface ManualFixRow {
  id: string;
  deal_id: number;
  deal_name: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  reason: string;
  user_id: string;
  user_name: string;
  created_at: string;
}

export async function listManualFixes(limit = 50): Promise<ManualFixRow[]> {
  const db = analyticsDb();
  const res = await db.query<ManualFixRow>(
    `SELECT mf.id::text AS id, mf.deal_id, d.deal_name, mf.field, mf.old_value, mf.new_value,
            mf.reason, mf.user_id, mf.user_name, mf.created_at::text AS created_at
       FROM sa.manual_fixes mf
       LEFT JOIN deals d ON d.deal_id = mf.deal_id
      ORDER BY mf.created_at DESC
      LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)],
  );
  return res.rows;
}

export type PerformUnsellResult =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 400; error: string };

export async function performUnsell(params: {
  dealId: number;
  reason: string;
  userId: string;
  userName: string;
}): Promise<PerformUnsellResult> {
  const reason = params.reason.trim();
  if (!reason) return { ok: false, status: 400, error: 'Укажите причину — без неё снять нельзя.' };
  if (!Number.isFinite(params.dealId) || params.dealId <= 0) {
    return { ok: false, status: 400, error: 'Некорректный номер сделки.' };
  }

  const db = analyticsDb();
  const dealRes = await db.query<{ sold_at: string | null; event_type: string | null; stage_name: string | null }>(
    `SELECT d.sold_at::text AS sold_at, s.event_type, s.name AS stage_name
       FROM deals d
       LEFT JOIN stages s ON s.id = d.stage_id
      WHERE d.deal_id = $1`,
    [params.dealId],
  );
  if (!dealRes.rows.length) return { ok: false, status: 404, error: 'Сделка не найдена.' };
  const row = dealRes.rows[0];

  const guard = checkUnsellable({ sold_at: row.sold_at, stage_event_type: row.event_type, stage_name: row.stage_name });
  if (!guard.ok) return { ok: false, status: 409, error: guard.reason };

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE deals SET sold_at = NULL WHERE deal_id = $1`, [params.dealId]);
    await client.query(
      `INSERT INTO sa.manual_fixes (id, deal_id, field, old_value, new_value, reason, user_id, user_name)
       VALUES ($1, $2, 'sold_at', $3, NULL, $4, $5, $6)`,
      [randomUUID(), params.dealId, row.sold_at, reason, params.userId, params.userName],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // Не роняем запрос, если Redis недоступен — отчёты отдадут неинвалидированный
  // кэш до TTL, это не критично; критично — что sold_at и журнал уже записаны.
  await invalidateReports().catch(() => {});

  return { ok: true };
}
