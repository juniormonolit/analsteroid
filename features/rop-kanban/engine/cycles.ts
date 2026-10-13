// Галочки «менеджер × цикл» (пилот «Канбан РОПа», #9625 v2) — таблица system.rop_manager_cycles (миграция 228).
// Единственная запись раздела; пишет только в system. Нет строки = все циклы включены.
import { systemDb } from '@/lib/db/clients';
import { CYCLE_KEYS, type CycleKey } from './config';

/** Оставляет только известные ключи циклов, без дублей, в порядке CYCLES. */
export function sanitizeDisabledCycles(raw: unknown): CycleKey[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(raw.filter((k): k is string => typeof k === 'string'));
  return CYCLE_KEYS.filter(k => set.has(k));
}

export async function getRestrictions(managerIds: string[]): Promise<Record<string, CycleKey[]>> {
  if (managerIds.length === 0) return {};
  const res = await systemDb().query<{ manager_bitrix_id: string; disabled_cycles: string[] }>(
    `SELECT manager_bitrix_id, disabled_cycles FROM rop_manager_cycles WHERE manager_bitrix_id = ANY($1::text[]) AND cardinality(disabled_cycles) > 0`,
    [managerIds],
  );
  const out: Record<string, CycleKey[]> = {};
  for (const r of res.rows) out[r.manager_bitrix_id] = sanitizeDisabledCycles(r.disabled_cycles);
  return out;
}

export async function setRestriction(managerId: string, disabled: CycleKey[], updatedBy: string): Promise<void> {
  await systemDb().query(
    `INSERT INTO rop_manager_cycles (manager_bitrix_id, disabled_cycles, updated_by, updated_at)
     VALUES ($1, $2::text[], $3, now())
     ON CONFLICT (manager_bitrix_id) DO UPDATE SET disabled_cycles = EXCLUDED.disabled_cycles, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [managerId, disabled, updatedBy],
  );
}
