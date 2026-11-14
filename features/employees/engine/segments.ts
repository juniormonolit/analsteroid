// Загрузка отрезков «текущий человек на учётке» из sa.employee_name_history
// (задача #11110). Логика отрезка — чистая функция в ./personSegment.
import { analyticsDb } from '@/lib/db/clients';
import { currentPersonSegment, type NameHistoryRow, type PersonSegment } from './personSegment';

export interface SegmentsResult {
  /** bitrix_id (строкой) → отрезок текущего человека. */
  byId: Map<string, PersonSegment>;
  /** bitrix_id → вся история (по возрастанию valid_from). */
  historyById: Map<string, NameHistoryRow[]>;
}

export async function loadPersonSegments(ids?: string[]): Promise<SegmentsResult> {
  const pool = analyticsDb();
  const hist = await pool.query<{ bitrix_user_id: string; name: string; valid_from: string; valid_to: string | null }>(
      `SELECT bitrix_user_id, name,
              to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
              to_char(valid_to   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to
         FROM sa.employee_name_history
        WHERE $1::text[] IS NULL OR bitrix_user_id = ANY($1::text[])
        ORDER BY valid_from, id`,
      [ids ?? null],
    );
  const historyById = new Map<string, NameHistoryRow[]>();
  for (const r of hist.rows) {
    const list = historyById.get(r.bitrix_user_id) ?? [];
    list.push({ name: r.name, validFrom: r.valid_from, validTo: r.valid_to });
    historyById.set(r.bitrix_user_id, list);
  }
  const byId = new Map<string, PersonSegment>();
  for (const [id, rows] of historyById) {
    const seg = currentPersonSegment(rows);
    if (seg) byId.set(id, seg);
  }
  return { byId, historyById };
}
