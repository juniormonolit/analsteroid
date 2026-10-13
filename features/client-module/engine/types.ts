// Модуль «Карточка клиента» (ТЗ владельца 13.10) — типы и ЧИСТЫЕ расчёты.
// Модуль без импорта БД: его читает и сервер (engine/clientModule.ts), и клиент
// (UI пересчитывает те же цифры по выбранному объекту — одна формула на клиента
// и на объект, как требует ТЗ: «те же самые поля, но по этому объекту»).

import { objectKey as addrObjectKey, isPickupAddress } from '@/lib/bitrix/addressUtils';

export type ClientRef = `c${number}` | `k${number}`;

export interface ModuleProduct { name: string; quantity: number; price: number; sum: number; group: string | null; isService: boolean }

export interface ModuleDeal {
  dealId: number;
  name: string | null;
  amount: number;
  createdAt: string | null;
  soldAt: string | null;
  deliveredAt: string | null;
  lostAt: string | null;
  stageName: string | null;
  managerName: string | null;
  products: ModuleProduct[];
  /** Товарные группы сделки (без услуг/доставки) — строка списка «как на скрине». */
  groups: string[];
  /** Объекты (адреса заявок 1С/Пульта), к которым относится сделка. */
  objectKeys: string[];
}

export interface ModuleRequest { number: string; date: string | null }

export interface ModuleObject {
  key: string;
  /** Адрес из заявок 1С (для ручного объекта — его «идеальный» адрес). */
  address: string;
  lat: number | null;
  lon: number | null;
  requests: ModuleRequest[];
  /** Объект заведён менеджером вручную (в заявках 1С его нет — сделки к нему не привязаны). */
  manual: boolean;
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
export interface ObjectProfile {
  buildStage: BuildStage | null;
  /** Стадию закрыл админ в Битриксе («Стройка завершена» / «Неактуален») — виджет её не перетирает. */
  closedStage: 'done' | 'inactive' | null;
  houseType: HouseType | null;
  note: string;
  /** «Адрес идеальный» и его точка (sa.client_module_objects.address/lat/lon). */
  idealAddress: string | null;
  lat: number | null;
  lon: number | null;
  bitrixItemId: number | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface ClientModuleData {
  ref: ClientRef;
  clientType: 'contact' | 'company';
  clientId: number;
  name: string | null;
  deals: ModuleDeal[];
  objects: ModuleObject[];
  /** sa.request_addresses прочиталась (false — view недоступна, объекты пусты честно). */
  addressesAvailable: boolean;
  profile: ClientProfile;
  objectProfiles: Record<string, ObjectProfile>;
  /** Таблицы ручных полей накатаны (миграция sa_org/005) — можно сохранять. */
  profilesAvailable: boolean;
}

export const EMPTY_PROFILE: ClientProfile = { clientType: null, occupation: '', note: '', updatedBy: null, updatedAt: null };
export const EMPTY_OBJECT_PROFILE: ObjectProfile = {
  buildStage: null, closedStage: null, houseType: null, note: '', idealAddress: null, lat: null, lon: null, bitrixItemId: null, updatedBy: null, updatedAt: null,
};

/** Ключ нового объекта, заведённого вручную (не из заявок 1С). */
export const NEW_OBJECT_KEY = 'new';

// ── Объекты ────────────────────────────────────────────────────────────────

/** Ключ объекта по адресу заявки. Та же формула, что у «Карты объектов» и
 *  карточки заказчика (lib/bitrix/addressUtils.objectKey): координаты до ~100 м,
 *  без них — нормализованная строка. Самовывоз («Париж») объектом не считается. */
export function requestObjectKey(address: string | null, lat: number | null, lon: number | null): string | null {
  if (!address && (lat === null || lon === null)) return null;
  if (isPickupAddress(address)) return null;
  return addrObjectKey({ address, lat, lon });
}

// ── Расчёт полей ТЗ (а–g) ─────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface GroupStat { group: string; sum: number; deals: number }

export interface ModuleStats {
  shipped: number;              // а) отгруженных
  total: number;                // а) всех сделок (включая отказы — решение владельца 13.10)
  ltv: number;                  // б) сумма отгруженных
  avgCheck: number | null;      // в) средний чек отгрузок
  cycleDays: number | null;     // г) среднее время между отгрузками
  lastShippedAt: string | null; // д) последняя отгрузка
  daysSinceLast: number | null; // д) дней с последней
  groups: GroupStat[];          // е) товарные группы по всем отгрузкам
  objects: number;              // ж) уникальных адресов по отгрузкам
}

export function computeStats(deals: ModuleDeal[], now = Date.now()): ModuleStats {
  const shippedDeals = deals.filter(d => d.deliveredAt).sort((a, b) => a.deliveredAt!.localeCompare(b.deliveredAt!));
  const ltv = shippedDeals.reduce((s, d) => s + d.amount, 0);

  let cycleDays: number | null = null;
  if (shippedDeals.length >= 2) {
    const first = new Date(shippedDeals[0].deliveredAt!).getTime();
    const last = new Date(shippedDeals[shippedDeals.length - 1].deliveredAt!).getTime();
    // Среднее интервалов = (последняя − первая) / (n − 1) — то же, что среднее
    // попарных разниц соседних отгрузок, без накопления округлений.
    cycleDays = Math.round((last - first) / DAY_MS / (shippedDeals.length - 1));
  }

  const lastShippedAt = shippedDeals.length ? shippedDeals[shippedDeals.length - 1].deliveredAt : null;
  const daysSinceLast = lastShippedAt ? Math.max(0, Math.floor((now - new Date(lastShippedAt).getTime()) / DAY_MS)) : null;

  const g = new Map<string, GroupStat>();
  for (const d of shippedDeals) {
    const seen = new Set<string>();
    for (const p of d.products) {
      if (p.isService || !p.group) continue;
      const cur = g.get(p.group) ?? { group: p.group, sum: 0, deals: 0 };
      cur.sum += p.sum;
      if (!seen.has(p.group)) { cur.deals += 1; seen.add(p.group); }
      g.set(p.group, cur);
    }
  }

  const objects = new Set<string>();
  for (const d of shippedDeals) for (const k of d.objectKeys) objects.add(k);

  return {
    shipped: shippedDeals.length,
    total: deals.length,
    ltv,
    avgCheck: shippedDeals.length ? Math.round(ltv / shippedDeals.length) : null,
    cycleDays,
    lastShippedAt,
    daysSinceLast,
    groups: [...g.values()].sort((a, b) => b.sum - a.sum),
    objects: objects.size,
  };
}

/** Статус сделки для списка «все сделки». */
export function dealStatus(d: ModuleDeal): { label: string; tone: 'ok' | 'neg' | 'muted' | 'warn' } {
  if (d.deliveredAt) return { label: 'Отгружена', tone: 'ok' };
  if (d.lostAt) return { label: 'Отказ', tone: 'neg' };
  if (d.soldAt) return { label: 'Продана', tone: 'warn' };
  return { label: d.stageName ?? 'В работе', tone: 'muted' };
}
