// Какой отдел «свой» у руководителя и сколько в нём людей (задача 10.08).
//
// Нужно двум вещам сразу: цене командного товара (она от размера отдела) и
// бюджету (он у отдела, а не у человека). Отдел берём тот же, что у бота
// «Контроль звонков» (`getCallControlManagedDepts`) — это уже устоявшийся в
// проекте ответ на вопрос «кто чьим отделом руководит», с ручными
// переназначениями поверх оргструктуры. Заводить второе определение
// руководителя значило бы получить два расходящихся ответа.
//
// Если руководитель ведёт несколько отделов, берём САМЫЙ БОЛЬШОЙ: командная
// покупка действует на людей, и цена должна считаться по той группе, которая её
// получит. Выбор отдела вручную — отдельная задача, пока не нужен: по живой
// оргструктуре у большинства руководителей отдел один.

import { analyticsDb } from '@/lib/db/clients';
import { getCallControlManagedDepts } from '@/lib/org/callControlScope';

export interface TeamScope {
  deptKey: string | null;
  deptName: string | null;
  size: number;          // активных сотрудников в отделе
}

export async function fetchTeamScope(bitrixUserId: string): Promise<TeamScope> {
  const empty: TeamScope = { deptKey: null, deptName: null, size: 0 };
  if (!bitrixUserId) return empty;
  const managed = await getCallControlManagedDepts(bitrixUserId).catch(() => []);
  if (managed.length === 0) return empty;

  const sizes = await analyticsDb().query<{ department_id: string; n: string }>(
    `SELECT department_id::text AS department_id, count(DISTINCT manager_bitrix_user_id)::text AS n
       FROM sa.org_resolved_hierarchy
      WHERE is_active AND department_id::text = ANY($1::text[])
      GROUP BY 1`,
    [managed.map(m => m.deptId)],
  ).catch(() => ({ rows: [] as { department_id: string; n: string }[] }));

  const byId = new Map(sizes.rows.map(r => [r.department_id, Number(r.n)]));
  let best = empty;
  for (const m of managed) {
    const n = byId.get(m.deptId) ?? 0;
    if (n >= best.size) best = { deptKey: m.deptId, deptName: m.deptName, size: n };
  }
  // Отдел найден, но людей в нём не посчиталось — цена не должна молча стать
  // базовой: считаем как за одного, а не как за ноль.
  return best.deptKey ? { ...best, size: Math.max(1, best.size) } : empty;
}
