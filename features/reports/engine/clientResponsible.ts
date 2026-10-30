import { analyticsDb } from '@/lib/db/clients';

// «Ответственный менеджер клиента» для отчётов по клиентам (#11255, просьба Стаса:
// «вторым столбцом идёт менеджер, ответственный за этого клиента»).
// Отдельного поля «ответственный за контакт» в sa.* нет — берём то же, что показывает
// шапка карточки клиента и канбан повторных продаж: текущий ответственный по самой
// актуальной сделке клиента (открытая важнее закрытой, дальше — самая свежая; правило
// как у board.ts), ФИО из sa.org_resolved_hierarchy. Только чтение, миграций нет.

const TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { name: string | null; at: number }>();

export async function fetchClientResponsibles(contactIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of new Set(contactIds.filter(x => /^\d+$/.test(x)))) {
    const hit = _cache.get(id);
    if (hit && now - hit.at < TTL_MS) out.set(id, hit.name); else missing.push(id);
  }
  if (missing.length === 0) return out;
  const res = await analyticsDb().query<{ id: string; name: string | null }>(
    `SELECT DISTINCT ON (d.contact_id) d.contact_id::text AS id, org.manager_name AS name
       FROM sa.deals d
       LEFT JOIN sa.stages s ON s.id = d.stage_id
       LEFT JOIN sa.org_resolved_hierarchy org ON org.manager_bitrix_user_id = d.current_manager_id::text
      WHERE d.contact_id = ANY($1::bigint[]) AND d.current_manager_id IS NOT NULL
      ORDER BY d.contact_id,
               coalesce(s.event_type NOT IN ('lost', 'shipped'), false) DESC,
               d.created_at DESC, d.deal_id DESC`,
    [missing],
  );
  const found = new Map(res.rows.map(r => [r.id, r.name]));
  for (const id of missing) {
    const name = found.get(id) ?? null;
    _cache.set(id, { name, at: now });
    out.set(id, name);
  }
  return out;
}
