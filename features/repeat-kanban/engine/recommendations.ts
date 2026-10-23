// Журнал рекомендаций (миграция 250) — самообучение повторки: при постановке задачи пишем, что система советовала
// предложить заказчику (топ-5 potentialGroups) и упомянута ли группа в тексте задачи. Исход (отгрузили ли эту
// группу потом) считается запросом по sa.deals от created_at — см. шапку миграции 250.
// Пишется в фоне после постановки и никогда не роняет её.
import { systemDb } from '@/lib/db/clients';
import { fetchManagerCustomers } from '@/features/customers/engine/customers';
import { memberKeysOf } from '@/features/customers/engine/merge';
import { fetchCrossSellMatrix, fetchCrossSellPriorities } from '@/features/customers/engine/crossSell';
import { fetchShippedGroups, resolvePeriod } from './shippedGroups';
import { fetchClientTypesBulk } from './clientTypes';
import { fetchDismissedByRef, potentialGroups } from './potentialGroups';

const CONTRACTOR_TYPES = new Set(['construction_org', 'own_needs_org']);
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

/** Упомянута ли группа в тексте: по первому значимому слову названия («Окна и двери» → «окн»). */
export function mentioned(group: string, text: string): boolean {
  const t = norm(text);
  const words = norm(group).split(/[^а-яa-z]+/).filter(w => w.length >= 4);
  // Корень — 4 буквы: «кровельные» ↔ «кровлю», «теплоизоляция» ↔ «утеплитель» (грубо, но для журнала достаточно).
  return words.slice(0, 2).some(w => t.includes(w.slice(0, 4)));
}

export async function logRecommendations(input: {
  clientKey: string; managerId: string; taskId: number; dealId: number; text: string; createdBy: string | null;
}): Promise<void> {
  try {
    const row = (await fetchManagerCustomers(Number(input.managerId))).find(r => r.clientKey === input.clientKey);
    const members = await memberKeysOf(input.clientKey).catch(() => [input.clientKey]);
    const all = resolvePeriod('all', null, null);
    const [shipped, priorities, matrix, dismissed, types] = await Promise.all([
      fetchShippedGroups(all.from, all.to), fetchCrossSellPriorities().catch(() => null), fetchCrossSellMatrix().catch(() => null),
      fetchDismissedByRef(), fetchClientTypesBulk([input.clientKey]).catch(() => new Map<string, string>()),
    ]);
    const recent = row?.lastGroups?.length ? row.lastGroups : row?.lastDeliveredGroup ? [row.lastDeliveredGroup] : [];
    const offer = potentialGroups({
      recent,
      taken: new Set([...members.flatMap(k => shipped.get(k) ?? []), ...recent]),
      dismissed: new Set(members.flatMap(k => [...(dismissed.get(k.startsWith('x') ? `c${k.slice(1)}` : k) ?? [])])),
      contractor: CONTRACTOR_TYPES.has(types.get(input.clientKey) ?? ''),
      priorities, matrix,
    });
    if (!offer.length) return;
    await systemDb().query(
      `INSERT INTO repeat_recommendations (task_id, deal_id, client_key, manager_id, group_name, rank, source, from_group, in_text, created_by)
       SELECT $1, $2, $3, $4, g, r, s, f, t, $10 FROM unnest($5::text[], $6::int[], $7::text[], $8::text[], $9::bool[]) AS x(g, r, s, f, t)`,
      [input.taskId, input.dealId, input.clientKey, input.managerId,
        offer.map(o => o.group), offer.map((_, i) => i + 1), offer.map(o => o.source), offer.map(o => o.after), offer.map(o => mentioned(o.group, input.text)),
        input.createdBy],
    );
  } catch (e) {
    console.warn('[repeat-kanban] журнал рекомендаций:', e instanceof Error ? e.message : e);
  }
}
