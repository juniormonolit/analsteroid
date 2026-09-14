import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { analyticsDb } from '@/lib/db/clients';
import { bx } from '@/lib/bitrix/notify';
import { loadManagerInfoMap } from '@/lib/marketing/sources';
import { getSessionScope, canSeeManager, scopeForbidden } from '@/lib/org/sessionScope';

// Дела и задачи сделки (таб «Дела» карточки сделки, правка владельца 14.09).
// Тот же источник, что у метрик раздела «Дела и задачи» — снимок
// sa.deals.activities (features/reports/engine/dealsActivities.ts). Отдельный
// лёгкий эндпоинт и ЛЕНИВЫЙ запрос из карточки: на каждое открытие карточки
// ходить в Битрикс за id задач не нужно.
//
// ВАЖНО про ссылку на задачу. В снимке лежит `activity_id` — идентификатор ДЕЛА
// CRM (crm.activity), и он СКВОЗНОЙ для всех типов: у CRM_TODO, звонков и задач
// диапазоны id перемешаны. Настоящий id задачи — ASSOCIATED_ENTITY_ID того же
// дела (проверено на живом портале 14.09: activity 3107209 → задача 152730).
// Поэтому ссылку нельзя собрать из снимка: для строк типа CRM_TASKS_TASK
// доспрашиваем Битрикс одним crm.activity.list по id этой сделки. Если Битрикс
// недоступен — строка просто остаётся без ссылки; выдумывать URL из activity_id
// нельзя, он вёл бы на чужую задачу.

const BITRIX_BASE = 'https://td.monolit-crm.ru';
/** Задачи в Битриксе живут в личном разделе ответственного. */
const taskUrl = (userId: string, taskId: string) =>
  `${BITRIX_BASE}/company/personal/user/${userId}/tasks/task/view/${taskId}/`;

export const ACTIVITY_TASK_TYPE = 'CRM_TASKS_TASK';

/** Человеческие названия типов дел (PROVIDER_ID Битрикса). */
export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  CRM_TODO: 'Дело',
  CRM_TASKS_TASK: 'Задача',
  CRM_TASKS_TASK_COMMENT: 'Комментарий к задаче',
  VOXIMPLANT_CALL: 'Звонок',
  CRM_EMAIL: 'Письмо',
  IMOPENLINES_SESSION: 'Чат',
  CRM_BIZPROC_WORKFLOW: 'Бизнес-процесс',
  CRM_SIGN_DOCUMENT: 'Подписание',
};

export interface DealActivityRow {
  activityId: string;
  type: string;
  /** Подпись типа для UI; для незнакомого типа — сам код, а не «Прочее». */
  typeLabel: string;
  isTask: boolean;
  name: string | null;
  dateCreate: string | null;
  dateEnd: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  /** Просрочено (срок в прошлом). Считает сервер — чтобы совпадало с метриками. */
  overdue: boolean;
  /** Ссылка на задачу в Битриксе; null для дел и когда Битрикс не ответил. */
  taskUrl: string | null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id || !/^\d+$/.test(id)) {
    return NextResponse.json({ error: 'id (число) обязателен' }, { status: 400 });
  }

  // Тот же гейт, что у /api/reports/deal и .../calls (аудит 09.09, IDOR).
  const res = await analyticsDb().query<{ manager_id: string | null; activities: unknown }>(
    'SELECT current_manager_id::text AS manager_id, activities FROM deals WHERE deal_id = $1',
    [Number(id)],
  );
  if (!res.rows.length) return NextResponse.json({ error: 'Сделка не найдена' }, { status: 404 });
  const scope = await getSessionScope(session);
  if (!canSeeManager(scope, res.rows[0].manager_id)) return scopeForbidden('Эта сделка вам недоступна');

  const raw = Array.isArray(res.rows[0].activities) ? res.rows[0].activities as Record<string, string | null>[] : [];

  // Схема переходного периода (задача #5594): новые поля activity_id/type/
  // date_end рядом со старыми id/provider_id/deadline — читаем обе.
  const items = raw.map(e => ({
    activityId: String(e.activity_id ?? e.id ?? ''),
    type: String(e.type ?? e.provider_id ?? ''),
    name: e.name ?? e.subject ?? null,
    dateCreate: e.date_create ?? e.created ?? null,
    // Заглушка «без срока» переходного периода — это НЕ срок (см. dealsActivities.ts).
    dateEnd: (() => { const v = e.date_end ?? e.deadline ?? null; return v && !v.startsWith('9999-12-31') ? v : null; })(),
    responsibleId: e.responsible_id ?? null,
  })).filter(e => e.activityId);

  // id задач — одним запросом в Битрикс на всю сделку (обычно 0–2 строки).
  const taskActivityIds = items.filter(e => e.type === ACTIVITY_TASK_TYPE).map(e => e.activityId);
  const taskIdByActivity = new Map<string, { taskId: string; responsibleId: string }>();
  if (taskActivityIds.length) {
    const webhook = process.env.BITRIX_WEBHOOK_URL ?? '';
    if (webhook) {
      try {
        const body = await bx(webhook, 'crm.activity.list', {
          filter: { '@ID': taskActivityIds },
          select: ['ID', 'ASSOCIATED_ENTITY_ID', 'RESPONSIBLE_ID'],
        });
        for (const a of (body?.result ?? []) as { ID: string; ASSOCIATED_ENTITY_ID?: string; RESPONSIBLE_ID?: string }[]) {
          // ASSOCIATED_ENTITY_ID = 0 у дел без связанной сущности — ссылки нет.
          if (a.ASSOCIATED_ENTITY_ID && a.ASSOCIATED_ENTITY_ID !== '0') {
            taskIdByActivity.set(String(a.ID), {
              taskId: String(a.ASSOCIATED_ENTITY_ID),
              responsibleId: String(a.RESPONSIBLE_ID ?? ''),
            });
          }
        }
      } catch (e) {
        // Деградируем молча в UI, но оставляем след в логах: строки задач просто
        // будут без ссылки, весь остальной таб работает.
        console.warn('[deal/activities] crm.activity.list не удался:', e instanceof Error ? e.message : e);
      }
    }
  }

  const mgrInfo = await loadManagerInfoMap();
  const now = Date.now();

  const activities: DealActivityRow[] = items.map(e => {
    const task = taskIdByActivity.get(e.activityId);
    const resp = e.responsibleId ?? task?.responsibleId ?? null;
    return {
      activityId: e.activityId,
      type: e.type,
      typeLabel: ACTIVITY_TYPE_LABELS[e.type] ?? e.type,
      isTask: e.type === ACTIVITY_TASK_TYPE,
      name: e.name,
      dateCreate: e.dateCreate,
      dateEnd: e.dateEnd,
      responsibleId: resp,
      responsibleName: resp ? (mgrInfo.get(resp)?.name ?? null) : null,
      overdue: !!e.dateEnd && new Date(e.dateEnd).getTime() < now,
      taskUrl: task && task.responsibleId ? taskUrl(task.responsibleId, task.taskId) : null,
    };
  })
    // Хронология: свежие сверху. Без срока — по дате создания.
    .sort((a, b) => {
      const av = a.dateEnd ?? a.dateCreate ?? '';
      const bv = b.dateEnd ?? b.dateCreate ?? '';
      return bv.localeCompare(av);
    });

  return NextResponse.json({ activities });
}
