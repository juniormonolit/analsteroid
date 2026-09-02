// Реестр правил дрилл-дауна для метрик СО СВОИМИ ДВИЖКАМИ (аудит владельца
// 02.09: «у других метрик как с этим дела? может, косячная залупа не только с
// этим?»).
//
// ПРЕДЫСТОРИЯ. /api/reports/deals умел четыре ветки: снимок «Стадии (сейчас)»,
// «Сделок в работе», «Вошло в стадию» (добавлена 02.09) и generic-путь по
// date_field метрики из каталога. Всё остальное молча падало в ДЕФОЛТНОЕ окно
// «сделка, у которой ЛЮБАЯ дата стадии попала в период» — а это не список
// метрики, это «сделки с любой активностью». Аудит: 91 кликабельная метрика.
// Симптом (жалоба владельца по «Вошло в стадию: Созвонился и озвучил цены»):
// в списке сделка, вошедшая в стадию 24.08, потому что 01.09 её продали.
//
// ПРИНЦИП. Молчаливо неверный список опаснее отсутствия списка: по нему делают
// выводы. Поэтому: метрика либо имеет ЯВНОЕ правило (здесь), либо честно
// говорит «списка нет» (NO_DEAL_LIST + гейт в роуте), либо уходит в клиентский
// дрилл (CLIENT_FAMILY_METRIC_IDS). Дефолтное окно осталось только для клика по
// строке БЕЗ метрики (клик по имени менеджера — «все сделки периода»).
//
// Файл ЧИСТЫЙ (без импортов БД) — его читает и клиентский ReportTable, чтобы не
// делать кликабельными ячейки, у которых списка не будет.

/** Правило: SQL-условие на сделку `d` + опциональный JOIN. $1/$2 — период. */
export interface DrillRule {
  /** JOIN-хвост (может использовать $1/$2 и алиас d). */
  join?: string;
  /** Условие в WHERE (уже с учётом воронки метрики). */
  where: string;
  /** Подпись охвата для шапки панели. */
  label: string;
  // Атрибуция «строки менеджера». По умолчанию список режется по ТЕКУЩЕМУ
  // владельцу сделки (d.current_manager_id) — так считают ячейки, чей объект
  // сделка. У звонковых метрик объект — ЗВОНОК, и ячейка считает по менеджеру
  // ЗВОНКА (va.calls.manager_id): список обязан повторять ту же атрибуцию,
  // иначе у переданной сделки цифра и список расходятся (аудит 02.09).
  // `%P%` — подстановка позиционного параметра ($N) роутом.
  mgrOne?: string;
  mgrMany?: string;
}

/** Воронка по суффиксу id метрики: …_all → все, …_repeat → повторные, иначе первичные. */
export function funnelWhereForMetricId(id: string): string {
  if (id.endsWith('_all')) return '1=1';
  const repeat = id.endsWith('_repeat');
  return `d.funnel_id IN (SELECT id FROM funnels WHERE is_repeat = ${repeat ? 'true' : 'false'})`;
}

// ── Звонки (36 метрик) ───────────────────────────────────────────────────────
// Объект этих метрик — ЗВОНОК, не сделка. Честный список сделок: те, по которым
// в периоде был звонок (va.calls.called_at в периоде) — именно из них сложились
// количество/длительность/медианы. Направление учитываем там, где оно в id.
const CALLS_ANY = [
  'calls_count', 'calls_avg_duration', 'calls_median_duration',
  'calls_touch_speed_median', 'calls_first_call_duration_median',
];
const CALLS_IN  = ['calls_incoming_count', 'calls_duration_in'];
const CALLS_OUT = ['calls_outgoing_count', 'calls_duration_out'];

function callsRule(base: string, id: string, dir: 'in' | 'out' | null): DrillRule {
  const dirSql = dir === 'in' ? ` AND c.direction::text = 'inbound'`
    : dir === 'out' ? ` AND c.direction::text = 'outbound'` : '';
  return {
    // array_agg + GROUP BY deal_id (а не DISTINCT по паре) — ОДНА строка на
    // сделку: иначе сделка, по которой звонили двое, дублировалась бы в списке
    // «Итого», где фильтра по менеджеру нет.
    join: `JOIN (
      SELECT c.deal_id, array_agg(DISTINCT c.manager_id::bigint) AS mgrs
      FROM va.calls c
      WHERE c.called_at >= $1 AND c.called_at < $2${dirSql} AND c.deal_id IS NOT NULL
      GROUP BY c.deal_id
    ) _dc ON _dc.deal_id = d.deal_id`,
    where: funnelWhereForMetricId(id),
    // Касты к bigint с ОБЕИХ сторон: у @>/&& типы массивов обязаны совпадать, а
    // тип va.calls.manager_id в разных базах (SA/зеркало) отличается.
    mgrOne: '_dc.mgrs @> ARRAY[%P%::bigint]',
    mgrMany: '_dc.mgrs && %P%::bigint[]',
    label: dir === 'in' ? 'сделки с входящим звонком в периоде'
      : dir === 'out' ? 'сделки с исходящим звонком в периоде'
      : 'сделки со звонком в периоде',
  };
}

// «Сделки без единого звонка» — сделки, СОЗДАННЫЕ в периоде, у которых нет ни
// одного звонка (в движке any_calls — вообще ни одного, без периода).
function noCallRule(id: string): DrillRule {
  return {
    join: '',
    where: `d.created_at >= $1 AND d.created_at < $2
      AND NOT EXISTS (SELECT 1 FROM va.calls c WHERE c.deal_id = d.deal_id)
      AND ${funnelWhereForMetricId(id)}`,
    label: 'созданные в периоде сделки без единого звонка',
  };
}

// «Тишина» — снимок на конец периода: открытые сделки без звонков 7+ дней.
// Период отчёта задаёт только правую границу окна (см. fetchCallSilence).
const SILENCE_DAYS = 7;
function silenceRule(id: string): DrillRule {
  return {
    join: '',
    // $1 обязан встретиться в тексте запроса, даже если по смыслу не нужен
    // (окно тишины считается от конца периода): параметр без единого упоминания
    // Postgres не типизирует и падает с 42P18 — тот же приём, что в ветках
    // снимков в deals/route.ts. Поймано EXPLAIN-прогоном правил 02.09.
    where: `$1::timestamptz IS NOT NULL
      AND d.sold_at IS NULL AND d.delivered_at IS NULL AND d.lost_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM va.calls c
        WHERE c.deal_id = d.deal_id
          AND c.called_at >= $2::timestamptz - interval '${SILENCE_DAYS} days'
          AND c.called_at < $2
      )
      AND ${funnelWhereForMetricId(id)}`,
    label: `открытые сделки без звонков ${SILENCE_DAYS}+ дней`,
  };
}

// «Звонков до брони» — сделки периода, дошедшие до брони (знаменатель средней).
function toReservationRule(id: string): DrillRule {
  return {
    join: '',
    where: `d.created_at >= $1 AND d.created_at < $2 AND d.reserved_at IS NOT NULL
      AND ${funnelWhereForMetricId(id)}`,
    label: 'созданные в периоде сделки, дошедшие до брони',
  };
}

// «Скорость до цены» — когорта = сделки, СОЗДАННЫЕ в периоде (см. priceSpeed.ts).
function priceSpeedRule(id: string): DrillRule {
  return {
    join: '',
    where: `d.created_at >= $1 AND d.created_at < $2 AND ${funnelWhereForMetricId(id)}`,
    label: 'созданные в периоде сделки (когорта скорости до цены)',
  };
}

export const DRILL_RULES: Record<string, DrillRule> = (() => {
  const out: Record<string, DrillRule> = {};
  const triple = (base: string) => [base, `${base}_repeat`, `${base}_all`];
  for (const base of CALLS_ANY) for (const id of triple(base)) out[id] = callsRule(base, id, null);
  for (const base of CALLS_IN)  for (const id of triple(base)) out[id] = callsRule(base, id, 'in');
  for (const base of CALLS_OUT) for (const id of triple(base)) out[id] = callsRule(base, id, 'out');
  for (const id of triple('calls_deals_no_call'))   out[id] = noCallRule(id);
  for (const id of triple('calls_silence_deals'))   out[id] = silenceRule(id);
  for (const id of triple('calls_to_reservation_avg')) out[id] = toReservationRule(id);
  for (const id of triple('price_speed_median_hours')) out[id] = priceSpeedRule(id);
  return out;
})();

// ── Метрики, у которых списка сделок НЕ СУЩЕСТВУЕТ ──────────────────────────
// Не «мы не написали правило», а «объекта нет»: план задаётся людям целиком (не
// по сделкам), «дней в работе» — календарь, рейтинг — сводный балл, логин —
// свойство сотрудника, «мороженые» метрики — замороженный снапшот без исходных
// сделок. Клик по такой ячейке не должен открывать панель вообще.
export const NO_DEAL_LIST_METRIC_IDS: string[] = [
  'plan_sales_month', 'plan_shipments_month',
  'plan_sales_today', 'plan_shipments_today',
  'plan_sales_current_day', 'plan_shipments_current_day',
  'plan_sales_current_week_day', 'plan_shipments_current_week_day',
  'plan_sales_target_mtd', 'plan_shipments_target_mtd',
  'manager_worked_days_count', 'manager_deals_per_worked_day',
  'manager_rating', 'manager_login',
  'rop_first_touch_median', 'rop_first_touch_median_repeat', 'rop_first_touch_median_all',
];
