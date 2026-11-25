// «Большой брат» — таксономия журнала активности (ТЗ: ai_docs/fresh_docs/BIG_BROTHER_SPEC.md, раздел «Данные»).
// КОНТРАКТ для потоков A/B/C/D: менять только добавлением значений; переименование ломает чтение истории.
//
// Где что живёт:
//   activity_events  — сырые события ТОЛЬКО Монолитики (mono_view / mono_action / session). 90 дней.
//   activity_minutes — 5-мин бакеты присутствия (source = 'mono' — heartbeat; адаптеры могут
//                      писать производные сигналы со своим source). 90 дней.
//   activity_daily   — дневной агрегат (поток D), бессрочно.
// Остальные kind (call / deal_stage / deal_new / task / kanban / logist) — ПРОИЗВОДНЫЕ: адаптеры читают
// их из va.calls, sa.deal_events, sa.bitrix_task_current, repeat_kanban_events, logist_request_events
// и в activity_events НЕ пишут (не дублируем чужие журналы).

/** Откуда пришёл человек. Маппинг из useAppMode(): desktop→web, mobile→mobile, standalone→pwa, bitrix-iframe→bx_iframe.
 *  'server' — событие без клиента (вход/выход, серверные мутации, где режим неизвестен). */
export type ActivitySurface = 'web' | 'mobile' | 'pwa' | 'bx_iframe' | 'server';
export const ACTIVITY_SURFACES: readonly ActivitySurface[] = ['web', 'mobile', 'pwa', 'bx_iframe', 'server'];

export type ActivityKind =
  // пишутся в activity_events
  | 'mono_view'   // открыт раздел Монолитики (section = первый сегмент пути, payload.path)
  | 'mono_action' // мутация в сервисе (section = сервис, action — ниже)
  | 'session'     // вход / выход (action = login | logout, payload.via)
  // производные (адаптеры, в activity_events не пишутся)
  | 'call'        // action: out_reached | out_attempt | in
  | 'deal_stage'  // смена стадии (автор = ответственный)
  | 'deal_new'    // новая сделка менеджеру
  | 'task'        // action: create | close | overdue | return | comment
  | 'kanban'      // канбан повторки (repeat_kanban_events.event_type → action)
  | 'logist';     // канбан логистов (logist_request_events)

/** Действия kind='session'. */
export type SessionAction = 'login' | 'logout';
/** Как вошёл (payload.via у session/login). */
export type LoginVia = 'password' | 'invite' | 'bitrix_iframe' | 'bitrix_handoff';

/** Сервисы для mono_action.section (и типовые разделы для mono_view). */
export type ActivitySection = 'tasker' | 'big_deals' | 'logist' | (string & {});

/** Действия mono_action. Общий словарь для всех сервисов — читатели группируют по section+action. */
export type MonoAction =
  | 'task_create'      // поставил задачу
  | 'task_update'      // изменил задачу (текст, исполнитель, показатель…)
  | 'task_reschedule'  // перенёс срок
  | 'task_close'       // закрыл / принял
  | 'task_return'      // вернул на доработку
  | 'task_delete'      // удалил / отменил
  | 'task_comment'     // написал в чат задачи / комментарий
  | 'deal_move'        // перенёс карточку / сделку по колонкам
  | 'deal_update'      // поменял поля сделки
  | 'request_create'   // создал запрос (логисты)
  | 'request_update'   // изменил запрос / статус
  | 'request_assign'   // взял / назначил исполнителя
  | 'settings_update'  // поменял настройки сервиса
  | 'other';           // прочее (детали в payload.op)

/** Источник 5-мин бакета activity_minutes. */
export type MinuteSource = 'mono' | 'call' | 'deal' | 'task' | 'kanban' | 'logist';

/** Длина бакета activity_minutes, минуты. */
export const ACTIVITY_BUCKET_MIN = 5;
/** Хранение подробной ленты, дни (activity_events, activity_minutes). */
export const ACTIVITY_TTL_DAYS = 90;

/** Строка activity_events, как её читают потоки B/C/D. */
export interface ActivityEventRow {
  id: string;            // bigserial → строкой
  ts: string;            // ISO
  user_id: string | null;
  login: string | null;
  bitrix_user_id: string | null;
  role_name: string | null;
  surface: ActivitySurface;
  kind: ActivityKind;
  action: string | null;
  section: string | null;
  entity_type: string | null;
  entity_id: string | null;
  deal_id: string | null; // bigint → строкой
  request_id: string | null;
  payload: Record<string, unknown>;
}

/** Вход в logActivity (lib/activity/log.ts). */
export interface ActivityInput {
  kind: 'mono_view' | 'mono_action' | 'session';
  action?: MonoAction | SessionAction | string | null;
  section?: ActivitySection | null;
  surface?: ActivitySurface;
  entityType?: string | null; // 'tasker_task' | 'bitrix_task' | 'deal' | 'logist_request' | …
  entityId?: string | number | null;
  dealId?: number | string | null;
  requestId?: string | null;
  payload?: Record<string, unknown>;
}
