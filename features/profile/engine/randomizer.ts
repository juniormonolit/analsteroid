// Рандомайзер косметики профиля (задача 63, п.1; миграция 169).
//
// Механика по сути вторая гача, поэтому три ограничителя заложены сразу, а не
// «добавим, если начнут злоупотреблять»: цена прокрута, лимит в день и
// закрепление понравившегося. Без закрепления единственной стратегией было бы
// «крутить, пока не выпадет идеальное» — и лимит в день превратился бы в
// растянутый на неделю тот же бесконечный прокрут.
//
// Деньги идут через `badge_coin_ledger` (source='cosmetic_roll'/'cosmetic_pin'),
// как и покупка обычной косметики: дашборд экономики обязан видеть эти траты,
// а не считать их мимо кассы.

import type { Pool, PoolClient } from 'pg';
import { makeGeneratedId, newSeed, type GenKind } from '@/lib/profile/generated';

export interface RandomizerSettings {
  rollPrice: number; rollsPerDay: number; keepUnpinned: number; pinPrice: number;
}

export async function loadRandomizerSettings(db: Pool | PoolClient): Promise<RandomizerSettings> {
  try {
    const r = await db.query<{ roll_price: number; rolls_per_day: number; keep_unpinned: number; pin_price: number }>(
      `SELECT roll_price, rolls_per_day, keep_unpinned, pin_price FROM cosmetic_randomizer_settings WHERE id = 1`,
    );
    const x = r.rows[0];
    return {
      rollPrice: Number(x?.roll_price ?? 40), rollsPerDay: Number(x?.rolls_per_day ?? 5),
      keepUnpinned: Number(x?.keep_unpinned ?? 6), pinPrice: Number(x?.pin_price ?? 100),
    };
  } catch {
    return { rollPrice: 40, rollsPerDay: 5, keepUnpinned: 6, pinPrice: 100 };
  }
}

export interface GeneratedRow { id: number; kind: GenKind; cosmeticId: string; pinned: boolean; createdAt: string }

export async function fetchMyGenerated(db: Pool | PoolClient, mgr: number): Promise<GeneratedRow[]> {
  try {
    const r = await db.query<{ id: string; kind: GenKind; cosmetic_id: string; pinned: boolean; created_at: string }>(
      `SELECT id, kind, cosmetic_id, pinned, created_at FROM profile_generated_cosmetics
        WHERE bitrix_id = $1 ORDER BY pinned DESC, created_at DESC`,
      [mgr],
    );
    return r.rows.map(x => ({
      id: Number(x.id), kind: x.kind, cosmeticId: x.cosmetic_id, pinned: x.pinned,
      createdAt: new Date(x.created_at).toISOString(),
    }));
  } catch { return []; }
}

/** Сколько прокрутов сделано сегодня (МСК) — лимит считается по календарным
 *  суткам, а не по «последним 24 часам»: человеку понятно «сегодня 5», а не
 *  «освободится в 18:42». */
async function rollsToday(db: PoolClient, mgr: number): Promise<number> {
  const r = await db.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM profile_generated_cosmetics
      WHERE bitrix_id = $1
        AND (created_at AT TIME ZONE 'Europe/Moscow')::date = (now() AT TIME ZONE 'Europe/Moscow')::date`,
    [mgr],
  );
  return Number(r.rows[0].c);
}

export type RollResult =
  | { ok: true; cosmeticId: string; kind: GenKind; price: number; rollsLeft: number }
  | { ok: false; error: string };

export async function rollCosmetic(
  db: Pool, mgr: number, kind: GenKind, actorLogin: string,
): Promise<RollResult> {
  const s = await loadRandomizerSettings(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const used = await rollsToday(client, mgr);
    if (used >= s.rollsPerDay) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Сегодня уже ${used} прокрутов из ${s.rollsPerDay}. Завтра снова.` };
    }
    const bal = await client.query<{ b: string }>(
      `SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id = $1`, [mgr]);
    if (Number(bal.rows[0]?.b ?? 0) < s.rollPrice) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Не хватает MLT: прокрут стоит ${s.rollPrice}` };
    }

    // Сид не должен повторить уже выпавший этому человеку — иначе он платит за
    // то, что у него уже есть. Три попытки: при 16 млн вариантов этого хватает
    // с колоссальным запасом, а бесконечный цикл в транзакции недопустим.
    let cosmeticId = '';
    for (let i = 0; i < 3; i++) {
      const candidate = makeGeneratedId(kind, newSeed());
      const dup = await client.query(
        `SELECT 1 FROM profile_generated_cosmetics WHERE bitrix_id = $1 AND cosmetic_id = $2`,
        [mgr, candidate],
      );
      if (dup.rowCount === 0) { cosmeticId = candidate; break; }
    }
    if (!cosmeticId) { await client.query('ROLLBACK'); return { ok: false, error: 'Не удалось сгенерировать вариант, попробуйте ещё раз' }; }

    const led = await client.query<{ id: string }>(
      `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment)
       VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'cosmetic_roll', $3, $4) RETURNING id`,
      [mgr, -s.rollPrice, actorLogin, `Прокрут рандомайзера (${kind})`],
    );
    await client.query(
      `INSERT INTO profile_generated_cosmetics (bitrix_id, kind, cosmetic_id, price_paid, ledger_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [mgr, kind, cosmeticId, s.rollPrice, Number(led.rows[0].id)],
    );
    // Вытесняем старые НЕзакреплённые: коллекция не должна пухнуть, а
    // закреплённое остаётся навсегда — за это человек и платил отдельно.
    await client.query(
      `DELETE FROM profile_generated_cosmetics
        WHERE bitrix_id = $1 AND kind = $2 AND NOT pinned
          AND id NOT IN (
            SELECT id FROM profile_generated_cosmetics
             WHERE bitrix_id = $1 AND kind = $2 AND NOT pinned
             ORDER BY created_at DESC LIMIT $3
          )`,
      [mgr, kind, s.keepUnpinned],
    );
    await client.query('COMMIT');
    return { ok: true, cosmeticId, kind, price: s.rollPrice, rollsLeft: s.rollsPerDay - used - 1 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export type PinResult = { ok: true; cosmeticId: string; price: number } | { ok: false; error: string };

/** Закрепить вариант: он перестаёт вытесняться новыми прокрутами. */
export async function pinCosmetic(
  db: Pool, mgr: number, cosmeticId: string, actorLogin: string,
): Promise<PinResult> {
  const s = await loadRandomizerSettings(db);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ pinned: boolean }>(
      `SELECT pinned FROM profile_generated_cosmetics
        WHERE bitrix_id = $1 AND cosmetic_id = $2 FOR UPDATE`,
      [mgr, cosmeticId],
    );
    if (row.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, error: 'Вариант не найден' }; }
    if (row.rows[0].pinned) { await client.query('ROLLBACK'); return { ok: false, error: 'Уже закреплён' }; }
    if (s.pinPrice > 0) {
      const bal = await client.query<{ b: string }>(
        `SELECT coalesce(balance,0)::text AS b FROM badge_coin_balances WHERE bitrix_id = $1`, [mgr]);
      if (Number(bal.rows[0]?.b ?? 0) < s.pinPrice) {
        await client.query('ROLLBACK');
        return { ok: false, error: `Не хватает MLT: закрепление стоит ${s.pinPrice}` };
      }
      await client.query(
        `INSERT INTO badge_coin_ledger (bitrix_id, badge_award_id, badge_key, amount, price_at_award, currency, source, actor_login, comment)
         VALUES ($1, NULL, NULL, $2, $2, 'EBALL', 'cosmetic_pin', $3, $4)`,
        [mgr, -s.pinPrice, actorLogin, `Закрепление варианта ${cosmeticId}`],
      );
    }
    await client.query(
      `UPDATE profile_generated_cosmetics SET pinned = true WHERE bitrix_id = $1 AND cosmetic_id = $2`,
      [mgr, cosmeticId],
    );
    await client.query('COMMIT');
    return { ok: true, cosmeticId, price: s.pinPrice };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Владеет ли человек этим сгенерированным вариантом (проверка перед «надеть»). */
export async function ownsGenerated(db: Pool | PoolClient, mgr: number, cosmeticId: string): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT 1 FROM profile_generated_cosmetics WHERE bitrix_id = $1 AND cosmetic_id = $2`,
      [mgr, cosmeticId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch { return false; }
}
