import { systemDb } from '@/lib/db/clients';

/** Ручные отметки «Связался» менеджера с даты — client_key → моменты (ms).
 *  Отдельный модуль: contacts.ts тянет тип сессии, а движку шапки нужна одна выборка. */
export async function fetchLastContactsInRange(managerBitrixId: string, fromIso: string): Promise<Map<string, number[]>> {
  try {
    const r = await systemDb().query<{ client_key: string; contacted_at: Date }>(
      `SELECT client_key, contacted_at FROM customer_contacts WHERE manager_bitrix_id = $1 AND contacted_at >= $2::timestamptz`,
      [managerBitrixId, fromIso],
    );
    const out = new Map<string, number[]>();
    for (const x of r.rows) { const a = out.get(x.client_key) ?? []; a.push(new Date(x.contacted_at).getTime()); out.set(x.client_key, a); }
    return out;
  } catch { return new Map(); }
}
