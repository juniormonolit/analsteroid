// Модуль «Карточка клиента» (ТЗ владельца 13.10) — типы и ЧИСТЫЕ расчёты.
// Модуль без импорта БД: его читает и сервер (engine/clientModule.ts), и клиент
// (UI пересчитывает те же цифры по выбранному срезу — одна формула на клиента
// и на объект).
//
// v2 (13.10, вечер): объекты ведутся ТОЛЬКО в Монолитике (смарт-процесс в
// Битриксе упразднён), карточка — табы «Обзор / Сделки / Объекты».

import { objectKey as addrObjectKey, isPickupAddress } from '@/lib/bitrix/addressUtils';

export type ClientRef = `c${number}` | `k${number}`;

export interface ModuleProduct { name: string; quantity: number; price: number; sum: number; group: string | null; isService: boolean }

/** Стадия сделки для фильтра «Сделок»: отгрузка / продажа / в работе / отказ. */
export type DealStage = 'shipped' | 'sold' | 'active' | 'lost';
export const DEAL_STAGE_LABEL: Record<DealStage, string> = { shipped: 'Отгрузка', sold: 'Продажа', active: 'В работе', lost: 'Отказ' };

export interface ModuleDeal {
  dealId: number;
  name: string | null;
  amount: number;
  createdAt: string | null;
  soldAt: string | null;
  deliveredAt: string | null;
  lostAt: string | null;
  stageName: string | null;
  stage: DealStage;
  managerName: string | null;
  products: ModuleProduct[];
  /** Товарные группы сделки (без услуг/доставки), по убыванию суммы. */
  groups: string[];
  /** Группа с наибольшей суммой в сделке. */
  topGroup: string | null;
  /** Объект сделки (один): ручная привязка → адрес заявки 1С → адрес сделки в Битриксе. */
  objectKey: string | null;
  /** Привязка к объекту поставлена менеджером вручную. */
  objectManual: boolean;
  /** Адрес у сделки есть, но объектом не стал (только город / иностранный / неточный). */
  looseAddress: string | null;
}

export interface ModuleRequest { number: string; date: string | null }

export type AddressSource = '1c' | 'bitrix' | 'manual';
export const ADDRESS_SOURCE_LABEL: Record<AddressSource, string> = { '1c': 'из заявки 1С', bitrix: 'из адреса сделки в Битриксе', manual: 'указан менеджером' };

export interface ModuleObject {
  key: string;
  /** Автоматический адрес (1С/Битрикс); для ручного объекта — указанный менеджером. */
  address: string;
  /** Короткая подпись: «46Н-11388, микрорайон Поваровка, Поварово» (без индекса, ФО, области). */
  label: string;
  /** Сколько разных написаний адреса склеено в объект. */
  variants: number;
  lat: number | null;
  lon: number | null;
  requests: ModuleRequest[];
  /** Объект заведён менеджером вручную (в заявках/сделках адреса нет). */
  manual: boolean;
  /** Откуда автоматический адрес. */
  source: AddressSource;
}

export const CLIENT_TYPES = [
  { value: 'construction_org', label: 'Строительная организация', hint: 'Занимается любым видом строительства/монтажа/отделки' },
  { value: 'own_needs_org', label: 'Организация под собственные не строительные нужды', hint: 'Заказ под собственные нужды, нет объектов, не занимаются строительством' },
  { value: 'foreman', label: 'Прораб', hint: 'Занимается любым видом строительства/монтажа/отделки' },
  { value: 'self_builder', label: 'Строит себе', hint: 'Частный клиент строит для себя. Стадия стройки и тип дома указываются у каждого объекта' },
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number]['value'];
/** Для этих типов всплывает поле «чем занимается» (ТЗ). */
export const TYPES_WITH_OCCUPATION: ReadonlySet<string> = new Set(['construction_org', 'foreman']);

export const BUILD_STAGES = [
  { value: 'start', label: 'Начало строительства', hint: 'Заказал газобетон/кровлю/утеплитель, либо планирует ещё строить баню, сарай, веранду. Если планирует любой заказ ещё — выбирай это' },
  { value: 'mid_end', label: 'Середина / окончание', hint: 'Убедись, что клиент не будет больше заказывать. Если заказал профлист, спроси «а вы начинаете стройку?»' },
] as const;
export type BuildStage = (typeof BUILD_STAGES)[number]['value'];

export const HOUSE_TYPES = [
  { value: 'frame', label: 'Каркасный' },
  { value: 'aerated', label: 'Газобетонный' },
] as const;
export type HouseType = (typeof HOUSE_TYPES)[number]['value'];

export interface ClientProfile { clientType: ClientType | null; occupation: string; note: string; updatedBy: string | null; updatedAt: string | null }

/** Статус объекта (правило владельца 13.10). */
export type ObjectStatus = 'new' | 'active' | 'done';
export const OBJECT_STATUS_LABEL: Record<ObjectStatus, string> = { new: 'Новый', active: 'В работе', done: 'Завершён' };

export interface ObjectProfile {
  buildStage: BuildStage | null;
  houseType: HouseType | null;
  note: string;
  /** Адрес, поправленный/подтверждённый менеджером (sa.client_module_objects.address/lat/lon). */
  idealAddress: string | null;
  lat: number | null;
  lon: number | null;
  /** Менеджер подтвердил или поправил адрес — плашка «Проверь адрес» больше не нужна. */
  addressConfirmed: boolean;
  /** «Завершён» поставлен вручную. */
  doneManual: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface Recommendation {
  group: string;
  /** Вопрос из скрипта продаж (майндкарта стройки) — с него менеджер заходит. */
  ask: string | null;
  /** После какой отгруженной группы задан вопрос `ask` (или сработал ручной приоритет). */
  after: string | null;
  /** Историческая вероятность (%) перехода pctAfter → group по всей базе. */
  pct: number | null;
  pctAfter: string | null;
  /** Что сработало: цепочка стройки, история переходов, ручной приоритет «Что предложить». */
  sources: ('chain' | 'history' | 'priority')[];
}

/** Лестница стадий объекта (правка владельца 13.10): в центре — текущая группа
 *  (последняя отгруженная на объект), выше — что предложить, ниже — предыдущие
 *  этапы стройки: купленные у нас (со сделкой) или «скорее всего купил не у нас». */
export interface LadderStep {
  group: string;
  /** Наша отгрузка этой группы на объект (последняя), если была. */
  deal: { dealId: number; date: string | null; amount: number } | null;
  /** Этап предшествует текущему по цепочке стройки. */
  byChain: boolean;
}
export interface StageLadder {
  current: { group: string; dealId: number; date: string | null } | null;
  next: Recommendation[];
  before: LadderStep[];
}

export interface ClientModuleData {
  ref: ClientRef;
  clientType: 'contact' | 'company';
  clientId: number;
  name: string | null;
  deals: ModuleDeal[];
  objects: ModuleObject[];
  /** Адреса прочитались хотя бы из одного источника (1С/Битрикс). */
  addressesAvailable: boolean;
  profile: ClientProfile;
  objectProfiles: Record<string, ObjectProfile>;
  /** Таблицы ручных полей в sa есть — можно сохранять. */
  profilesAvailable: boolean;
  /** Миграция sa_org/006 накатана: ручной статус, подтверждение адреса, перепривязка сделок. */
  v2Available: boolean;
  /** N: сколько дней после последней отгрузки объект считается «В работе». */
  activeDays: number;
  recommendations: { client: Recommendation[]; byObject: Record<string, StageLadder> };
}

export const EMPTY_PROFILE: ClientProfile = { clientType: null, occupation: '', note: '', updatedBy: null, updatedAt: null };
export const EMPTY_OBJECT_PROFILE: ObjectProfile = {
  buildStage: null, houseType: null, note: '', idealAddress: null, lat: null, lon: null,
  addressConfirmed: false, doneManual: false, updatedBy: null, updatedAt: null,
};

/** Ключ нового объекта, заведённого вручную. */
export const NEW_OBJECT_KEY = 'new';
/** N по умолчанию (пока миграция 006 не накатана / настройка не задана). */
export const DEFAULT_ACTIVE_DAYS = 90;

// ── Объекты ────────────────────────────────────────────────────────────────

/** Ключ объекта по адресу (заявки 1С или сделки Битрикса — одна формула, поэтому
 *  один и тот же участок из двух источников совпадает): координаты до ~100 м,
 *  без них — нормализованная строка. Самовывоз («Париж») объектом не считается. */
export function requestObjectKey(address: string | null, lat: number | null, lon: number | null): string | null {
  if (!address && (lat === null || lon === null)) return null;
  if (isPickupAddress(address)) return null;
  return addrObjectKey({ address, lat, lon });
}

const DAY_MS = 86_400_000;

export function dealStage(d: Pick<ModuleDeal, 'deliveredAt' | 'lostAt' | 'soldAt'>): DealStage {
  if (d.deliveredAt) return 'shipped';
  if (d.lostAt) return 'lost';
  if (d.soldAt) return 'sold';
  return 'active';
}

/** «Активная» сделка — ещё не отгружена и не проиграна. */
export const isOpenDeal = (d: ModuleDeal) => d.stage === 'active' || d.stage === 'sold';

/** Статус объекта (правило владельца 13.10):
 *   Завершён — вручную, либо > N дней с последней отгрузки и нет активных сделок;
 *   В работе — есть активная сделка или с последней отгрузки ≤ N дней;
 *   Новый    — заведён вручную, сделок ещё нет. */
export function objectStatus(deals: ModuleDeal[], o: { manual: boolean; doneManual: boolean }, activeDays: number, now = Date.now()): ObjectStatus {
  if (o.doneManual) return 'done';
  if (deals.some(isOpenDeal)) return 'active';
  const last = deals.reduce<number>((m, d) => (d.deliveredAt ? Math.max(m, new Date(d.deliveredAt).getTime()) : m), 0);
  if (last && (now - last) / DAY_MS <= activeDays) return 'active';
  if (!last && o.manual) return 'new';
  return deals.length === 0 ? 'new' : 'done';
}

// ── Расчёт показателей (ТЗ а–ж) ──────────────────────────────────────────

export interface GroupStat { group: string; sum: number; deals: number; lastAt: string | null }

export interface ModuleStats {
  shipped: number;              // отгруженных
  total: number;                // всех сделок (включая отказы)
  ltv: number;                  // сумма отгруженных
  avgCheck: number | null;      // средний чек отгрузок
  cycleDays: number | null;     // среднее время между отгрузками
  lastShippedAt: string | null; // последняя отгрузка
  daysSinceLast: number | null;
  firstShippedAt: string | null;
  open: number;                 // активных сделок (в работе + продано, не отгружено)
  openSum: number;
  groups: GroupStat[];          // товарные группы по всем отгрузкам
  objects: number;              // уникальных объектов по отгрузкам
}

export function computeStats(deals: ModuleDeal[], now = Date.now()): ModuleStats {
  const shippedDeals = deals.filter(d => d.deliveredAt).sort((a, b) => a.deliveredAt!.localeCompare(b.deliveredAt!));
  const ltv = shippedDeals.reduce((s, d) => s + d.amount, 0);

  let cycleDays: number | null = null;
  if (shippedDeals.length >= 2) {
    const first = new Date(shippedDeals[0].deliveredAt!).getTime();
    const last = new Date(shippedDeals[shippedDeals.length - 1].deliveredAt!).getTime();
    // Среднее интервалов = (последняя − первая) / (n − 1).
    cycleDays = Math.round((last - first) / DAY_MS / (shippedDeals.length - 1));
  }
  const lastShippedAt = shippedDeals.length ? shippedDeals[shippedDeals.length - 1].deliveredAt : null;
  const daysSinceLast = lastShippedAt ? Math.max(0, Math.floor((now - new Date(lastShippedAt).getTime()) / DAY_MS)) : null;

  const g = new Map<string, GroupStat>();
  for (const d of shippedDeals) {
    const seen = new Set<string>();
    for (const p of d.products) {
      if (p.isService || !p.group) continue;
      const cur = g.get(p.group) ?? { group: p.group, sum: 0, deals: 0, lastAt: null };
      cur.sum += p.sum;
      if (!seen.has(p.group)) { cur.deals += 1; seen.add(p.group); }
      if (!cur.lastAt || d.deliveredAt! > cur.lastAt) cur.lastAt = d.deliveredAt;
      g.set(p.group, cur);
    }
  }
  const objects = new Set<string>();
  for (const d of shippedDeals) if (d.objectKey) objects.add(d.objectKey);
  const open = deals.filter(isOpenDeal);

  return {
    shipped: shippedDeals.length,
    total: deals.length,
    ltv,
    avgCheck: shippedDeals.length ? Math.round(ltv / shippedDeals.length) : null,
    cycleDays,
    lastShippedAt,
    daysSinceLast,
    firstShippedAt: shippedDeals[0]?.deliveredAt ?? null,
    open: open.length,
    openSum: open.reduce((s, d) => s + d.amount, 0),
    groups: [...g.values()].sort((a, b) => b.sum - a.sum),
    objects: objects.size,
  };
}

/** Дата строки сделки в таблице — дата создания (ТЗ: «Дата создания»). */
export const dealSortDate = (d: ModuleDeal) => d.createdAt ?? d.soldAt ?? d.deliveredAt ?? '';
