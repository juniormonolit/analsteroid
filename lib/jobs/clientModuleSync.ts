import { analyticsDb } from '@/lib/db/clients';
import {
  OBJ, listAllObjectsFromBitrix, readClientsFromBitrix, stageFromBitrix, houseFromBitrix,
} from '@/features/client-module/engine/bitrix';

// Сверка Битрикс → sa для модуля «Карточка клиента» (решение владельца 13.10:
// правка полей только из виджета, «сверку делаем периодически»). Битрикс —
// источник правды; sa — копия. Ловит: запись в Битрикс прошла, а в sa нет;
// правки админа в Битриксе (стадии «завершена»/«неактуален», удаление объекта).
// Пишет только в sa.client_module_*, Битрикс не трогает.

export interface ClientModuleSyncResult { objects: number; objectsChanged: number; objectsDeleted: number; profiles: number; profilesChanged: number }

const num = (v: unknown) => { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; };

export async function runClientModuleSync(): Promise<ClientModuleSyncResult> {
  const db = analyticsDb();
  const res: ClientModuleSyncResult = { objects: 0, objectsChanged: 0, objectsDeleted: 0, profiles: 0, profilesChanged: 0 };

  // ── Объекты: все элементы смарт-процесса ──────────────────────────────────
  const items = await listAllObjectsFromBitrix();
  const seen: number[] = [];
  for (const it of items) {
    const key = String(it[OBJ.key] ?? '').trim();
    const contactId = num(it.contactId), companyId = num(it.companyId);
    const ref = companyId ? `k${companyId}` : contactId ? `c${contactId}` : null;
    if (!key || !ref) continue; // элемент без ключа/клиента виджет не создавал — не наш
    res.objects++;
    seen.push(Number(it.id));
    // Один «кривой» элемент (например, у объекта в Битриксе сменили клиента —
    // конфликт UNIQUE по bitrix_item_id) не должен ронять всю сверку.
    const r = await db.query(
      `INSERT INTO sa.client_module_objects
         (client_ref, object_key, bitrix_item_id, address, lat, lon, build_stage, house_type, note, is_deleted, bitrix_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, now())
       ON CONFLICT (client_ref, object_key) DO UPDATE SET bitrix_item_id = EXCLUDED.bitrix_item_id, address = EXCLUDED.address,
         lat = EXCLUDED.lat, lon = EXCLUDED.lon, build_stage = EXCLUDED.build_stage, house_type = EXCLUDED.house_type,
         note = EXCLUDED.note, is_deleted = false, bitrix_synced_at = now()
       WHERE (sa.client_module_objects.bitrix_item_id, sa.client_module_objects.address, sa.client_module_objects.lat, sa.client_module_objects.lon,
              sa.client_module_objects.build_stage, sa.client_module_objects.house_type, sa.client_module_objects.note, sa.client_module_objects.is_deleted)
         IS DISTINCT FROM (EXCLUDED.bitrix_item_id, EXCLUDED.address, EXCLUDED.lat, EXCLUDED.lon, EXCLUDED.build_stage, EXCLUDED.house_type, EXCLUDED.note, false)`,
      [ref, key, Number(it.id), String(it[OBJ.addressIdeal] ?? '') || null, num(it[OBJ.lat]), num(it[OBJ.lon]),
        stageFromBitrix(it.stageId), houseFromBitrix(it[OBJ.houseType]), String(it[OBJ.note] ?? '')],
    ).catch((e: unknown) => { console.warn('[clientModuleSync] объект', it.id, e instanceof Error ? e.message : e); return null; });
    res.objectsChanged += r?.rowCount ?? 0;
  }
  // Элемент удалён в Битриксе — помечаем копию (строки не удаляем: у junior_user нет DELETE).
  const del = await db.query(
    `UPDATE sa.client_module_objects SET is_deleted = true, bitrix_synced_at = now()
      WHERE NOT is_deleted AND bitrix_item_id IS NOT NULL AND NOT (bitrix_item_id = ANY($1::bigint[]))`,
    [seen],
  );
  res.objectsDeleted = del.rowCount ?? 0;

  // ── Клиенты: поля контактов/компаний, по 50 ID ────────────────────────────
  const refs = (await db.query<{ client_ref: string }>(`SELECT client_ref FROM sa.client_module_profiles`)).rows.map(r => r.client_ref);
  for (const [entity, prefix] of [['contact', 'c'], ['company', 'k']] as const) {
    const ids = refs.filter(r => r.startsWith(prefix)).map(r => Number(r.slice(1)));
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const fields = await readClientsFromBitrix(entity, chunk);
      for (const [id, f] of fields) {
        res.profiles++;
        const r = await db.query(
          `UPDATE sa.client_module_profiles SET client_type = $2, client_type_enum_id = $3, occupation = $4, note = $5, bitrix_synced_at = now()
            WHERE client_ref = $1 AND (client_type, client_type_enum_id, occupation, note) IS DISTINCT FROM ($2, $3, $4, $5)`,
          [`${prefix}${id}`, f.clientType, f.enumId, f.occupation, f.note],
        );
        res.profilesChanged += r.rowCount ?? 0;
      }
    }
  }
  return res;
}
