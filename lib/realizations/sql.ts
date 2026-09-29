// SQL раздела «Продажи → Реализация» (задача #8034). Источник — база Диспетчера
// (схема sd, зеркало 1С на MLT Supabase), только SELECT. Методика — предложение
// Софьи (owners-inbox/monolitika-realizations-logist-metrics-proposal-20260929):
//   • дубли заявок: ключ «номер + buyer_id», берётся самая свежая копия по
//     source_occurred_at; удалённые не учитываются; история статусов — со всех копий;
//   • «отгружено» = статусы «Отгружено…»/«Выполнено…», «отмена» = «Отмен…»,
//     остальное — «в работе»;
//   • суммы без НДС: продажа = строки заявки amount − vat_amount; закупка =
//     purchases.amount − amount_vat (если include_vat);
//   • приобретения с integrity_ok = false (задвоенная сумма) выводят заявку из маржи.
// Агрегация метрик — в TS (lib/realizations/metrics.ts): медианы неаддитивны, а
// одна и та же выборка нужна и в разрезе логистов, и в разрезе регионов.

/** Дедуп заявок: CTE r0 (все живые копии с rn) — общий для всех запросов раздела. */
const DEDUP = `
  r0 as (
    select r.*, row_number() over (
      partition by r.number, r.buyer_id
      order by r.source_occurred_at desc nulls last, r.updated_at desc nulls last, r.id
    ) rn
    from sd.requests r
    where not coalesce(r.deleted, false)
  )`;

const GROUP_EXPR = `case when r.status ~* '^(Отгружено|Выполнено)' then 'shipped'
                         when r.status ~* '^Отмен' then 'cancelled' else 'in_work' end`;

/** Заявки когорты (плановая отгрузка в [$1; $2]) со всеми полями для списка и сводки. */
export const SQL_PERIOD_REQUESTS = `
with ${DEDUP},
r as (
  select r0.* from r0 r0
  where r0.rn = 1 and r0.shipment_date between $1::date and $2::date
),
copies as (
  select r.id rid, c.id cid from r join r0 c on c.number = r.number and c.buyer_id is not distinct from r.buyer_id
),
h as materialized (
  select c.rid,
    min(sh.changed_at) filter (where sh.new_status ~* '^Отгружено') first_ship,
    min(sh.changed_at) filter (where sh.new_status = 'Новая заявка') first_new,
    min(sh.changed_at) filter (where sh.new_status = 'Взята в работу') first_take,
    bool_or(sh.new_status = 'Отгружено, требует правки логиста') had_fix
  from copies c join sd.status_history sh on sh.doc_kind = 'request' and sh.document_id = c.cid
  group by c.rid
),
s as materialized (
  select l.request_id,
    sum(l.amount - coalesce(l.vat_amount, 0)) sales_nv,
    sum(l.amount) sales_vat,
    sum(l.amount - coalesce(l.vat_amount, 0)) filter (where n.name ilike '%доставк%') d_sale
  from sd.request_item_lines l
  join r on r.id = l.request_id
  left join sd.nomenclature n on n.id = l.nomenclature_id
  group by 1
),
p as materialized (
  select p.request_id, count(*) n,
    bool_or(p.integrity_ok = false) broken,
    sum(p.amount - case when p.include_vat then coalesce(p.amount_vat, 0) else 0 end) purch_nv
  from sd.purchases p join r on r.id = p.request_id
  where not coalesce(p.deleted, false)
  group by 1
),
d as materialized (
  select p.request_id,
    sum(pl.amount - case when p.include_vat then coalesce(pl.vat_amount, 0) else 0 end) d_cost
  from sd.purchases p
  join r on r.id = p.request_id
  join sd.purchase_lines pl on pl.purchase_id = p.id
  join sd.nomenclature n on n.id = pl.nomenclature_id
  where not coalesce(p.deleted, false)
    and n.name in ('Доставка', 'Доставка для логистов (не трогать)')
  group by 1
)
select r.id, r.number, r.doc_date, r.status, ${GROUP_EXPR} grp,
  b.name buyer, m.name manager, r.logist_id, l.name logist,
  r.shipment_date::text shipment_date, r.creation_date_1c,
  s.sales_nv, s.sales_vat, s.d_sale, p.n purchases_n, coalesce(p.broken, false) broken, p.purch_nv, d.d_cost,
  h.first_ship, h.first_new, h.first_take, coalesce(h.had_fix, false) had_fix
from r
left join h on h.rid = r.id
left join s on s.request_id = r.id
left join p on p.request_id = r.id
left join d on d.request_id = r.id
left join sd.counterparties b on b.id = r.buyer_id
left join sd.users_1c m on m.id = r.manager_id
left join sd.users_1c l on l.id = r.logist_id
order by r.shipment_date desc, r.number desc`;

/** М4: интервалы «статус → следующая запись истории» по заявкам когорты (все копии). */
export const SQL_STATUS_INTERVALS = `
with ${DEDUP},
r as (select r0.* from r0 r0 where r0.rn = 1 and r0.shipment_date between $1::date and $2::date),
ev as (
  select r.id rid, r.logist_id, sh.new_status, sh.changed_at,
    lead(sh.changed_at) over (partition by r.id order by sh.changed_at, sh.id) next_at
  from r
  join r0 c on c.number = r.number and c.buyer_id is not distinct from r.buyer_id
  join sd.status_history sh on sh.doc_kind = 'request' and sh.document_id = c.id
)
select logist_id, new_status status, extract(epoch from next_at - changed_at) / 3600 hours
from ev where next_at is not null`;

/** М5: просрочки на сегодня (все даты): план отгрузки прошёл, заявка «в работе». */
export const SQL_OVERDUE = `
with ${DEDUP}
select r.logist_id, r.shipment_date::text shipment_date
from r0 r
where r.rn = 1
  and r.shipment_date < (now() at time zone 'Europe/Moscow')::date
  and ${GROUP_EXPR} = 'in_work'`;

/** М12: приобретения без заявки за период (по doc_date, МСК) — по автору документа. */
export const SQL_ORPHAN_PURCHASES = `
select coalesce(nullif(p.creator, ''), '—') creator, count(*) n, sum(p.amount) amount_vat,
  count(*) filter (where p.operation ilike '%подотчет%') n_accountable
from sd.purchases p
where p.request_id is null and not coalesce(p.deleted, false)
  and (p.doc_date at time zone 'Europe/Moscow')::date between $1::date and $2::date
group by 1 order by 2 desc`;

/** Логисты, встречающиеся в заявках (для фильтра и регионов). */
export const SQL_LOGISTS = `
select distinct l.id, l.name from sd.requests r join sd.users_1c l on l.id = r.logist_id
where not coalesce(r.deleted, false) and r.shipment_date >= $1::date - 180
order by l.name`;

// ── Карточка заявки ─────────────────────────────────────────────────────────
export const SQL_CARD_HEAD = `
select r.id, r.number, r.doc_date, r.status, r.posted, r.shipment_date::text shipment_date,
  r.shipment_time_start::text shipment_time_start, r.shipment_time_end::text shipment_time_end,
  r.address, r.amount, r.payment_form, r.payment_method, r.comment, r.shipment_comment,
  r.cancel_reason, r.not_shipped_comment, r.creation_date_1c,
  b.name buyer, m.name manager, r.logist_id, l.name logist, o.name organization
from sd.requests r
left join sd.counterparties b on b.id = r.buyer_id
left join sd.counterparties o on o.id = r.organization_id
left join sd.users_1c m on m.id = r.manager_id
left join sd.users_1c l on l.id = r.logist_id
where r.id = $1 and not coalesce(r.deleted, false)`;

export const SQL_CARD_LINES = `
select l.line_number, n.name nomenclature, l.characteristic, l.quantity, l.unit, l.price, l.amount, l.vat_amount
from sd.request_item_lines l left join sd.nomenclature n on n.id = l.nomenclature_id
where l.request_id = $1 order by l.line_number`;

export const SQL_CARD_PURCHASES = `
select p.id, p.number, p.doc_date, p.posted, p.operation, p.include_vat, p.amount, p.amount_vat,
  p.integrity_ok, s.name supplier, p.creator,
  (select count(*) from sd.purchase_lines pl where pl.purchase_id = p.id) lines_n
from sd.purchases p left join sd.counterparties s on s.id = p.supplier_id
where p.request_id = $1 and not coalesce(p.deleted, false)
order by p.doc_date`;

/** История статусов — со всех копий заявки (тот же ключ «номер + buyer_id»). */
export const SQL_CARD_HISTORY = `
select sh.changed_at, sh.old_status, sh.new_status
from sd.requests r
join sd.requests c on c.number = r.number and c.buyer_id is not distinct from r.buyer_id
join sd.status_history sh on sh.doc_kind = 'request' and sh.document_id = c.id
where r.id = $1
order by sh.changed_at, sh.id`;
