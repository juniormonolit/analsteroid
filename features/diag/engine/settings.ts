// Настройки движка диагностики — diag_settings (миграция 207), все с описаниями в UI.
// Кэш 5 минут; invalidateDiagSettings() после правки из панели.
import { systemDb } from '@/lib/db/clients';

export interface DiagSettings {
  windowClosed: number; tickSize: number; minClosed: number;
  zombieQuantile: number; zombieMinDays: number; zombieMaxDays: number; zombieMinN: number;
  controlShareTesting: number; controlShareConfirmed: number; minArmN: number; criticalGapShare: number;
  ewmaLambda: number; cusumKSigma: number; cusumHSigma: number; cusumHSigmaGroup: number; wilsonConf: number;
  rootSilentDays: number; rootLateDays: number; noviceDays: number;
  seasonRefFrom: string; seasonRefTo: string; callsDataStart: string;
}

const DEFAULTS: DiagSettings = {
  windowClosed: 60, tickSize: 10, minClosed: 30,
  zombieQuantile: 0.9, zombieMinDays: 5, zombieMaxDays: 30, zombieMinN: 200,
  controlShareTesting: 0.5, controlShareConfirmed: 0.2, minArmN: 20, criticalGapShare: 0.3,
  ewmaLambda: 0.2, cusumKSigma: 0.5, cusumHSigma: 4, cusumHSigmaGroup: 5, wilsonConf: 0.9,
  rootSilentDays: 5, rootLateDays: 5, noviceDays: 90,
  seasonRefFrom: '2025-08-01', seasonRefTo: '2026-08-31', callsDataStart: '2025-01-01',
};

const KEY_MAP: Record<string, keyof DiagSettings> = {
  window_closed: 'windowClosed', tick_size: 'tickSize', min_closed: 'minClosed',
  zombie_quantile: 'zombieQuantile', zombie_min_days: 'zombieMinDays', zombie_max_days: 'zombieMaxDays', zombie_min_n: 'zombieMinN',
  control_share_testing: 'controlShareTesting', control_share_confirmed: 'controlShareConfirmed', min_arm_n: 'minArmN', critical_gap_share: 'criticalGapShare',
  ewma_lambda: 'ewmaLambda', cusum_k_sigma: 'cusumKSigma', cusum_h_sigma: 'cusumHSigma', cusum_h_sigma_group: 'cusumHSigmaGroup', wilson_conf: 'wilsonConf',
  root_silent_days: 'rootSilentDays', root_late_days: 'rootLateDays', novice_days: 'noviceDays',
  season_ref_from: 'seasonRefFrom', season_ref_to: 'seasonRefTo', calls_data_start: 'callsDataStart',
};

let _cache: { at: number; s: DiagSettings } | null = null;
export function invalidateDiagSettings(): void { _cache = null; }

export async function loadDiagSettings(): Promise<DiagSettings> {
  if (_cache && Date.now() - _cache.at < 5 * 60 * 1000) return _cache.s;
  const r = await systemDb().query<{ key: string; value: unknown }>(`SELECT key, value FROM diag_settings`);
  const s: DiagSettings = { ...DEFAULTS };
  for (const row of r.rows) {
    const k = KEY_MAP[row.key];
    if (!k) continue;
    const v = row.value;
    (s as unknown as Record<string, unknown>)[k] = typeof DEFAULTS[k] === 'number' ? Number(v) : String(v);
  }
  _cache = { at: Date.now(), s };
  return s;
}
