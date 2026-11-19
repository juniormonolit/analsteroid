// Справочник очередей (logist_queues + участники) и посев из Панели снабжения.
import { systemDb } from '@/lib/db/clients';
import { loadSnapshot } from '@/lib/supplyPanel/snapshot';
import type { LogistQueue, QueueMember, QueueUpsertBody, SeedQueuesResponse } from './contract';
import { queuesFromSupplyFacts } from './routing';
import { InputError } from './validate';

interface QueueRow {
  id: number; group_id: number; name: string; region: string | null; dept: string | null; product_groups: string[];
  sla_hours: string | null; active: boolean; source: 'supply_panel' | 'manual'; sort: number;
  members: { user_bitrix_id: string; user_name: string | null; role: 'logist' | 'lead' }[] | null;
}

export async function loadQueues(opts: { activeOnly?: boolean } = {}): Promise<LogistQueue[]> {
  const r = await systemDb().query<QueueRow>(
    `SELECT q.*, (SELECT jsonb_agg(jsonb_build_object('user_bitrix_id', m.user_bitrix_id, 'user_name', m.user_name, 'role', m.role)
                                   ORDER BY m.role DESC, m.user_name)
                    FROM logist_queue_members m WHERE m.queue_id = q.id) AS members
       FROM logist_queues q ${opts.activeOnly ? 'WHERE q.active' : ''}
      ORDER BY q.sort, q.region NULLS LAST, q.name`);
  return r.rows.map(q => ({
    id: q.id, groupId: q.group_id, name: q.name, region: q.region, dept: q.dept, productGroups: q.product_groups ?? [],
    slaHours: q.sla_hours === null ? null : Number(q.sla_hours), active: q.active, source: q.source, sort: q.sort,
    members: (q.members ?? []).map((m): QueueMember => ({ bitrixId: m.user_bitrix_id, name: m.user_name, role: m.role })),
  }));
}

export function parseQueueBody(raw: unknown): QueueUpsertBody {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const groupId = Number(r.groupId);
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 300) : '';
  if (!Number.isInteger(groupId) || groupId <= 0) throw new InputError('Нужен id проекта Битрикса (groupId)');
  if (!name) throw new InputError('Нужно название очереди');
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const sla = r.slaHours == null || r.slaHours === '' ? null : Number(r.slaHours);
  if (sla !== null && !(Number.isFinite(sla) && sla > 0 && sla <= 200)) throw new InputError('SLA — от 0 до 200 рабочих часов');
  const out: QueueUpsertBody = {
    groupId, name, region: s(r.region, 40), dept: s(r.dept, 40),
    productGroups: Array.isArray(r.productGroups) ? [...new Set(r.productGroups.map(x => s(x, 200)).filter((x): x is string => !!x))].slice(0, 100) : [],
    slaHours: sla, active: r.active !== false, sort: Number.isInteger(r.sort) ? Number(r.sort) : 0,
  };
  if (r.id != null) { const id = Number(r.id); if (!Number.isInteger(id) || id <= 0) throw new InputError('Некорректный id очереди'); out.id = id; }
  if (Array.isArray(r.members)) {
    out.members = r.members.slice(0, 200).map(x => {
      const m = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const bitrixId = String(m.bitrixId ?? '').trim();
      if (!/^\d{1,10}$/.test(bitrixId)) throw new InputError('Некорректный участник очереди');
      return { bitrixId, name: s(m.name, 200), role: m.role === 'lead' ? 'lead' : 'logist' };
    });
  }
  return out;
}

export async function upsertQueue(b: QueueUpsertBody, by: string): Promise<LogistQueue> {
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    const vals = [b.groupId, b.name, b.region ?? null, b.dept ?? null, b.productGroups ?? [], b.slaHours ?? null, b.active ?? true, b.sort ?? 0, by];
    const r = b.id
      ? await client.query<{ id: number }>(
        `UPDATE logist_queues SET group_id=$1, name=$2, region=$3, dept=$4, product_groups=$5, sla_hours=$6, active=$7, sort=$8,
                updated_at=now(), updated_by=$9 WHERE id=$10 RETURNING id`, [...vals, b.id])
      : await client.query<{ id: number }>(
        `INSERT INTO logist_queues (group_id, name, region, dept, product_groups, sla_hours, active, sort, updated_by, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')
         ON CONFLICT (group_id) DO UPDATE SET name=EXCLUDED.name, region=EXCLUDED.region, dept=EXCLUDED.dept,
           product_groups=EXCLUDED.product_groups, sla_hours=EXCLUDED.sla_hours, active=EXCLUDED.active, sort=EXCLUDED.sort,
           updated_at=now(), updated_by=EXCLUDED.updated_by
         RETURNING id`, vals);
    const id = r.rows[0]?.id;
    if (!id) throw new InputError('Очередь не найдена');
    if (b.members) {
      await client.query('DELETE FROM logist_queue_members WHERE queue_id = $1', [id]);
      for (const m of b.members) {
        await client.query(
          `INSERT INTO logist_queue_members (queue_id, user_bitrix_id, user_name, role, added_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (queue_id, user_bitrix_id) DO UPDATE SET user_name=EXCLUDED.user_name, role=EXCLUDED.role`,
          [id, m.bitrixId, m.name, m.role, by]);
      }
    }
    await client.query('COMMIT');
    const all = await loadQueues();
    return all.find(q => q.id === id)!;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if ((e as { code?: string }).code === '23505') throw new InputError('Очередь с таким проектом Битрикса уже есть');
    throw e;
  } finally {
    client.release();
  }
}

/** Посев из снимка Панели снабжения: проекты → очереди (название/регион/департамент обновляются только
 *  у очередей source='supply_panel'; ручные не трогаем). Участники — кто отвечал в проекте за 60 дней,
 *  добавляются только в очереди без участников (ручной состав не перетираем). */
export async function seedQueuesFromSupplyPanel(by: string, now = new Date()): Promise<SeedQueuesResponse> {
  const snap = await loadSnapshot();
  if (!snap) throw new InputError('Снимок Панели снабжения ещё не загружен — посев невозможен');
  const seeds = queuesFromSupplyFacts(snap.facts, now);
  let inserted = 0, updated = 0;
  const client = await systemDb().connect();
  try {
    await client.query('BEGIN');
    for (const s of seeds) {
      const r = await client.query<{ id: number; inserted: boolean }>(
        `INSERT INTO logist_queues (group_id, name, region, dept, source, updated_by) VALUES ($1,$2,$3,$4,'supply_panel',$5)
         ON CONFLICT (group_id) DO UPDATE SET name=EXCLUDED.name, region=EXCLUDED.region, dept=EXCLUDED.dept,
           updated_at=now(), updated_by=EXCLUDED.updated_by
           WHERE logist_queues.source = 'supply_panel'
         RETURNING id, (xmax = 0) AS inserted`,
        [s.groupId, s.name, s.region, s.dept, by]);
      const row = r.rows[0];
      if (!row) continue;
      if (row.inserted) inserted++; else updated++;
      if (s.members.length) {
        await client.query(
          `INSERT INTO logist_queue_members (queue_id, user_bitrix_id, user_name, added_by)
           SELECT $1, x.id, x.name, $4 FROM unnest($2::text[], $3::text[]) AS x(id, name)
            WHERE NOT EXISTS (SELECT 1 FROM logist_queue_members WHERE queue_id = $1)`,
          [row.id, s.members.map(m => m.bitrixId), s.members.map(m => m.name), by]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { inserted, updated, total: seeds.length, source: `Панель снабжения, снимок ${snap.builtAt}` };
}
