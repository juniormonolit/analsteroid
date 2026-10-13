import { analyticsDb } from '@/lib/db/clients';
import { readClientsFromBitrix } from '@/features/client-module/engine/bitrix';

// Сверка Битрикс → sa для модуля «Карточка клиента» (решение владельца 13.10:
// правка полей только из виджета, «сверку делаем периодически»). Битрикс —
// источник правды; sa — копия. Ловит: запись в Битрикс прошла, а в sa нет;
// правки админа в Битриксе. Объекты в сверке не участвуют — они живут только
// в Монолитике (v2, 13.10).
// Пишет только в sa.client_module_*, Битрикс не трогает.

export interface ClientModuleSyncResult { profiles: number; profilesChanged: number }


export async function runClientModuleSync(): Promise<ClientModuleSyncResult> {
  const db = analyticsDb();
  const res: ClientModuleSyncResult = { profiles: 0, profilesChanged: 0 };

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
