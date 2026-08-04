// Ядро пина на денежные операции (задача #2995), спека:
// owners-inbox/monolitika-pin-code-spec.md (ревизия 2, автор Глеб, AppSec).
// Не отклоняться от спеки без согласования с автором.
//
// Хранение: bcrypt(HMAC-SHA256(pin, PIN_PEPPER), cost 12) в users.pin_hash.
// Без PIN_PEPPER в env фича полностью выключена (pinFeatureEnabled()) — это
// блокирующая зависимость: порядок выката ВСЕГДА env+рестарт, потом миграция
// 141_wallet_pin.sql, потом код (спека §1/§9).
//
// НИКОГДА не логировать: сам пин, введённое значение, хеш, перец (спека §7).

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import type { Pool, PoolClient } from 'pg';
import { createNotification, pushViaAnalitik } from '@/features/badges/engine/notifications';

const MSK = 'Europe/Moscow';
const PIN_RE = /^\d{4}$/;

// ── чёрный список пинов (спека §2, ~26% реально используемых пинов) ─────────
// «Топ-20 популярных» — общеизвестная агрегированная статистика утёкших PIN
// (пересекается с уже названными в спеке паттернами — совпадения намеренны).
const TOP20_POPULAR = [
  '1234', '1111', '0000', '1212', '7777', '1004', '2000', '4444', '2222', '6969',
  '9999', '3333', '5555', '6666', '1122', '1313', '8888', '4321', '2001', '1010',
];
function buildBlacklist(): Set<string> {
  const s = new Set<string>(TOP20_POPULAR);
  for (let d = 0; d <= 9; d++) s.add(String(d).repeat(4)); // четыре одинаковые цифры
  s.add('1234'); s.add('4321');
  s.add('1122'); s.add('1212'); s.add('1313'); s.add('1010');
  for (let y = 1900; y <= 1999; y++) s.add(String(y)); // «похожее на год»
  for (let y = 2000; y <= 2099; y++) s.add(String(y));
  return s;
}
const PIN_BLACKLIST = buildBlacklist();

/** null = пин ок; иначе текст ошибки для UI. */
export function pinFormatError(pin: string): string | null {
  if (!PIN_RE.test(pin)) return 'Пин — ровно 4 цифры';
  if (PIN_BLACKLIST.has(pin)) return 'Слишком простой пин — выберите другой';
  return null;
}

// ── перец и фича-гейт (спека §1) ─────────────────────────────────────────────

export function pinFeatureEnabled(): boolean {
  return !!process.env.PIN_PEPPER;
}

function hmacPin(pin: string): string {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper) throw new Error('PIN_PEPPER не задан в env — фича пина выключена');
  return crypto.createHmac('sha256', pepper).update(pin).digest('hex');
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(hmacPin(pin), 12);
}

// Захолощенный хеш (cost 12), захардкожен — «проверка при pin_hash IS NULL
// всё равно выполняет холостой bcrypt.compare, иначе по времени ответа видно,
// у кого пин не заведён» (спека §2). Фиксированная строка = одинаковое время
// сравнения при каждом заходе, без затрат на пересчёт на старте процесса.
const DUMMY_PIN_HASH = '$2b$12$UJWta5/6UPxYtKwpR603De.b.mRZDfW453augDsK9Y3ZkKS3.RTE.';

// ── IP клиента (спека §7, «проверить у Артёма») ──────────────────────────────
// Прод и дев стоят за Caddy (`reverse_proxy`), который сам проставляет
// X-Forwarded-For на каждый апстрим-запрос — на этом хосте Caddy является
// крайней точкой (слушает 80/443 напрямую, ss -tlnp подтверждён), второго
// прокси перед ним нет. Читать первый (левый) адрес — это оригинальный клиент,
// Caddy дописывает себя справа.
export function getClientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return null;
}

export function getUserAgent(req: NextRequest): string | null {
  return req.headers.get('user-agent');
}

// ── лимиты попыток (спека §2): 3+3+3 = 9 попыток на 10 000 комбинаций ───────
const LOCK_STAGE_MIN: (number | null)[] = [15, 60, null]; // null = постоянно (до сброса админом)
const ATTEMPTS_PER_STAGE = 3;

export interface PinActorCtx {
  userId: string;              // users.id
  bitrixId: number | null;
  login: string;
  surface: 'web' | 'bx_iframe' | 'pwa';
  ip: string | null;
  userAgent: string | null;
}

export function actorFromSession(
  session: { id: string; bitrixUserId: string | null; login: string },
  req: NextRequest,
): PinActorCtx {
  return {
    userId: session.id,
    bitrixId: session.bitrixUserId ? Number(session.bitrixUserId) : null,
    login: session.login,
    surface: req.headers.get('x-bitrix-iframe') === '1' ? 'bx_iframe' : 'web',
    ip: getClientIp(req),
    userAgent: getUserAgent(req),
  };
}

export interface PinEventMeta {
  operation: string;
  targetRef?: string | null;
  amount?: number | null;
  currency?: 'EBALL' | 'RUB' | null;
  thresholdBefore?: number | null;
  thresholdAfter?: number | null;
}

export type PinVerifyResult =
  | { ok: true; pinEventId: number }
  | { ok: false; status: 400 | 403 | 423 | 428 | 503; error: string };

function fmtMskTime(d: Date): string {
  return d.toLocaleString('ru-RU', { timeZone: MSK, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

async function logEvent(db: Pool | PoolClient, actor: PinActorCtx, event: string, meta: PinEventMeta): Promise<number> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO wallet_pin_events
       (user_id, bitrix_id, event, operation, target_ref, amount, currency,
        threshold_before, threshold_after, surface, ip, user_agent, actor_login)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [actor.userId, actor.bitrixId, event, meta.operation || null, meta.targetRef ?? null,
      meta.amount ?? null, meta.currency ?? null, meta.thresholdBefore ?? null, meta.thresholdAfter ?? null,
      actor.surface, actor.ip, actor.userAgent, actor.login],
  );
  return Number(r.rows[0].id);
}

/**
 * Проверка пина + счётчик попыток атомарно в СВОЕЙ транзакции на СВОЁМ
 * клиенте. Вызывать ДО открытия денежной транзакции — иначе ROLLBACK денежной
 * операции стёр бы инкремент счётчика неудачи (спека §2, ключевая ловушка).
 */
export async function verifyPin(
  systemDb: Pool, actor: PinActorCtx, submittedPin: unknown, meta: PinEventMeta,
): Promise<PinVerifyResult> {
  if (!pinFeatureEnabled()) {
    return { ok: false, status: 503, error: 'Подтверждение пином временно недоступно' };
  }

  // ВАЖНО: проверка pin_hash IS NULL идёт ДО валидации формата введённого пина.
  // Первый запрос операции с фронта всегда уходит БЕЗ поля pin (клиент ещё не
  // знает, нужен ли он) — если сначала отбраковывать по формату, pin_hash IS
  // NULL никогда не будет замечен на этом первом заходе, и фронт откроет
  // диалог ВВОДА пина вместо диалога УСТАНОВКИ (в системе просто нет пина).
  const client = await systemDb.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{
      pin_hash: string | null; pin_fail_count: number; pin_lock_level: number; pin_locked_until: Date | null;
    }>(
      `SELECT pin_hash, pin_fail_count, pin_lock_level, pin_locked_until FROM users WHERE id = $1 FOR UPDATE`,
      [actor.userId],
    );
    if (row.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, status: 400, error: 'Пользователь не найден' }; }
    const u = row.rows[0];

    if (u.pin_hash === null) {
      // Холостой bcrypt.compare даже без валидного пина на входе — тайминг
      // ответа не должен отличаться от случая с валидным форматом (спека §2).
      const dummyInput = typeof submittedPin === 'string' && PIN_RE.test(submittedPin) ? submittedPin : '0000';
      await bcrypt.compare(hmacPin(dummyInput), DUMMY_PIN_HASH);
      await client.query('ROLLBACK');
      return { ok: false, status: 428, error: 'Пин не установлен' };
    }

    if (typeof submittedPin !== 'string' || !PIN_RE.test(submittedPin)) {
      await client.query('ROLLBACK');
      return { ok: false, status: 400, error: 'Введите 4-значный пин' };
    }

    if (u.pin_locked_until && new Date(u.pin_locked_until).getTime() > Date.now()) {
      await client.query('ROLLBACK');
      const permanent = u.pin_lock_level >= 3;
      return {
        ok: false, status: 423,
        error: permanent
          ? 'Пин заблокирован. Если это не вы — смените пароль и позовите администратора.'
          : `Пин заблокирован до ${fmtMskTime(new Date(u.pin_locked_until))}. Если это не вы — смените пароль и позовите администратора.`,
      };
    }

    const match = await bcrypt.compare(hmacPin(submittedPin), u.pin_hash);
    if (match) {
      await client.query(
        `UPDATE users SET pin_fail_count = 0, pin_lock_level = 0, pin_locked_until = NULL WHERE id = $1`,
        [actor.userId],
      );
      const id = await logEvent(client, actor, 'verify_ok', meta);
      await client.query('COMMIT');
      return { ok: true, pinEventId: id };
    }

    // Неверный пин. 24ч без ошибок обнуляют накопленный счётчик стадии
    // (спека §2: «счётчик обнуляется... через 24ч без ошибок»).
    let failCount = u.pin_fail_count;
    if (failCount > 0) {
      const last = await client.query<{ at: Date | null }>(
        `SELECT max(created_at) AS at FROM wallet_pin_events WHERE user_id = $1 AND event = 'verify_fail'`,
        [actor.userId],
      );
      const lastAt = last.rows[0]?.at ? new Date(last.rows[0].at).getTime() : 0;
      if (Date.now() - lastAt > 24 * 3600 * 1000) failCount = 0;
    }
    failCount += 1;

    if (failCount < ATTEMPTS_PER_STAGE) {
      await client.query(`UPDATE users SET pin_fail_count = $2 WHERE id = $1`, [actor.userId, failCount]);
      await logEvent(client, actor, 'verify_fail', meta);
      await client.query('COMMIT');
      const left = ATTEMPTS_PER_STAGE - failCount;
      return { ok: false, status: 403, error: `Неверный пин. Осталась ${left} попытк${left === 1 ? 'а' : 'и'}` };
    }

    // Третий промах текущей стадии — лок следующего уровня.
    const stage = Math.min(u.pin_lock_level, LOCK_STAGE_MIN.length - 1);
    const minutes = LOCK_STAGE_MIN[stage];
    const newLevel = Math.min(u.pin_lock_level + 1, 3);
    const lockedUntilParam = minutes === null ? 'infinity' : new Date(Date.now() + minutes * 60_000).toISOString();
    await client.query(
      `UPDATE users SET pin_fail_count = 0, pin_lock_level = $2, pin_locked_until = $3::timestamptz WHERE id = $1`,
      [actor.userId, newLevel, lockedUntilParam],
    );
    await logEvent(client, actor, 'verify_fail', meta);
    await logEvent(client, actor, 'locked', meta);
    const permanent = minutes === null;
    const lockTitle = permanent ? 'Пин заблокирован — обратитесь к администратору' : `Пин заблокирован на ${minutes} мин`;
    const lockBody = 'Три неверных попытки подряд. Если это были не вы — смените пароль аккаунта.';
    if (actor.bitrixId !== null) {
      await createNotification(client, { bitrixId: actor.bitrixId, type: 'pin_locked', title: lockTitle, body: lockBody, link: '/profile' });
    }
    await client.query('COMMIT');
    // Пуш «Аналитиком» — ПОСЛЕ коммита, best-effort (спека §2: «одновременно
    // запись в notifications и пуш «Аналитиком»» — на переходе в лок).
    if (actor.bitrixId !== null) void pushViaAnalitik(actor.bitrixId, `🔒 ${lockTitle}`, lockBody);
    return {
      ok: false, status: 423,
      error: permanent
        ? 'Пин заблокирован. Если это не вы — смените пароль и позовите администратора.'
        : `Пин заблокирован на ${minutes} мин. Если это не вы — смените пароль и позовите администратора.`,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── порог + суточный потолок (спека §4) ──────────────────────────────────────

const DAILY_CAP_MLT = 150;
const DEFAULT_THRESHOLD_MLT = 30;
// Источники «трачу на себя внутри системы» — единственные, кого касается
// личный порог и суточный потолок (спека §3/§4). Всё остальное денежное —
// всегда с пином, вне зависимости от порога.
const SELF_SPEND_SOURCES = ['shop_purchase', 'gacha_spin', 'quest_reroll', 'quest_extra'];

export interface SpendPinRequirement {
  required: boolean;
  reason: 'under_threshold' | 'threshold' | 'daily_cap';
  thresholdMlt: number;
}

/**
 * Требуется ли пин на трату amountMlt ебаллов на СЕБЯ (магазин/гача/реролл/
 * докуп квеста). RUB и всё «наружу» сюда не идёт — там пин всегда, отдельная
 * ветка в самих роутах (alwaysRequired), эта функция их не рассматривает.
 * Ключ — bitrixId (users.bitrix_user_id уникален и обязателен для любой
 * денежной операции — см. проверку session.bitrixUserId в каждом роуте),
 * так функцию можно звать и из движков (gacha/quests), где под рукой обычно
 * только bitrixId, без лишнего трипа за users.id.
 */
export async function spendPinRequirement(
  db: Pool | PoolClient, bitrixId: number, amountMlt: number,
): Promise<SpendPinRequirement> {
  const u = await db.query<{ pin_threshold_mlt: number }>(
    `SELECT pin_threshold_mlt FROM users WHERE bitrix_user_id = $1::text`, [String(bitrixId)],
  );
  const thresholdMlt = u.rows[0]?.pin_threshold_mlt ?? DEFAULT_THRESHOLD_MLT;
  if (amountMlt >= thresholdMlt) return { required: true, reason: 'threshold', thresholdMlt };

  const spentToday = await db.query<{ s: string }>(
    `SELECT coalesce(sum(-amount), 0) AS s FROM badge_coin_ledger
      WHERE bitrix_id = $1 AND currency = 'EBALL' AND amount < 0 AND pin_event_id IS NULL
        AND source = ANY($2::text[])
        AND created_at >= date_trunc('day', now() AT TIME ZONE '${MSK}') AT TIME ZONE '${MSK}'`,
    [bitrixId, SELF_SPEND_SOURCES],
  );
  const alreadySpent = Number(spentToday.rows[0]?.s ?? 0);
  if (alreadySpent + amountMlt > DAILY_CAP_MLT) return { required: true, reason: 'daily_cap', thresholdMlt };
  return { required: false, reason: 'under_threshold', thresholdMlt };
}

// ── заморозка после set/change/reset (спека §5) ──────────────────────────────

export async function isOutboundFrozen(db: Pool | PoolClient, bitrixId: number): Promise<Date | null> {
  const r = await db.query<{ pin_freeze_until: Date | null }>(
    `SELECT pin_freeze_until FROM users WHERE bitrix_user_id = $1::text`, [String(bitrixId)],
  );
  const until = r.rows[0]?.pin_freeze_until ?? null;
  return until && new Date(until).getTime() > Date.now() ? new Date(until) : null;
}

export function frozenMessage(until: Date): string {
  return `Вывод ценности наружу временно заморожен до ${fmtMskTime(until)} (после недавнего сброса/смены пина). Покупки для себя доступны.`;
}

// ── PIN_PEPPER ротация / состояние для UI (GET /api/me, /api/me/pin) ────────

export interface PinState {
  pinSet: boolean;
  pinThresholdMlt: number;
  pinLockedUntil: string | null;
  pinFreezeUntil: string | null;
  pinLockLevel: number;
}

export async function getPinState(db: Pool | PoolClient, userId: string): Promise<PinState> {
  const r = await db.query<{
    pin_hash: string | null; pin_threshold_mlt: number; pin_locked_until: Date | null;
    pin_freeze_until: Date | null; pin_lock_level: number;
  }>(
    `SELECT pin_hash, pin_threshold_mlt, pin_locked_until, pin_freeze_until, pin_lock_level FROM users WHERE id = $1`,
    [userId],
  );
  const u = r.rows[0];
  return {
    pinSet: !!u?.pin_hash,
    pinThresholdMlt: u?.pin_threshold_mlt ?? DEFAULT_THRESHOLD_MLT,
    pinLockedUntil: u?.pin_locked_until && new Date(u.pin_locked_until).getTime() > Date.now() ? new Date(u.pin_locked_until).toISOString() : null,
    pinFreezeUntil: u?.pin_freeze_until && new Date(u.pin_freeze_until).getTime() > Date.now() ? new Date(u.pin_freeze_until).toISOString() : null,
    pinLockLevel: u?.pin_lock_level ?? 0,
  };
}

export const PIN_DEFAULT_THRESHOLD_MLT = DEFAULT_THRESHOLD_MLT;
export const PIN_DAILY_CAP_MLT = DAILY_CAP_MLT;
export const PIN_FREEZE_HOURS = 24;
