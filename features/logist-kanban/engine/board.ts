// «Канбан логиста» (владелец 09.11, прототип). Заявки 1С (sd — зеркало 1С, только SELECT)
// + своя таблица статусов карточек logist_kanban_cards (systemDb, миграция 261).
//
// Колонки: «Можно попробовать» — заявки под фильтрами логиста, которых ещё никто не взял;
// «В работе» / «Успешно» / «Не вышло» — заявки со строкой в logist_kanban_cards (показываются
// независимо от фильтров пула: взятое не должно пропадать из-за смены фильтра).
//
// Чек = сумма заявки (r.amount, с НДС) — решение владельца 09.11.
// Филиал = регион логиста по ФИО/номеру (lib/realizations/region.ts, как в «Реализации»);
// у заявки без логиста — по метке региона в имени менеджера, иначе «Без региона».
// Дубли заявок — тот же ключ, что в «Реализации»: номер + покупатель, самая свежая копия.

import { sdDb, systemDb } from '@/lib/db/clients';
import { cached } from '@/lib/cache/redis';
import { regionOf, type Region } from '@/lib/realizations/region';

export type CardStatus = 'pool' | 'in_work' | 'success' | 'fail';
export const STORED_STATUSES = ['in_work', 'success', 'fail'] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];

export interface BoardFilters {
  region: Region | '';
  minAmount: number;
  statuses: string[];
  /** Подстрока номенклатуры (товар или группа: «газобетон», «D500»). */
  goods: string;
  days: number;
  mine: boolean;
}

export interface BoardCard {
  key: string;
  id: string;
  number: string;
  docDate: string | null;
  status1c: string;
  amount: number | null;
  shipmentDate: string | null;
  buyer: string | null;
  manager: string | null;
  logist: string | null;
  region: Region;
  goods: string[];
  linesN: number;
  board: CardStatus;
  owner: string | null;
  ownerLogin: string | null;
  note: string | null;
  updatedAt: string | null;
}

const DEDUP = `
  r0 as (
    select r.*, row_number() over (
      partition by r.number, r.buyer_id
      order by r.source_occurred_at desc nulls last, r.updated_at desc nulls last, r.id
    ) rn
    from sd.requests r
    where not coalesce(r.deleted, false)
  )`;

const CARD_COLS = `
  r.id, r.number, r.buyer_id::text buyer_id, r.doc_date, r.status, r.amount, r.shipment_date::text shipment_date,
  b.name buyer, m.name manager, l.name logist,
  g.goods, coalesce(g.lines_n, 0) lines_n`;

// Топ-3 позиции по сумме — на карточке видно «что продали», не открывая заявку.
const CARD_JOINS = `
  left join sd.counterparties b on b.id = r.buyer_id
  left join sd.users_1c m on m.id = r.manager_id
  left join sd.users_1c l on l.id = r.logist_id
  left join lateral (
    select count(*) lines_n,
      (array_agg(coalesce(n.name, '—') order by li.amount desc nulls last))[1:3] goods
    from sd.request_item_lines li left join sd.nomenclature n on n.id = li.nomenclature_id
    where li.request_id = r.id
  ) g on true`;

/** Пул: живые заявки за `days` дней по дате заявки, сумма ≥ N, статусы 1С, товар. */
const SQL_POOL = `
with ${DEDUP},
r as (
  select r0.* from r0
  where r0.rn = 1
    and r0.doc_date >= (now() at time zone 'Europe/Moscow')::date - $1::int
    and coalesce(r0.amount, 0) >= $2::numeric
    and (cardinality($3::text[]) = 0 or r0.status = any($3::text[]))
    and ($4::text is null or exists (
      select 1 from sd.request_item_lines li join sd.nomenclature n on n.id = li.nomenclature_id
      where li.request_id = r0.id and n.name ilike $4::text))
  order by r0.amount desc nulls last
  limit 3000
)
select ${CARD_COLS} from r ${CARD_JOINS}
order by r.amount desc nulls last`;

/** Взятые в работу — по ключам из logist_kanban_cards, без фильтров пула. */
const SQL_BY_KEYS = `
with ${DEDUP}
select ${CARD_COLS}
from r0 r ${CARD_JOINS}
where r.rn = 1 and (r.number || '|' || coalesce(r.buyer_id::text, '')) = any($1::text[])`;

const SQL_STATUSES = `
with ${DEDUP}
select status, count(*)::int n from r0
where rn = 1 and doc_date >= (now() at time zone 'Europe/Moscow')::date - $1::int and status is not null
group by 1 order by 2 desc`;

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

function regionFor(logist: string | null, manager: string | null): Region {
  const byLogist = regionOf(logist);
  if (byLogist !== 'Без региона') return byLogist;
  const label = (manager ?? '').match(/\((СПБ|МСК|КРД)\)/i);
  return label ? (label[1].toUpperCase() as Region) : 'Без региона';
}

type SdRow = Record<string, unknown>;
function toCard(r: SdRow): Omit<BoardCard, 'board' | 'owner' | 'ownerLogin' | 'note' | 'updatedAt'> {
  const logist = (r.logist as string) ?? null;
  const manager = (r.manager as string) ?? null;
  return {
    key: `${r.number}|${r.buyer_id ?? ''}`,
    id: String(r.id),
    number: String(r.number),
    docDate: iso(r.doc_date),
    status1c: String(r.status ?? '—'),
    amount: num(r.amount),
    shipmentDate: (r.shipment_date as string) ?? null,
    buyer: (r.buyer as string) ?? null,
    manager, logist,
    region: regionFor(logist, manager),
    goods: Array.isArray(r.goods) ? (r.goods as string[]) : [],
    linesN: Number(r.lines_n ?? 0),
  };
}

interface StoredRow { request_key: string; status: StoredStatus; note: string | null; owner_login: string; owner_name: string | null; updated_at: Date }

/** null — таблицы ещё нет (миграция 261 не накачена): доска работает только на чтение. */
async function loadStored(): Promise<StoredRow[] | null> {
  try {
    const { rows } = await systemDb().query<StoredRow>(
      `select request_key, status, note, owner_login, owner_name, updated_at
         from logist_kanban_cards order by updated_at desc limit 1000`);
    return rows;
  } catch (e) {
    if ((e as { code?: string }).code === '42P01') return null;
    throw e;
  }
}

function likePattern(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  return `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`;
}

export async function loadBoard(f: BoardFilters, login: string) {
  const goods = likePattern(f.goods);
  const poolKey = `logist-kanban:pool:v1:${f.days}:${f.minAmount}:${f.statuses.join('\u0001')}:${goods ?? ''}`;
  const [poolRows, statusRows, stored] = await Promise.all([
    cached(poolKey, 120, async () => (await sdDb().query(SQL_POOL, [f.days, f.minAmount, f.statuses, goods])).rows as SdRow[]),
    cached(`logist-kanban:statuses:v1:${f.days}`, 300, async () => (await sdDb().query(SQL_STATUSES, [f.days])).rows as SdRow[]),
    loadStored(),
  ]);
  const storedMap = new Map((stored ?? []).map(s => [s.request_key, s]));

  const pool: BoardCard[] = [];
  for (const r of poolRows) {
    const c = toCard(r);
    if (storedMap.has(c.key)) continue;
    if (f.region && c.region !== f.region) continue;
    pool.push({ ...c, board: 'pool', owner: null, ownerLogin: null, note: null, updatedAt: null });
  }

  const taken: BoardCard[] = [];
  const keys = [...storedMap.keys()];
  if (keys.length) {
    const { rows } = await sdDb().query(SQL_BY_KEYS, [keys]);
    const byKey = new Map(rows.map(r => { const c = toCard(r); return [c.key, c] as const; }));
    for (const s of stored ?? []) {
      const c = byKey.get(s.request_key);
      if (!c) continue; // заявку удалили в 1С
      if (f.mine && s.owner_login !== login) continue;
      taken.push({ ...c, board: s.status, owner: s.owner_name ?? s.owner_login, ownerLogin: s.owner_login, note: s.note, updatedAt: iso(s.updated_at) });
    }
  }

  return {
    cards: [...pool, ...taken],
    poolTotal: pool.length,
    statuses: statusRows.map(r => ({ value: String(r.status), n: Number(r.n) })),
    readOnly: stored === null,
  };
}

export async function setCardStatus(input: { key: string; requestId: string; status: CardStatus; note: string | null }, user: { login: string; name: string | null }) {
  const db = systemDb();
  if (input.status === 'pool') {
    await db.query(`delete from logist_kanban_cards where request_key = $1`, [input.key]);
    return;
  }
  // Взял в работу — становится владельцем; итог (успешно/не вышло) владельца не меняет.
  await db.query(
    `insert into logist_kanban_cards (request_key, request_id, status, note, owner_login, owner_name, updated_by)
     values ($1, $2, $3, $4, $5, $6, $5)
     on conflict (request_key) do update set
       request_id = excluded.request_id, status = excluded.status,
       note = coalesce(excluded.note, logist_kanban_cards.note),
       owner_login = case when excluded.status = 'in_work' and logist_kanban_cards.status <> 'in_work'
                          then excluded.owner_login else logist_kanban_cards.owner_login end,
       owner_name  = case when excluded.status = 'in_work' and logist_kanban_cards.status <> 'in_work'
                          then excluded.owner_name else logist_kanban_cards.owner_name end,
       updated_by = excluded.updated_by, updated_at = now()`,
    [input.key, input.requestId, input.status, input.note, user.login, user.name]);
}
