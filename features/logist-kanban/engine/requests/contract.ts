// ════════════════════════════════════════════════════════════════════════════════════════
// Канбан запросов логистам — КОНТРАКТ API (S1, 19.11). Один файл типов, против которого пишут
// S2 (триггер + форма), S3 (доска + карточка), S4 (Битрикс), S5 («Мои запросы», аналитика).
// Спека: ai_docs/fresh_docs/LOGIST_REQUESTS_SPEC.md, раздел «API».
//
// Правила совместимости: поля только ДОБАВЛЯЮТСЯ; переименование/удаление — через правку спеки
// и всех потребителей в одном коммите. Даты — ISO-строки UTC (`2026-11-19T09:30:00.000Z`),
// календарные даты — `YYYY-MM-DD`. Деньги — рубли числом. Люди — по id сотрудника Битрикса.
// Ошибки всех эндпоинтов: HTTP 4xx/5xx + `ApiError`.
// Файл без импортов рантайма — его можно тянуть и в клиентские компоненты.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── словари ─────────────────────────────────────────────────────────────────────────────

/** supply — «Запрос снабженцу», cheaper — «Есть цена дешевле». */
export type RequestType = 'supply' | 'cheaper';
export const REQUEST_TYPES: readonly RequestType[] = ['supply', 'cheaper'];
export const REQUEST_TYPE_LABEL: Record<RequestType, string> = { supply: 'Запрос снабженцу', cheaper: 'Есть цена дешевле' };

/** draft → new → in_work → answered → accepted | (возврат) in_work; cancelled — из любого незакрытого. */
export type RequestStatus = 'draft' | 'new' | 'in_work' | 'answered' | 'accepted' | 'cancelled';
export const REQUEST_STATUSES: readonly RequestStatus[] = ['draft', 'new', 'in_work', 'answered', 'accepted', 'cancelled'];
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  draft: 'Черновик', new: 'Новый', in_work: 'В работе', answered: 'Ждёт контроля', accepted: 'Принят', cancelled: 'Отменён',
};
/** Статусы, где запрос «на логисте» (идёт SLA). */
export const LOGIST_TURN: readonly RequestStatus[] = ['new', 'in_work'];
/** Незакрытые статусы (можно отменить). */
export const OPEN_STATUSES: readonly RequestStatus[] = ['draft', 'new', 'in_work', 'answered'];

export type RequestSource = 'robot' | 'button';
export type DealOutcome = 'sold' | 'lost';
export type SyncStatus = 'none' | 'pending' | 'ok' | 'error';
export type DealRowsStatus = SyncStatus | 'skipped';
/** ok — есть; none — нет в наличии; analog — предложен аналог (имя/комментарий в строке). */
export type Availability = 'ok' | 'none' | 'analog';
export type OfferStatus = 'active' | 'withdrawn' | 'accepted';
export type ItemKind = 'deal_row' | 'free';

/** Колонки вида «Доска» и «Сделки». */
export type BoardColumnKey = 'draft' | 'new' | 'in_work' | 'answered' | 'accepted' | 'cancelled' | 'sold' | 'lost';
export type BoardView = 'board' | 'deals';
export const BOARD_COLUMNS: Record<BoardView, { key: BoardColumnKey; title: string }[]> = {
  board: [
    { key: 'new', title: 'Новые' }, { key: 'in_work', title: 'В работе' },
    { key: 'answered', title: 'Ждут контроля' }, { key: 'accepted', title: 'Приняты' },
  ],
  deals: [{ key: 'sold', title: 'Проданы' }, { key: 'lost', title: 'Забракованы' }],
};

/** Журнал (logist_request_events.kind). */
export type EventKind =
  | 'created' | 'draft_updated' | 'sent' | 'taken' | 'released' | 'transferred' | 'reassigned'
  | 'answered' | 'offer_withdrawn' | 'returned' | 'accepted' | 'cancelled' | 'items_added'
  | 'message' | 'outcome' | 'bx_sync' | 'deal_rows';

// ── общие куски ─────────────────────────────────────────────────────────────────────────

export interface ApiError { error: string; /** машинный код: 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'transition' */ code?: string }

export interface PersonRef { bitrixId: string; name: string | null }

export interface QueueRef { id: number; groupId: number; name: string; region: string | null; dept: string | null }

export interface QueueMember extends PersonRef {
  role: 'logist' | 'lead';
  /** bitrix — из участников проекта (синк), manual — заведён до синка */
  source: 'bitrix' | 'manual';
  /** роль в проекте Битрикса: A владелец, E модератор, K участник */
  bxRole: string | null;
  workPosition: string | null;
  syncedAt: string | null;
}

export interface LogistQueue extends QueueRef {
  productGroups: string[];
  /** SLA цикла, рабочих часов; null — из настроек. */
  slaHours: number | null;
  active: boolean;
  source: 'supply_panel' | 'manual';
  sort: number;
  /** состав = участники проекта Битрикса (решение владельца 19.11), синк — POST /queues/sync-members и фоновая задача */
  members: QueueMember[];
  membersSyncedAt: string | null;
  /** последняя ошибка синка (состав при ошибке не меняется) */
  membersSyncError: string | null;
}

export interface FileRef { id: number; name: string; size: number | null; mime: string | null; url: string | null }

export interface DealRef {
  id: number; title: string | null; amount: number | null; categoryId: number | null; stageId: string | null;
  /** ссылка на сделку в Битриксе */
  url: string;
}

export interface ClientRef { ref: string | null; name: string | null }

// ── позиции, варианты, чат, журнал ──────────────────────────────────────────────────────

export interface RequestItem {
  id: number; pos: number; kind: ItemKind;
  bxRowId: number | null; bxProductId: number | null;
  name: string; quantity: number | null; measure: string | null;
  ourPrice: number | null; /** quantity × ourPrice */ ourSum: number | null;
  productGroup: string | null;
  /** cheaper: цена конкурента за единицу */
  competitorPrice: number | null;
  comment: string | null;
  addedInCycle: number;
  files: FileRef[];
}

export interface OfferLine {
  id: number;
  /** позиция запроса; null — новая позиция от логиста */
  itemId: number | null;
  pos: number; availability: Availability;
  name: string; bxProductId: number | null;
  quantity: number | null; measure: string | null; price: number | null;
  /** quantity × price (считает сервер) */
  sum: number | null;
  comment: string | null;
}

export interface Offer {
  id: number; n: number; cycle: number; author: PersonRef | null;
  supplier: string | null; paymentForm: string | null;
  leadTime: string | null; readyDate: string | null;
  deliveryTrucks: number | null; deliveryPrice: number | null;
  /** суммы считает сервер: goods = Σ строк (кроме availability='none'), delivery = машины × цена */
  goodsTotal: number; deliveryTotal: number; total: number;
  comment: string | null; status: OfferStatus; createdAt: string;
  lines: OfferLine[]; files: FileRef[];
}

export interface ChatMessage {
  id: number; author: PersonRef | null; authorLogin: string | null;
  body: string; createdAt: string; editedAt: string | null; deleted: boolean;
  files: FileRef[];
}

export interface RequestEvent {
  id: number; at: string; kind: EventKind; cycle: number;
  fromStatus: RequestStatus | null; toStatus: RequestStatus | null;
  queueId: number | null; actor: PersonRef | null;
  /** детали по виду: answered {offerId, n}; returned {comment}; transferred {fromQueueId, toQueueId};
   *  reassigned {from, to}; cancelled {reason}; accepted {offerId}; items_added {itemIds}; outcome {outcome} */
  data: Record<string, unknown>;
}

// ── SLA, циклы, приоритет ───────────────────────────────────────────────────────────────

export type SlaState = 'none' | 'ok' | 'hot' | 'overdue';
export interface SlaInfo {
  /** норма цикла, рабочих часов */
  hours: number;
  /** крайний срок текущего цикла; null — запрос не на логисте */
  deadline: string | null;
  /** остаток, рабочих часов (минус — просрочка); null — не на логисте */
  leftHours: number | null;
  state: SlaState;
}

/** Цикл по методике Панели снабжения: 1 — от отправки до первого ответа; N — от (N−1)-го возврата до ответа. */
export interface CycleInfo {
  n: number;
  start: string;
  take: string | null;
  answer: string | null;
  accept: string | null;
  /** возврат, закрывший этот цикл */
  returnAt: string | null;
  /** кто ответил */
  by: PersonRef | null;
  /** рабочие часы: старт→взятие, взятие→ответ, старт→ответ, старт→приёмка */
  takeH: number | null; execH: number | null; answerH: number | null; cycleH: number | null;
}

export type PriorityFactorKey = 'sla' | 'amount' | 'delivery' | 'waiting' | 'returns' | 'cheaper';
export interface PriorityFactor { key: PriorityFactorKey; points: number; label: string }
export interface PriorityInfo {
  /** чем больше, тем выше в колонке; 0 у закрытых */
  score: number;
  /** «почему горячий» — до 3 самых весомых причин */
  reasons: string[];
  factors: PriorityFactor[];
  /** огонёк на карточке */
  hot: boolean;
}

// ── настройки ───────────────────────────────────────────────────────────────────────────

export interface PriorityWeights {
  /** за просроченный SLA — разово */
  slaOverdue: number;
  /** + за каждый час просрочки (до slaOverdueCapHours) */
  slaOverduePerHour: number;
  slaOverdueCapHours: number;
  /** когда до дедлайна ≤ slaHotHours — до slaHot очков (линейно к дедлайну) */
  slaHot: number;
  /** за каждые 100 тыс. ₽ суммы сделки (до amountMax) */
  amountPer100k: number;
  amountMax: number;
  /** поставка через ≤ deliverySoonDays дней — до deliverySoon очков (дата прошла — максимум) */
  deliverySoon: number;
  deliverySoonDays: number;
  /** за рабочий час с последнего события (до waitingMax) */
  waitingPerHour: number;
  waitingMax: number;
  /** за каждый возврат */
  perReturn: number;
  /** тип cheaper — заказчик с ценой конкурента на руках */
  cheaper: number;
}

export interface LogistSettings {
  /** SLA цикла по умолчанию, рабочих часов (очередь может переопределить) */
  slaHours: number;
  /** «горит», когда до дедлайна осталось ≤ стольких рабочих часов */
  slaHotHours: number;
  /** огонёк на карточке при score ≥ hotScore */
  hotScore: number;
  weights: PriorityWeights;
  /** S2: что делает робот Битрикса на стадиях «Сделал запрос снабженцу» / «Есть цена дешевле».
   *  send — сразу в «Новые» (как бизнес-процесс сейчас; не прошли проверки отправки, например у cheaper нет
   *  цены конкурента, — черновик); draft — всегда черновик, менеджер дополняет и отправляет сам.
   *  По умолчанию send (решение владельца ещё не принято — переключатель). */
  robotMode: RobotMode;
  /** Кто из участников проекта — логист очереди (права «Взять», видимость очереди, рассылка «новый / горит SLA»);
   *  имя поля историческое (S5). Правило — recipients.ts. */
  notify: NotifyRecipientsSettings;
}
export type RobotMode = 'send' | 'draft';

/** Правило «логист очереди» (решение владельца 19.11): участник проекта — логист, если он в includeBitrixIds,
 *  либо (не в excludeBitrixIds И должность содержит одну из positionPatterns; без учёта регистра, ё = е).
 *  Пустой positionPatterns — по должности не режем (все, кроме исключённых). По умолчанию — «логист», «снабж».
 *  Действует и на права (actor.ts: очереди логиста → видимость, «Взять», «Ответить»), и на рассылку. Руководитель
 *  очереди (role lead) — логист всегда. */
export interface NotifyRecipientsSettings {
  positionPatterns: string[];
  includeBitrixIds: string[];
  excludeBitrixIds: string[];
}

// ── карточка доски и карточка запроса ───────────────────────────────────────────────────

export interface RequestCard {
  id: number; type: RequestType; status: RequestStatus; source: RequestSource;
  column: BoardColumnKey;
  deal: DealRef | null; client: ClientRef;
  manager: PersonRef; logist: PersonRef | null; queue: QueueRef | null;
  /** регион/департамент запроса = очереди (фолбэк — регион менеджера) */
  region: string | null; dept: string | null;
  productGroups: string[];
  /** «Штуцер 10 шт; Труба…» — первые позиции для карточки */
  itemsPreview: string; itemsCount: number;
  /** Σ наших сумм по позициям (если их нет — сумма сделки) */
  ourTotal: number;
  competitorTotal: number | null;
  /** сумма для сортировки и фильтра «Сумма от–до»: сумма сделки, иначе ourTotal */
  amount: number;
  deliveryDate: string | null; address: string | null;
  cycle: number; returnsCount: number; offersCount: number;
  createdAt: string; sentAt: string | null; takenAt: string | null; answeredAt: string | null;
  acceptedAt: string | null; cancelledAt: string | null; lastEventAt: string;
  /** рабочих часов с последнего события (ожидание) */
  waitingHours: number;
  sla: SlaInfo; priority: PriorityInfo;
  dealOutcome: DealOutcome | null;
  bxTaskId: number | null; bxSyncStatus: SyncStatus;
  /** непрочитанные сообщения чата для текущего пользователя */
  unread: number;
  version: number;
}

export type ActionKind =
  | 'update_draft' | 'send' | 'take' | 'release' | 'transfer' | 'reassign'
  | 'answer' | 'withdraw_offer' | 'return' | 'accept' | 'cancel' | 'add_items';
export const ACTION_KINDS: readonly ActionKind[] = [
  'update_draft', 'send', 'take', 'release', 'transfer', 'reassign', 'answer', 'withdraw_offer', 'return', 'accept', 'cancel', 'add_items',
];

/** Роль текущего пользователя относительно запроса (может быть несколько). */
export interface RequestRoles {
  manager: boolean; logist: boolean; queueMember: boolean; queueLead: boolean; rop: boolean; admin: boolean;
}

export interface RequestDetails extends RequestCard {
  purpose: string | null; paymentForm: string | null; comment: string | null; competitorName: string | null;
  acceptedOfferId: number | null; cancelReason: string | null;
  items: RequestItem[]; offers: Offer[]; messages: ChatMessage[]; events: RequestEvent[];
  watchers: PersonRef[]; files: FileRef[]; cycles: CycleInfo[];
  dealRowsStatus: DealRowsStatus; dealRowsError: string | null;
  bxSyncError: string | null;
  /** что текущий пользователь может сделать прямо сейчас — кнопки рисовать по этому */
  can: Record<ActionKind, boolean> & { message: boolean };
  roles: RequestRoles;
}

// ── фильтры доски (query string) ────────────────────────────────────────────────────────
// Списки — повторяющимися ключами (`?type=supply&queue=5&queue=7`), а не через запятую: в названиях
// товарных групп есть запятые. Разбор/сборка — parseFilters / filtersToSearchParams (engine/requests/filters.ts),
// ими же пользуется клиент (useUrlState).

export type BoardSort = 'priority' | 'sum' | 'waiting' | 'created';
export type SlaFilter = 'hot' | 'overdue';
export type OutcomeFilter = DealOutcome | 'open';

export interface LogistFilters {
  types?: RequestType[];                 // ?type=
  queues?: number[];                     // ?queue=
  regions?: string[];                    // ?region=
  depts?: string[];                      // ?dept=        ОС / НЦ
  productGroups?: string[];              // ?pg=
  managers?: string[];                   // ?manager=     bitrix id
  /** отделы менеджеров (DepartmentPicker: uuid или bitrix id отдела) — сервер разворачивает в managers */
  managerDepts?: string[];               // ?mdept=
  logists?: string[];                    // ?logist=
  mine?: boolean;                        // ?mine=1       я — логист или менеджер запроса
  untaken?: boolean;                     // ?untaken=1    никто не взял
  statuses?: RequestStatus[];            // ?status=
  sla?: SlaFilter;                       // ?sla=hot|overdue  (hot включает overdue)
  returned?: boolean;                    // ?returned=1   были возвраты
  sumMin?: number;                       // ?sumMin=
  sumMax?: number;                       // ?sumMax=
  createdFrom?: string;                  // ?from=YYYY-MM-DD (МСК)
  createdTo?: string;                    // ?to=YYYY-MM-DD
  outcome?: OutcomeFilter;               // ?outcome=sold|lost|open
  q?: string;                            // ?q=  № запроса, № сделки, заказчик, товар
  sort?: BoardSort;                      // ?sort=  по умолчанию priority
}

// ── эндпоинты ───────────────────────────────────────────────────────────────────────────

/** GET /api/logist-kanban/board?view=board|deals&<LogistFilters>&limit=100 */
export interface BoardResponse {
  view: BoardView;
  columns: { key: BoardColumnKey; title: string; total: number; cards: RequestCard[] }[];
  /** черновики текущего пользователя (менеджер) — отдельно от колонок */
  drafts: RequestCard[];
  tiles: Tiles;
  /** варианты для фильтров — из видимых пользователю запросов и справочника очередей */
  options: {
    queues: QueueRef[]; regions: string[]; depts: string[]; productGroups: string[];
    managers: PersonRef[]; logists: PersonRef[];
  };
  me: ActorInfo;
  filters: LogistFilters;
  /** сколько запросов отброшено лимитом колонки и т.п. */
  notice?: string;
}

export interface ActorInfo {
  bitrixId: string | null; name: string;
  /** canManageLogistKanban: настройки, очереди, видит всё */
  canManage: boolean;
  /** логист хотя бы одной очереди */
  isLogist: boolean;
  /** есть зона РОПа (видит запросы своих менеджеров) */
  isRop: boolean;
  queueIds: number[];
}

/** Плитки за период (по фильтрам). Скорости — медианы рабочих часов по циклам периода. */
export interface Tiles {
  periodFrom: string; periodTo: string;
  /** отправлено (событие sent) */
  newCount: number;
  /** возвращено (событие returned) */
  reopenedCount: number;
  /** старт цикла → взятие */
  takeSpeedH: number | null;
  /** старт цикла → ответ */
  answerSpeedH: number | null;
  /** взятие → ответ */
  execSpeedH: number | null;
  /** Σ суммы сделок с исходом sold среди запросов периода */
  salesSum: number;
  salesCount: number;
}

/** GET /api/logist-kanban/request/:id */
export type RequestResponse = RequestDetails;

/** Поля шапки, которые правит менеджер (черновик — все; после отправки — через add_items/чат). */
export interface DraftHeaderInput {
  type?: RequestType;
  queueId?: number | null;
  address?: string | null; purpose?: string | null; paymentForm?: string | null;
  deliveryDate?: string | null; comment?: string | null;
  competitorName?: string | null; competitorTotal?: number | null;
}

/** Позиция во вводе: id — существующая (правка), без id — новая. */
export interface ItemInput {
  id?: number;
  kind?: ItemKind;                       // по умолчанию free
  bxRowId?: number | null; bxProductId?: number | null;
  name: string; quantity?: number | null; measure?: string | null; ourPrice?: number | null;
  productGroup?: string | null; competitorPrice?: number | null; comment?: string | null;
  fileIds?: number[];
}

/** POST /api/logist-kanban/drafts → CreateDraftResponse.
 *  С dealId сервер сам читает сделку и её товары из Битрикса (crm.deal.get + crm.deal.productrows.get),
 *  подбирает очередь (регион менеджера × товарная группа первой позиции). Без dealId — пустой черновик.
 *  source='robot' — только от триггера (S2): при открытом запросе того же типа по сделке
 *  вернёт его же с created=false (повторная смена стадии не плодит черновики). */
export interface CreateDraftBody {
  type: RequestType;
  dealId?: number | null;
  /** от чьего имени (триггер); по умолчанию — текущий пользователь */
  managerBitrixId?: string;
  header?: DraftHeaderInput;
  /** если задано — заменяет товары сделки */
  items?: ItemInput[];
  /** true — без черновика: сразу отправить (статус new; проверки как у action send, при ошибке ничего не создаётся).
   *  Черновик — опционален (решение по черновикам ещё у владельца). */
  send?: boolean;
}
export interface CreateDraftResponse { request: RequestDetails; created: boolean }

/** PATCH /api/logist-kanban/request/:id — правка черновика (то же, что action update_draft). */
export interface UpdateDraftBody { version?: number; header?: DraftHeaderInput; items?: ItemInput[] }

/** POST /api/logist-kanban/request/:id/action — одно действие; ответ — свежая карточка.
 *  version (необязательно) — оптимистичная блокировка: не совпало → 409 { code: 'conflict' }. */
export type ActionBody = { version?: number } & (
  | { action: 'update_draft'; header?: DraftHeaderInput; items?: ItemInput[] }
  | { action: 'send' }
  | { action: 'take' }
  | { action: 'release'; comment?: string }
  | { action: 'transfer'; queueId: number; comment?: string }
  | { action: 'reassign'; logistBitrixId: string; logistName?: string | null; comment?: string }
  | { action: 'answer'; offer: OfferInput }
  | { action: 'withdraw_offer'; offerId: number }
  | { action: 'return'; comment: string }
  /** dealRows — подтверждение предпросмотра «было/станет» (GET /request/:id/deal-rows?offerId=, S4): { confirm: true, hash }.
   *  Без него товары сделки не переписываются (deal_rows_status='skipped'). */
  | { action: 'accept'; offerId: number; dealRows?: { confirm: true; hash: string } }
  | { action: 'cancel'; reason?: string }
  | { action: 'add_items'; items: ItemInput[] }
);
export type ActionResponse = RequestDetails & {
  /** результат хука «Принять вариант» (S4): запись товаров сделки */
  dealRows?: { status: DealRowsStatus; error?: string | null };
};

export interface OfferLineInput {
  itemId?: number | null; availability?: Availability;
  name: string; bxProductId?: number | null;
  quantity?: number | null; measure?: string | null; price?: number | null; comment?: string | null;
}
export interface OfferInput {
  supplier?: string | null; paymentForm?: string | null;
  leadTime?: string | null; readyDate?: string | null;
  deliveryTrucks?: number | null; deliveryPrice?: number | null;
  comment?: string | null;
  lines: OfferLineInput[];
  fileIds?: number[];
}

/** GET /api/logist-kanban/request/:id/messages?after=<id> → { messages } (поллинг чата)
 *  POST /api/logist-kanban/request/:id/messages  body PostMessageBody → { message } */
export interface MessagesResponse { messages: ChatMessage[]; events: RequestEvent[] }
export interface PostMessageBody { body: string; fileIds?: number[] }
export interface PostMessageResponse { message: ChatMessage }

/** GET /api/logist-kanban/deal/:dealId — для формы и кнопки «Запрос логисту» (S2):
 *  открытые запросы по сделке + подсказка очереди. Битрикс не читает. */
export interface DealRequestsResponse {
  dealId: number;
  requests: RequestCard[];
  /** открытый запрос каждого типа (если есть) */
  openByType: Partial<Record<RequestType, number>>;
}

/** GET /api/logist-kanban/queues → { queues, settings, canManage }
 *  PUT /api/logist-kanban/queues  body QueueUpsertBody (canManage) → { queue }
 *  POST /api/logist-kanban/queues/seed (canManage) → SeedQueuesResponse — посев очередей из Панели снабжения
 *  POST /api/logist-kanban/queues/sync-members (canManage) → SyncMembersResponse — состав из участников проектов Битрикса */
export interface QueuesResponse { queues: LogistQueue[]; settings: LogistSettings; canManage: boolean }
export interface QueueUpsertBody {
  id?: number; groupId: number; name: string; region?: string | null; dept?: string | null;
  productGroups?: string[]; slaHours?: number | null; active?: boolean; sort?: number;
  // состава здесь нет: он только из Битрикса (sync-members)
}
export interface SeedQueuesResponse { inserted: number; updated: number; total: number; source: string }
export interface SyncMembersResponse {
  queues: number; synced: number;
  /** проекты, которые вебхук не прочитал (права и т.п.) — их состав не тронут */
  failed: { queueId: number; groupId: number; name: string; error: string }[];
  members: number; inactiveSkipped: number;
  /** true — другой синк уже идёт, этот пропущен */
  skipped?: boolean;
}

/** GET/PUT /api/logist-kanban/settings — PUT принимает частичный LogistSettings (canManage). */
export type SettingsResponse = LogistSettings;
export type SettingsBody = Partial<Omit<LogistSettings, 'weights'>> & { weights?: Partial<PriorityWeights> };

// ── S2: триггер робота и форма менеджера ───────────────────────────────────────────────

/** Стадии сделки, на которых робот создаёт запрос (все 4 воронки). Спека, «Типы запроса». */
export const TRIGGER_STAGES: Record<RequestType, readonly string[]> = {
  supply: ['EXECUTING', 'C1:EXECUTING', 'C2:PREPARATION', 'C3:PREPARATION'],
  cheaper: ['UC_PU4HM2', 'C1:11', 'C2:4', 'C3:4'],
};

/** POST /api/logist-requests/trigger?key=<секрет>&deal=<id> — ответ роботу (ему он не нужен; для отладки). */
export interface TriggerResponse {
  ok: boolean;
  /** created — создан новый; exists — уже есть открытый того же типа; skipped — стадия не наша */
  result: 'created' | 'exists' | 'skipped';
  requestId?: number; status?: RequestStatus; type?: RequestType;
  /** почему создан черновик, а не сразу в «Новые» */
  draftReason?: string;
}

/** GET /api/logist-requests/deal/:dealId — шапка и товары сделки для формы (Битрикс, только чтение),
 *  очередь по умолчанию, открытые запросы по сделке. Ничего не создаёт. */
export interface DealSnapshotResponse {
  deal: DealRef;
  client: ClientRef;
  manager: PersonRef | null;
  address: string | null;
  items: ItemInput[];
  productGroups: string[];
  /** тип по текущей стадии сделки (если она «наша») */
  stageType: RequestType | null;
  defaultQueueId: number | null;
  openByType: Partial<Record<RequestType, number>>;
}

// ── S5: «Мои запросы» менеджера и аналитика руководителей ──────────────────────────────

/** Что ждёт от менеджера: answered — пришёл ответ (принять / вернуть); chat — непрочитанное в чате;
 *  draft — черновик не отправлен. null — ход не за ним. */
export type MyAttention = 'answered' | 'chat' | 'draft' | null;

/** GET /api/logist-kanban/my[?days=90] — свои запросы менеджера (автор или менеджер запроса), без фильтров доски.
 *  Закрытые (accepted/cancelled) — за `days` дней по последнему событию. */
export interface MyRequestsResponse {
  me: ActorInfo;
  /** все свои, новые сверху; attention — по карточке */
  cards: (RequestCard & { attention: MyAttention })[];
  counts: { attention: number; waiting: number; draft: number; closed: number };
  /** очереди — для карточки (передать в другую очередь и т.п.) */
  queues: QueueRef[];
  /** доступна ли вкладка «Аналитика» (РОП зоны / руководитель логистики / админ) */
  canAnalytics: boolean;
}

/** Уровень разреза аналитики: регион → департамент → очередь → логист (как в Панели снабжения). */
export type AnalyticsLevel = 'region' | 'dept' | 'queue' | 'logist';

export interface AnalyticsRow {
  /** путь ключей от корня (`МСК`, `МСК|ОС`, `МСК|ОС|5`, `МСК|ОС|5|2007`) — уникален, по нему раскрытие */
  key: string;
  level: AnalyticsLevel;
  label: string;
  parentKey: string | null;
  tiles: Tiles;
  /** сейчас на логисте (new/in_work) и из них с просроченным SLA — снимок на момент запроса */
  openNow: number;
  overdueNow: number;
}

/** GET /api/logist-kanban/analytics?from=&to=&<фильтры доски> — РОП (зона), руководитель логистики/админ (всё).
 *  Плитки — computeTiles по запросам узла; логист узла — текущий держатель (не взят — «не взят»). */
export interface AnalyticsResponse {
  periodFrom: string; periodTo: string;
  total: AnalyticsRow;
  rows: AnalyticsRow[];
  /** чей срез: all — весь поток, zone — менеджеры зоны РОПа */
  scope: 'all' | 'zone';
  options: BoardResponse['options'];
  filters: LogistFilters;
}
