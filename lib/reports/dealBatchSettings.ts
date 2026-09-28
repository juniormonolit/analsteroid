// Настройки режима «Последние N закрытых сделок» и правил «зомби» (ТЗ владельца
// 28.09, миграция 221). Синглтон-строка id=1 — тот же приём, что у plan_settings
// (lib/plans/dailyPlan.ts::getDailyPlanMode): читается на каждый отчёт, поэтому
// кэшируется в памяти инстанса на 5 минут, при ошибке — безопасные дефолты.

import { systemDb } from '@/lib/db/clients';

export interface ZombieRule {
  enabled: boolean;
  days: number;
}

export interface DealBatchSettings {
  defaultBatchSize: number;
  /** Открыта дольше N дней с создания. */
  age: ZombieRule;
  /** Не обновлялась N дней (deals.updated_at). */
  idle: ZombieRule;
  /** В текущей стадии дольше N дней (deal_events, история с 03.04.2026). */
  stage: ZombieRule;
}

export const DEFAULT_BATCH_SETTINGS: DealBatchSettings = {
  defaultBatchSize: 100,
  age:   { enabled: true,  days: 45 },
  idle:  { enabled: true,  days: 30 },
  stage: { enabled: false, days: 21 },
};

const TTL_MS = 5 * 60 * 1000;
let cache: { value: DealBatchSettings; at: number } | null = null;

export function invalidateDealBatchSettings(): void { cache = null; }

export async function getDealBatchSettings(): Promise<DealBatchSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value = DEFAULT_BATCH_SETTINGS;
  try {
    const res = await systemDb().query<{
      default_batch_size: number;
      zombie_age_enabled: boolean; zombie_age_days: number;
      zombie_idle_enabled: boolean; zombie_idle_days: number;
      zombie_stage_enabled: boolean; zombie_stage_days: number;
    }>(`SELECT default_batch_size, zombie_age_enabled, zombie_age_days,
               zombie_idle_enabled, zombie_idle_days,
               zombie_stage_enabled, zombie_stage_days
          FROM deal_batch_settings WHERE id = 1`);
    const r = res.rows[0];
    if (r) {
      value = {
        defaultBatchSize: Number(r.default_batch_size) || 100,
        age:   { enabled: r.zombie_age_enabled,   days: Number(r.zombie_age_days)   || 45 },
        idle:  { enabled: r.zombie_idle_enabled,  days: Number(r.zombie_idle_days)  || 30 },
        stage: { enabled: r.zombie_stage_enabled, days: Number(r.zombie_stage_days) || 21 },
      };
    }
  } catch (e) {
    // до миграции 221 таблицы нет — отчёт не должен падать из-за настроек
    console.warn('[dealBatchSettings] недоступны, беру дефолты:', e instanceof Error ? e.message : e);
  }
  cache = { value, at: Date.now() };
  return value;
}

const clampDays = (v: unknown, def: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : def;
};

/** Нормализация тела PATCH из админки. */
export function parseBatchSettings(body: unknown): DealBatchSettings {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const rule = (raw: unknown, def: ZombieRule): ZombieRule => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return { enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled, days: clampDays(r.days, def.days) };
  };
  const size = Math.round(Number(b.defaultBatchSize));
  return {
    defaultBatchSize: Number.isFinite(size) && size >= 5 && size <= 5000 ? size : 100,
    age:   rule(b.age,   DEFAULT_BATCH_SETTINGS.age),
    idle:  rule(b.idle,  DEFAULT_BATCH_SETTINGS.idle),
    stage: rule(b.stage, DEFAULT_BATCH_SETTINGS.stage),
  };
}

export async function saveDealBatchSettings(s: DealBatchSettings, userId: string | null): Promise<void> {
  await systemDb().query(
    `UPDATE deal_batch_settings
        SET default_batch_size = $1,
            zombie_age_enabled = $2,   zombie_age_days = $3,
            zombie_idle_enabled = $4,  zombie_idle_days = $5,
            zombie_stage_enabled = $6, zombie_stage_days = $7,
            updated_at = now(), updated_by = $8
      WHERE id = 1`,
    [s.defaultBatchSize, s.age.enabled, s.age.days, s.idle.enabled, s.idle.days,
     s.stage.enabled, s.stage.days, userId],
  );
  invalidateDealBatchSettings();
}
