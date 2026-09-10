// Доказательства диагноза (владелец 10.09: «как принять решение, если нет ни ссылок на сделки,
// ни примеров — зато JSON-трасса, заебись»). По диагнозу возвращаем КОНКРЕТНЫЕ сделки или
// клиентов, из которых сложилась цифра: что открыть, кому звонить, что добить или закрыть.
// Все запросы — к живым sa/va, атрибуция d.current_manager_id, потолок 60 строк.
import { analyticsDb, systemDb } from '@/lib/db/clients';
import { loadPriceStageSets } from '@/lib/settings/priceStageMarkup';
import { loadZombieThresholds } from './refs';
import { loadDiagSettings } from './settings';
import { loadCompanyExpected } from './crossSell';

export interface EvidenceColumn { key: string; label: string; align?: 'left' | 'right' }
export interface EvidenceRow { dealId?: number; clientKey?: string; cells: Record<string, string | number | null> }
export interface Evidence { title: string; hint: string; columns: EvidenceColumn[]; rows: EvidenceRow[]; total: number; kind: 'deals' | 'clients' | 'none' }

const LIMIT = 60;
const dt = (v: Date | string | null) => (v ? new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
const days = (v: Date | string | null) => (v ? Math.floor((Date.now() - new Date(v).getTime()) / 86400000) : null);
const rub = (v: string | number | null) => (v === null ? null : Math.round(Number(v)));

const COLS = {
  deal: { key: 'deal', label: 'Сделка', align: 'left' as const },
  group: { key: 'group', label: 'Товарная группа', align: 'left' as const },
  amount: { key: 'amount', label: 'Сумма, ₽', align: 'right' as const },
  created: { key: 'created', label: 'Создана', align: 'right' as const },
};

async function sa<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
  const c = await analyticsDb().connect();
  try { await c.query(`SET statement_timeout = '60s'`); return (await c.query<T>(sql, params)).rows; } finally { c.release(); }
}

/** Доказательства по узлу/рычагу диагноза. nodeId — то, что просело (или рычаг). */
export async function loadEvidence(nodeId: string, managerId: number): Promise<Evidence> {
  const s = await loadDiagSettings();
  const none: Evidence = { title: '', hint: '', columns: [], rows: [], total: 0, kind: 'none' };

  // ── Зомби: открытые сделки без брони дольше порога своей группы ────────────
  if (nodeId === 'zombie_share' || nodeId === 'zombie_count') {
    const z = await loadZombieThresholds();
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; zdays: number; last_call: Date | null; calls: string }>(
      `WITH z AS (SELECT * FROM unnest($2::text[], $3::int[]) AS t(head_group_name, days))
       SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, coalesce(z.days, $4::int) AS zdays,
              (SELECT max(c.called_at) FROM va.calls c WHERE c.deal_id = d.deal_id) AS last_call,
              (SELECT count(*)::text FROM va.calls c WHERE c.deal_id = d.deal_id) AS calls
         FROM sa.deals d LEFT JOIN z ON z.head_group_name = d.head_group_name
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.sold_at IS NULL AND d.lost_at IS NULL
          AND d.reserved_at IS NULL AND d.created_at + make_interval(days => coalesce(z.days, $4::int)) < now()
        ORDER BY d.amount DESC NULLS LAST LIMIT ${LIMIT}`, [managerId, z.groups, z.days, z.fallback]);
    return {
      kind: 'deals', title: 'Зомби-сделки: висят без брони дольше нормы своей группы',
      hint: 'По статистике такие сделки почти не продаются. Их надо добить звонком или честно закрыть — они портят конверсию и прячут реальную воронку.',
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'age', label: 'Дней висит', align: 'right' }, { key: 'zdays', label: 'Норма группы', align: 'right' }, { key: 'calls', label: 'Звонков', align: 'right' }, { key: 'last_call', label: 'Последний звонок', align: 'right' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at), age: days(r.created_at), zdays: r.zdays, calls: Number(r.calls), last_call: r.last_call ? `${days(r.last_call)} дн назад` : 'не звонили' } })),
      total: rows.length,
    };
  }

  // ── Тишина: открытые сделки без звонка 7+ дней ─────────────────────────────
  if (nodeId === 'calls_silence_deals') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; last_call: Date | null; stage_id: string | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.stage_id,
              (SELECT max(c.called_at) FROM va.calls c WHERE c.deal_id = d.deal_id) AS last_call
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.sold_at IS NULL AND d.lost_at IS NULL
          AND d.created_at < now() - interval '7 days'
          AND coalesce((SELECT max(c.called_at) FROM va.calls c WHERE c.deal_id = d.deal_id), d.created_at) < now() - interval '7 days'
        ORDER BY d.amount DESC NULLS LAST LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Сделки в тишине: ни одного звонка 7+ дней',
      hint: 'Клиент ждёт или уже ушёл к другим. Позвонить сегодня — самое дешёвое действие из возможных.',
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'silence', label: 'Дней тишины', align: 'right' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at), silence: days(r.last_call ?? r.created_at) } })),
      total: rows.length,
    };
  }

  // ── Прозвон броней: брони, не прозвонённые на следующий рабочий день ───────
  if (nodeId === 'booking_call_rate_reserved') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; reserved_at: Date; sold_at: Date | null; lost_at: Date | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.reserved_at, d.sold_at, d.lost_at
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.reserved_at IS NOT NULL
          AND d.reserved_at >= now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d.deal_id AND c.direction::text = 'outbound'
                            AND c.called_at > d.reserved_at AND c.called_at < d.reserved_at + interval '3 days')
        ORDER BY d.reserved_at DESC LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Брони без звонка на следующий день',
      hint: 'Бронь без подтверждающего звонка — главный источник потерь: клиент не подтверждает, а срок брони уходит.',
      columns: [COLS.deal, COLS.group, COLS.amount, { key: 'reserved', label: 'Бронь', align: 'right' }, { key: 'result', label: 'Чем закончилось', align: 'left' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), reserved: dt(r.reserved_at), result: r.sold_at ? 'продано' : r.lost_at ? 'ОТКАЗ' : 'ещё открыта' } })),
      total: rows.length,
    };
  }

  // ── Скорость первого касания: сделки, где звонок был позже нормы ───────────
  if (nodeId === 'calls_touch_speed_median') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; first_call: Date | null; minutes: string | null; sold_at: Date | null; lost_at: Date | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.sold_at, d.lost_at,
              fc.first_call, (EXTRACT(epoch FROM (fc.first_call - d.created_at)) / 60)::text AS minutes
         FROM sa.deals d
         LEFT JOIN LATERAL (SELECT min(c.called_at) AS first_call FROM va.calls c WHERE c.deal_id = d.deal_id AND c.result = 'completed' AND c.called_at >= d.created_at) fc ON true
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.created_at >= now() - interval '60 days'
          AND (fc.first_call IS NULL OR fc.first_call - d.created_at > interval '60 minutes')
        ORDER BY (fc.first_call IS NULL) DESC, fc.first_call - d.created_at DESC NULLS FIRST LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Сделки, где первый разговор случился позже часа (или не случился)',
      hint: 'Чем позже первый живой разговор, тем ниже шанс продажи: клиент за это время звонит конкурентам. Норма — до 60 минут.',
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'touch', label: 'До разговора', align: 'right' }, { key: 'result', label: 'Чем закончилось', align: 'left' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: {
        deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at),
        touch: r.minutes === null ? 'разговора не было' : Number(r.minutes) >= 120 ? `${(Number(r.minutes) / 60).toFixed(1)} ч` : `${Math.round(Number(r.minutes))} мин`,
        result: r.sold_at ? 'продано' : r.lost_at ? 'ОТКАЗ' : 'открыта' } })),
      total: rows.length,
    };
  }

  // ── Скорость до цены ──────────────────────────────────────────────────────
  if (nodeId === 'price_speed_median_hours' || nodeId === 'cr_deal_to_priced') {
    const { hasPrice } = await loadPriceStageSets();
    const noPrice = nodeId === 'cr_deal_to_priced';
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; priced_at: Date | null; hours: string | null; sold_at: Date | null; lost_at: Date | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.sold_at, d.lost_at,
              pe.priced_at, (EXTRACT(epoch FROM (pe.priced_at - d.created_at)) / 3600)::text AS hours
         FROM sa.deals d
         LEFT JOIN LATERAL (SELECT min(e.event_at) AS priced_at FROM sa.deal_events e WHERE e.deal_id = d.deal_id AND e.stage_id = ANY($2::text[])) pe ON true
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.created_at >= now() - interval '60 days'
          AND ${noPrice ? 'pe.priced_at IS NULL AND (d.sold_at IS NOT NULL OR d.lost_at IS NOT NULL)' : "(pe.priced_at IS NULL OR pe.priced_at - d.created_at > interval '8 hours')"}
        ORDER BY ${noPrice ? 'd.amount DESC NULLS LAST' : '(pe.priced_at IS NULL) DESC, pe.priced_at - d.created_at DESC NULLS FIRST'} LIMIT ${LIMIT}`, [managerId, hasPrice]);
    return {
      kind: 'deals',
      title: noPrice ? 'Сделки, закрытые вообще без озвученной цены' : 'Сделки, где цену озвучили позже 8 часов (или не озвучили)',
      hint: noPrice ? 'Клиент так и не услышал цену — либо не дозвонились, либо не запросили у снабжения. Это потерянные сделки без попытки.' : 'Пока цены нет, клиент не может решать. Долгая цена — обычно запрос снабженцу, про который забыли.',
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'price', label: 'До цены', align: 'right' }, { key: 'result', label: 'Чем закончилось', align: 'left' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: {
        deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at),
        price: r.hours === null ? 'цены не было' : `${Number(r.hours).toFixed(1)} ч`,
        result: r.sold_at ? 'продано' : r.lost_at ? 'ОТКАЗ' : 'открыта' } })),
      total: rows.length,
    };
  }

  // ── Сделки без единого звонка ─────────────────────────────────────────────
  if (nodeId === 'calls_deals_no_call') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; sold_at: Date | null; lost_at: Date | null; stage_id: string | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.sold_at, d.lost_at, d.stage_id
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.created_at >= now() - interval '90 days'
          AND NOT EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d.deal_id)
        ORDER BY d.amount DESC NULLS LAST LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Сделки, по которым не было ни одного звонка',
      hint: 'Ни входящего, ни исходящего разговора вообще. Проверить: это брак распределения, дубли — или реально не взяли в работу.',
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'result', label: 'Чем закончилось', align: 'left' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at), result: r.sold_at ? 'продано' : r.lost_at ? 'ОТКАЗ' : 'открыта' } })),
      total: rows.length,
    };
  }

  // ── Кросс-продажа: клиенты, купившие A и не взявшие ожидаемое B ───────────
  if (nodeId === 'cross_sell_expected_share') {
    const expected = await loadCompanyExpected();
    const pairs = [...expected.entries()].map(([from, v]) => ({ from, to: v.to }));
    if (!pairs.length) return none;
    const rows = await sa<{ contact_id: string; last_at: Date; from_cats: string[]; amount: string | null; deal_id: string; deal_name: string | null }>(
      `WITH deal_cats AS (
         SELECT d.contact_id, d.delivered_at, d.deal_id, d.deal_name, d.amount, d.current_manager_id::text AS mgr,
                array_agg(DISTINCT p->>'head_group_name') AS cats
           FROM sa.deals d, jsonb_array_elements(d.products) p
          WHERE d.delivered_at IS NOT NULL AND d.contact_id IS NOT NULL AND d.funnel_id NOT IN (4,7)
            AND (p->>'head_group_id') IS NOT NULL AND (p->>'head_group_name') IS NOT NULL
            AND d.current_manager_id = $1 AND d.delivered_at >= now() - interval '12 months'
          GROUP BY d.contact_id, d.delivered_at, d.deal_id, d.deal_name, d.amount, d.current_manager_id
       ),
       last_per_client AS (SELECT DISTINCT ON (contact_id) contact_id, delivered_at AS last_at, cats AS from_cats, amount, deal_id, deal_name FROM deal_cats ORDER BY contact_id, delivered_at DESC),
       ever AS (SELECT contact_id, array_agg(DISTINCT c) AS all_cats FROM deal_cats, unnest(cats) c GROUP BY contact_id)
       SELECT l.contact_id::text, l.last_at, l.from_cats, l.amount::text, l.deal_id::text, l.deal_name
         FROM last_per_client l JOIN ever e ON e.contact_id = l.contact_id
        WHERE EXISTS (
          SELECT 1 FROM unnest($2::text[], $3::text[]) AS p(from_cat, to_cat)
           WHERE p.from_cat = ANY(l.from_cats) AND NOT (p.to_cat = ANY(e.all_cats))
        )
        ORDER BY l.last_at DESC LIMIT ${LIMIT}`, [managerId, pairs.map(p => p.from), pairs.map(p => p.to)]);
    const names = rows.length ? (await systemDb().query<{ client_key: string; name: string | null }>(`SELECT client_key, name FROM client_names WHERE client_key = ANY($1::text[])`, [rows.map(r => `c${r.contact_id}`)])).rows : [];
    const nameBy = new Map(names.map(n => [n.client_key, n.name]));
    return {
      kind: 'clients', title: 'Клиенты, которым не предложили очевидное продолжение',
      hint: 'Последняя покупка содержит категорию, после которой по компании обычно берут другую (например, после газобетона — кровлю), а у этого клиента её нет ни в одной покупке. Это готовый список на обзвон.',
      columns: [{ key: 'client', label: 'Клиент', align: 'left' }, { key: 'bought', label: 'Купил', align: 'left' }, { key: 'missing', label: 'Не предложено', align: 'left' }, COLS.amount, { key: 'last', label: 'Последняя покупка', align: 'right' }],
      rows: rows.map(r => {
        const miss = pairs.filter(p => r.from_cats.includes(p.from)).map(p => p.to);
        return { dealId: Number(r.deal_id), clientKey: `c${r.contact_id}`, cells: {
          client: nameBy.get(`c${r.contact_id}`) ?? `Контакт #${r.contact_id}`,
          bought: r.from_cats.join(', '), missing: [...new Set(miss)].join(', '), amount: rub(r.amount), last: dt(r.last_at) } };
      }),
      total: rows.length,
    };
  }

  // ── Конверсии: где именно потеряли ────────────────────────────────────────
  const LOSS: Record<string, { title: string; hint: string; where: string }> = {
    cr_priced_to_reservation: { title: 'Сделки: цену озвучили, до брони не дошли', hint: 'Клиент услышал цену и не забронировал — тут работают возражения, альтернатива и сроки.', where: `pe.priced_at IS NOT NULL AND d.reserved_at IS NULL AND d.lost_at IS NOT NULL` },
    cr_reservation_to_sale: { title: 'Брони, закончившиеся отказом', hint: 'Бронь есть, продажи нет — смотреть подтверждение, сроки поставки и цену.', where: `d.reserved_at IS NOT NULL AND d.sold_at IS NULL AND d.lost_at IS NOT NULL` },
    cr_deal_to_sale: { title: 'Крупнейшие потерянные сделки', hint: 'Сквозная конверсия ниже нормы — вот сделки, которые дали этот минус.', where: `d.lost_at IS NOT NULL` },
    cr_deal_to_sale_repeat: { title: 'Потерянные повторные сделки', hint: 'Клиент уже покупал и ушёл — самая дорогая потеря.', where: `d.lost_at IS NOT NULL` },
  };
  const loss = LOSS[nodeId];
  if (loss) {
    const { hasPrice } = await loadPriceStageSets();
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; lost_at: Date | null; stage_name: string | null; calls: string }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.lost_at,
              st.name AS stage_name, (SELECT count(*)::text FROM va.calls c WHERE c.deal_id = d.deal_id) AS calls
         FROM sa.deals d
         LEFT JOIN stages st ON st.id = d.stage_id
         LEFT JOIN LATERAL (SELECT min(e.event_at) AS priced_at FROM sa.deal_events e WHERE e.deal_id = d.deal_id AND e.stage_id = ANY($2::text[])) pe ON true
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND coalesce(d.lost_at, d.sold_at) >= now() - interval '90 days'
          AND ${loss.where}
        ORDER BY d.amount DESC NULLS LAST LIMIT ${LIMIT}`, [managerId, hasPrice]);
    return {
      kind: 'deals', title: loss.title, hint: loss.hint,
      columns: [COLS.deal, COLS.group, COLS.amount, COLS.created, { key: 'lost', label: 'Отказ', align: 'right' }, { key: 'reason', label: 'Причина (стадия)', align: 'left' }, { key: 'calls', label: 'Звонков', align: 'right' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), created: dt(r.created_at), lost: dt(r.lost_at), reason: r.stage_name, calls: Number(r.calls) } })),
      total: rows.length,
    };
  }

  // ── Доля мультигрупповых заказов: отгрузки с одной категорией ─────────────
  if (nodeId === 'multi_group_order_share') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; delivered_at: Date }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.delivered_at
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.delivered_at >= now() - interval '90 days'
          AND (SELECT count(DISTINCT p->>'head_group_name') FROM jsonb_array_elements(d.products) p WHERE (p->>'head_group_id') IS NOT NULL) = 1
        ORDER BY d.amount DESC NULLS LAST LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Отгрузки из одной товарной категории',
      hint: 'В чеке только одна категория — допродажи не было. Смотреть, что обычно берут вместе с этим товаром.',
      columns: [COLS.deal, COLS.group, COLS.amount, { key: 'delivered', label: 'Отгружено', align: 'right' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), delivered: dt(r.delivered_at) } })),
      total: rows.length,
    };
  }

  // ── Звонков до брони ──────────────────────────────────────────────────────
  if (nodeId === 'calls_to_reservation_avg') {
    const rows = await sa<{ deal_id: string; deal_name: string | null; head_group_name: string | null; amount: string | null; created_at: Date; calls: string; reserved_at: Date | null }>(
      `SELECT d.deal_id::text, d.deal_name, d.head_group_name, d.amount::text, d.created_at, d.reserved_at,
              (SELECT count(*)::text FROM va.calls c WHERE c.deal_id = d.deal_id AND c.called_at <= coalesce(d.reserved_at, now())) AS calls
         FROM sa.deals d
        WHERE d.current_manager_id = $1 AND d.funnel_id IN (0,1,2,3) AND d.reserved_at IS NOT NULL AND d.reserved_at >= now() - interval '90 days'
        ORDER BY (SELECT count(*) FROM va.calls c WHERE c.deal_id = d.deal_id AND c.called_at <= d.reserved_at) ASC LIMIT ${LIMIT}`, [managerId]);
    return {
      kind: 'deals', title: 'Брони и сколько звонков до них было',
      hint: 'Мало звонков до брони — либо клиент горячий, либо бронь поставлена «на всякий случай» и развалится.',
      columns: [COLS.deal, COLS.group, COLS.amount, { key: 'calls', label: 'Звонков до брони', align: 'right' }, { key: 'reserved', label: 'Бронь', align: 'right' }],
      rows: rows.map(r => ({ dealId: Number(r.deal_id), cells: { deal: r.deal_name ?? `#${r.deal_id}`, group: r.head_group_name, amount: rub(r.amount), calls: Number(r.calls), reserved: dt(r.reserved_at) } })),
      total: rows.length,
    };
  }

  void s;
  return none;
}
