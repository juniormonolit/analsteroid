// Кто решает заявки конкретного сотрудника.
//
// Обратная сторона гейта из lib/org/managerAccess: там «какие заявки я вправе
// решать», здесь «кому уходит уведомление о моей заявке». Источник один и тот
// же — sa.org_resolved_hierarchy, чтобы уведомление не приходило человеку,
// который потом получит 403 при попытке решить.

import { analyticsDb } from '@/lib/db/clients';

/**
 * РОП и директор департамента сотрудника. Себя из списка исключаем: РОП,
 * подающий заявку на себя, не должен получать уведомление о своей же заявке.
 * Пустой массив — решающих нет (заявка просто ждёт в разделе у админа).
 */
export async function approversFor(bitrixId: number): Promise<string[]> {
  const res = await analyticsDb().query<{ rop: string | null; director: string | null }>(
    `SELECT rop_bitrix_user_id::text AS rop,
            department_director_bitrix_user_id::text AS director
       FROM sa.org_resolved_hierarchy
      WHERE is_active AND manager_bitrix_user_id = $1
      LIMIT 1`,
    [bitrixId],
  );
  const row = res.rows[0];
  const ids = [row?.rop, row?.director].filter((v): v is string => !!v && v !== String(bitrixId));
  return [...new Set(ids)];
}
