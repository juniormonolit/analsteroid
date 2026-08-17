// Заполнение metrics.human_description — «Как считается» человеческим языком
// (задача владельца 11.08, миграция 179). Запуск:
//   node scripts/fill-human-descriptions.mjs           — заполнить только пустые
//   node scripts/fill-human-descriptions.mjs --force   — перегенерировать ВСЁ (снесёт ручные правки!)
//   node scripts/fill-human-descriptions.mjs --dry     — показать, ничего не писать
//
// Почему генератор, а не 384 текста руками: collected-метрики полностью описаны
// своим определением (источник + агрегат + поле даты + фильтры), calculated —
// формулой поверх других метрик. Руки нужны только external-семействам (их движки
// в коде) — они описаны шаблонами по префиксу id ниже. Ручная правка в
// «Настройки → Метрики» всегда побеждает: без --force непустые значения не трогаем.

import { readFileSync } from 'fs';
import nextEnv from '@next/env';
import pg from 'pg';

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry');

const pool = new pg.Pool({
  host: process.env.YC_PG_HOST, port: +process.env.YC_PG_PORT,
  user: process.env.YC_PG_USER, password: process.env.YC_PG_PASSWORD,
  database: process.env.YC_ANALYTICS_DB,
  ssl: { ca: readFileSync(process.env.YC_PG_SSL_CA_PATH, 'utf8') },
});

// ── Словари ──────────────────────────────────────────────────────────────────

// Поле даты → какие сделки попадают в период отчёта
const DATE_PHRASE = {
  created_at: 'созданные за период отчёта',
  reserved_at: 'у которых бронь оформлена в периоде',
  confirmed_at: 'у которых бронь подтверждена в периоде',
  sold_at: 'у которых продажа состоялась в периоде',
  delivered_at: 'отгруженные в периоде',
  lost_at: 'ушедшие в отказ в периоде',
  updated_at: 'менявшиеся в периоде',
};

// Человеческие имена колонок-стадий (для фраз про отказы «X случилась после отказа»)
const STAGE_COL = {
  reserved_at: 'бронь',
  confirmed_at: 'подтверждение брони',
  sold_at: 'продажа',
  delivered_at: 'отгрузка',
};

// funnel_type
const FUNNEL_PHRASE = {
  primary: 'только первичные воронки',
  repeat: 'только повторные воронки',
  b2c: 'только частные лица (ЧЛ)',
  b2b: 'только юрлица (ЮЛ)',
};

// Виртуальные поля истории клиента (CLIENT_HISTORY_FIELDS в lib/metrics/sqlGen.ts)
const VIRTUAL_PHRASE = {
  _ppp: 'это ровно ВТОРАЯ продажа клиента за всю историю',
  _ppo: 'это ровно ВТОРАЯ отгрузка клиента за всю историю',
  _ppb: 'это ровно ВТОРАЯ бронь клиента за всю историю',
  _pppb: 'это ровно ВТОРОЕ подтверждение брони клиента за всю историю',
  _primary_hist: 'это ПЕРВАЯ продажа клиента за всю историю',
  _repeat_hist: 'это вторая или последующая продажа клиента за всю историю',
  _primary_deliv_hist: 'это ПЕРВАЯ отгрузка клиента за всю историю',
  _repeat_deliv_hist: 'это вторая или последующая отгрузка клиента за всю историю',
  _complex_client: 'клиент «комплексный» — за всю историю отгрузок покупал 2 и более разных товарных групп',
  _has_goods: 'в сделке есть хотя бы одна товарная позиция (не только услуги/доставка)',
  _first_goods_deliv: 'это первая ТОВАРНАЯ отгрузка клиента за всю историю',
  _repeat_goods_deliv: 'это вторая или последующая товарная отгрузка клиента',
};

function fmtVal(v) {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

// Один фильтр → человеческая фраза (null = не смогли, честно скажем "с доп. условием")
function filterPhrase(f) {
  if (f.field === 'funnel_type') return FUNNEL_PHRASE[f.value] ?? null;
  if (VIRTUAL_PHRASE[f.field] && f.op === 'eq') return VIRTUAL_PHRASE[f.field];
  if (f.field === 'products') {
    if (f.op === 'is_null') return 'в сделке нет товарных строк';
    if (f.op === 'is_not_null') return 'в сделке есть товарные строки';
  }
  if (f.field === 'amount' && f.op === 'eq' && String(f.value) === '0') return 'сумма сделки равна нулю';
  if (f.field === 'head_group_name') {
    if (f.op === 'is_null') return 'товарная группа не определена';
    if (f.op === 'is_not_null') return 'товарная группа определена';
  }
  if (f.field === 'stage_type' && f.op === 'eq') {
    const map = { new: 'сделка прямо сейчас стоит на входной стадии («Срочно обработать» и аналоги)', work: 'сделка сейчас в работе', loss: 'сделка сейчас в отказе', won: 'сделка сейчас выиграна' };
    return map[String(f.value).toLowerCase()] ?? null;
  }
  if (f.op === 'gt_field' && f.field === 'lost_at' && STAGE_COL[f.value]) {
    return `отказ случился ПОСЛЕ того, как была ${STAGE_COL[f.value]}`;
  }
  if (f.op === 'gt_field_or_null' && STAGE_COL[f.field]) {
    return `${STAGE_COL[f.field]} либо не случилась вовсе, либо уже после отказа (то есть отказ произошёл, минуя эту стадию)`;
  }
  if (f.op === 'is_not_null' && STAGE_COL[f.field]) return `была ${STAGE_COL[f.field]}`;
  if (f.op === 'is_null' && STAGE_COL[f.field]) return `не было: ${STAGE_COL[f.field]}`;
  if (f.field === 'is_reserved' && f.op === 'eq') return String(f.value) === 'true' ? 'сделка забронирована' : 'сделка не забронирована';
  if (f.field === 'funnel_id' && (f.op === 'in' || f.op === 'not_in')) {
    return `${f.op === 'in' ? 'только воронки' : 'кроме воронок'} № ${fmtVal(f.value)}`;
  }
  if (f.field === 'stage_id' && (f.op === 'in' || f.op === 'eq')) return `стадия из списка: ${fmtVal(f.value)}`;
  return null;
}

// collected → текст
function collectedText(m) {
  const parts = [];
  const src = m.source === 'deal_events' ? 'журналу событий сделок' : 'сделкам из Битрикса';
  const datePhrase = DATE_PHRASE[m.date_field] ?? `по полю даты «${m.date_field}»`;
  parts.push(`Берём сделки, ${datePhrase}`);

  const phrases = [];
  let unknownCount = 0;
  for (const f of m.filters ?? []) {
    const p = filterPhrase(f);
    if (p) phrases.push(p);
    else unknownCount++;
  }
  if (phrases.length) parts.push(`оставляем те, где: ${phrases.join('; ')}`);
  if (unknownCount) parts.push(`плюс ещё ${unknownCount} техн. услови${unknownCount === 1 ? 'е' : 'я'} (см. техописание)`);

  let agg;
  if (m.agg_fn === 'count_distinct' || m.agg_fn === 'count_all') agg = 'Считаем количество таких сделок (каждая — один раз).';
  else if (m.agg_fn === 'sum' && m.agg_field === 'amount') agg = 'Складываем их суммы.';
  else if (m.agg_fn === 'avg' && m.agg_field === 'amount') agg = 'Берём средний чек: сумма всех таких сделок ÷ их количество.';
  else if (m.agg_fn === 'sum') agg = `Складываем значения поля «${m.agg_field}».`;
  else if (m.agg_fn === 'avg') agg = `Берём среднее по полю «${m.agg_field}».`;
  else agg = 'Считаем количество таких сделок.';

  return `Считается по ${src}. ${parts.join('; ')}. ${agg}`;
}

// calculated → текст с подстановкой названий метрик
function calculatedText(m, nameById) {
  if (!m.formula) return null;
  let f = m.formula;
  // «(служебная)» из названий кирпичиков в формуле убираем — для читателя это шум.
  f = f.replace(/\[([a-z0-9_]+)\]/gi, (_, id) => `«${(nameById.get(id) ?? id).replace(/\s*\(служебная\)\s*$/, '')}»`);
  f = f.replace(/\*/g, '×').replace(/\//g, '÷');
  const isPct = m.data_type === 'percent';
  const tail = isPct ? ' Результат — в процентах.' : '';
  return `Считается из других метрик по формуле: ${f}.${tail} Каждая метрика в формуле берётся за тот же период и с теми же фильтрами отчёта.`;
}

// external → шаблоны по семействам (движки в коде, определение из БД не прочитать)
function stageNameFromRu(nameRu) {
  // «Вошло в стадию: X (перв.)» → X;  «Сделки в стадии X (все)» → X
  const m1 = nameRu.match(/стадию:\s*(.+?)\s*\((перв|повт|все)\.?\)/i);
  if (m1) return m1[1];
  const m2 = nameRu.match(/в стадии\s+(.+?)\s*\((перв|повт|все)\.?\)/i);
  if (m2) return m2[1];
  return null;
}

function scopeFromRu(nameRu) {
  if (nameRu.includes('(перв')) return ' Только первичные воронки.';
  if (nameRu.includes('(повт')) return ' Только повторные воронки.';
  return '';
}

// Точечные тексты для метрик-одиночек и семейств «Клиенты»/«Компании»/«По товарам»
// (движки задач 171-175, из определения в БД их не восстановить). Ключ — точный id.
const EXACT = {
  manager_rating: 'Итоговый рейтинг менеджера 0–10: средневзвешенное по осям карточки (продажи, конверсия, звонки и т.д.); веса осей задаются в «Настройки → Шаблоны карточек».',
  calls_count: 'Количество звонков по сделкам за период — по данным телефонии, считаются только звонки, привязанные к сделкам.',
  calls_median_duration: 'Медианная длительность разговора за период, минуты: половина звонков короче этого времени, половина — длиннее (медиана устойчивее среднего к одному сверхдлинному звонку).',
  calls_touch_speed_median: 'Скорость первого касания: медианное время от создания сделки до ПЕРВОГО звонка по ней, минуты.',
  company_count: 'Сколько компаний (юрлиц) сделали хотя бы один заказ за период.',
  company_orders_count: 'Сколько заказов (отгруженных сделок) у компаний за период.',
  company_ltv: 'LTV компании: суммарная выручка по компании за всю её историю, не только за период отчёта.',
  company_categories_count: 'Сколько разных товарных групп компания покупала за всю историю.',
  company_is_repeat: 'Компании, сделавшие 2 и более заказа за всю историю.',
  company_is_active: 'Компании, у которых была отгрузка за последние 90 дней.',
  company_repeat_rate: 'Доля повторных компаний: компании с 2+ заказами ÷ все компании с заказами × 100.',
  company_active_rate: 'Доля активных компаний: с отгрузкой за последние 90 дней ÷ все компании × 100.',
  next_product_probability: 'Вероятность перехода X→Y: из клиентов, купивших товарную группу X, какая доля потом купила группу Y. Купившие Y после X ÷ купившие X × 100.',
  next_product_denom: 'Знаменатель перехода X→Y: сколько клиентов купили товарную группу X (строку таблицы).',
  next_product_num: 'Числитель перехода X→Y: сколько из купивших X потом купили Y.',
  new_clients_count: 'Клиенты, у которых ПЕРВАЯ отгрузка за всю историю пришлась на период отчёта.',
  all_clients_delivered: 'Сколько клиентов получили хотя бы одну отгрузку за период.',
  repeat_clients_delivered: 'Клиенты, у которых в периоде есть ПОВТОРНАЯ отгрузка (не первая в их истории). Клиент, впервые купивший и тут же купивший второй раз в том же периоде, считается и новым, и повторным.',
  delivered_deals_count: 'Количество отгруженных сделок (заказов) за период.',
  new_clients_amount: 'Выручка первых покупок: сумма отгрузок периода, которые были ПЕРВЫМИ в истории своих клиентов.',
  repeat_clients_amount: 'Выручка повторных покупок: сумма отгрузок периода, которые были НЕ первыми в истории своих клиентов.',
  complex_clients: 'Клиенты, купившие за историю 2 и более РАЗНЫХ товарных групп («комплексные»).',
  avg_groups_per_client: 'Сколько разных товарных групп в среднем покупает один клиент (по всей истории отгрузок).',
  avg_groups_per_order: 'Сколько разных товарных групп в среднем в одном заказе.',
  avg_products_per_order: 'Сколько товарных позиций в среднем в одном заказе.',
  median_time_to_2nd: 'Медианное время от первого заказа клиента до второго, дни: у половины вернувшихся клиентов второй заказ случился быстрее, у половины — позже.',
  median_time_between_orders: 'Медианное время между соседними заказами клиента, дни.',
  median_time_to_2nd_diff_cat: 'Медианное время от первого заказа до первого заказа ДРУГОЙ товарной группы, дни.',
  median_time_between_orders_diff_cat: 'Медианное время между заказами разных товарных групп у одного клиента, дни.',
  followup_clients_due: 'Скольким клиентам по регламенту пора было позвонить в периоде (наступил срок повторного касания).',
  followup_clients_called: 'Сколько из «должников по звонку» реально получили звонок в периоде.',
  first_repeat_clients: 'Клиенты, впервые ставшие повторными: их ВТОРАЯ отгрузка за всю историю пришлась на период.',
  active_clients_90d: 'Компании с хотя бы одной отгрузкой за последние 90 дней (на момент открытия отчёта).',
  median_cycle_time_days: 'Медианное время от создания сделки до отгрузки, дни: половина заказов проходит цикл быстрее, половина — дольше.',
  median_client_lifetime_months: 'Медианное «время жизни» клиента: от первой до последней его отгрузки, месяцы.',
  group_buyers_count: 'Сколько клиентов купили товары этой группы за период.',
};

// «CR A → B» ЛЮБОГО типа (collected-числители, calculated по формуле, engine-repeat
// с formula NULL): человеку понятнее одинаковый текст по названию, чем формула из
// служебных кирпичиков. Проверяется ПЕРВЫМ в основном цикле.
function crText(m) {
  const cr = m.name_ru.match(/^CR\s+(.+?)\s*→\s*(.+?)(\s*\((перв|повт|все)\.?\))?$/);
  if (!cr) return null;
  return `Из сделок, впервые вошедших за период в стадию «${cr[1]}», какая доля затем дошла до стадии «${cr[2]}». Дошедшие ÷ вошедшие × 100 (движение по стадиям — по журналу событий, данные с 03.04.2026).${scopeFromRu(m.name_ru)}`;
}

function externalText(m) {
  const id = m.id;
  if (EXACT[id]) return EXACT[id];
  // Тройки перв/повт/все: суффиксные id наследуют текст базового + охват из имени.
  const base = id.replace(/_(repeat|all)$/, '');
  if (base !== id && EXACT[base]) return EXACT[base] + scopeFromRu(m.name_ru);

  // Служебные кирпичики CR/планов: имя уже говорит всё, дописываем роль.
  if (m.name_ru.includes('(служебная)')) {
    const base = m.name_ru.replace(/\s*\(служебная\)\s*$/, '');
    return `Служебная метрика «${base}» — кирпичик для формул (CR по стадиям / выполнение плана). В отчётах напрямую не показывается.`;
  }

  const scope = scopeFromRu(m.name_ru);
  const stage = stageNameFromRu(m.name_ru);

  if (id.startsWith('stage_entered_')) {
    return `Сколько сделок ВПЕРВЫЕ вошло в стадию «${stage ?? '…'}» за период отчёта — по журналу событий (считается первый вход каждой сделки в эту стадию; одноимённые стадии разных воронок объединены).${scope} Данные журнала ведутся с 03.04.2026, за более ранние периоды показывается прочерк.`;
  }
  if (id.startsWith('stage_now_')) {
    const nm = m.name_ru.replace(/\s*\((перв|повт|все)\.?\)\s*$/i, '');
    return `Снимок ТЕКУЩЕГО момента: сколько сделок стоит в стадии «${stage ?? nm}» прямо сейчас. Период отчёта на эту метрику не влияет — это остаток, а не поток.${scope}`;
  }
  if (id.startsWith('deals_in_work')) {
    return `Сколько сделок сейчас В РАБОТЕ: стадия не входная, не отказ и не отгрузка (снимок текущего момента, период не влияет).${scope}`;
  }
  if (id.startsWith('plan_exec_pct')) {
    return `Факт ÷ план × 100. План берётся из «Настройки → Планы» (дневной план = план месяца ÷ рабочие дни), факт — продажи/отгрузки за то же окно.${scope}`;
  }
  if (id.startsWith('plan_')) {
    return `План из «Настройки → Планы»: план месяца раскладывается по рабочим дням производственного календаря, и суммируются дни выбранного окна (месяц / день / период / текущий день).${scope}`;
  }
  if (id.startsWith('calls_incoming')) return `Количество ВХОДЯЩИХ звонков менеджера за период — по данным телефонии, считаются только звонки, привязанные к сделкам.${scope}`;
  if (id.startsWith('calls_outgoing')) return `Количество ИСХОДЯЩИХ звонков менеджера за период — по данным телефонии, считаются только звонки, привязанные к сделкам.${scope}`;
  if (id.startsWith('calls_duration')) return `Суммарная длительность разговоров за период (минуты) — по данным телефонии, только звонки, привязанные к сделкам.${scope}`;
  if (id.startsWith('calls_first_call_duration_median')) return `Медианная длительность ПЕРВОГО звонка по сделке: у каждой сделки периода берётся самый первый звонок, из их длительностей — медиана (половина звонков короче, половина длиннее).${scope}`;
  if (id.startsWith('calls_deals_no_call')) return `Сколько сделок периода остались вовсе БЕЗ ЗВОНКОВ (ни одного звонка, привязанного к сделке).${scope}`;
  if (id.startsWith('calls_silence_deals')) return `Сделки «в тишине»: были звонки раньше, но давно нет ни одного нового контакта.${scope}`;
  if (id.startsWith('rop_first_touch_median')) return `Медианное время от создания сделки до ПЕРВОГО действия менеджера по ней (первое событие в журнале). Половина сделок обработана быстрее этого времени, половина — медленнее.${scope}`;
  if (id.startsWith('cohort_')) return `Когортная метрика: клиенты группируются по месяцу первой покупки, и для каждой когорты смотрится поведение в последующие месяцы (возвраты/выручка). Подробности — в техописании.`;
  if (id.startsWith('called_conversion') || id.includes('called_to_sale')) return `Конверсия «Созвонился → Продажа»: из сделок периода, дошедших до стадии «Созвонился…», какая доля закончилась продажей. Продажа ÷ созвоны × 100.${scope}`;
  if (id.startsWith('client_')) return `Метрика раздела «Клиенты»: считается по всей истории покупок клиента (не только за период отчёта). Подробности — в техописании.`;
  if (id.startsWith('manager_worked_days')) return `Сколько дней в периоде менеджер реально работал — дни, когда по его сделкам было хотя бы одно событие или звонок.`;
  if (id.startsWith('manager_period_calendar_days')) return `Сколько рабочих дней (по производственному календарю) в выбранном периоде.`;
  if (id.startsWith('manager_primary_deals_activity')) return `Сколько первичных сделок менеджер обработал за период (по событиям журнала).`;
  return null; // не знаем семейство — оставим пусто, отчитаемся списком
}

// ── Основной проход ──────────────────────────────────────────────────────────
const res = await pool.query(`
  SELECT id, name_ru, description, human_description, metric_type, data_type, formula,
         source, agg_fn, agg_field, date_field, filters
    FROM metrics
   WHERE is_active = true OR is_hidden_in_ui = false
   ORDER BY sort_order`);

const nameById = new Map(res.rows.map(r => [r.id, r.name_ru]));
let filled = 0, skippedManual = 0, empty = [];

for (const m of res.rows) {
  if (m.human_description && m.human_description.trim() && !FORCE) { skippedManual++; continue; }
  let text = crText(m) ?? (EXACT[m.id] ?? null);
  if (!text) {
    if (m.metric_type === 'collected') text = collectedText(m);
    else if (m.metric_type === 'calculated') text = calculatedText(m, nameById);
    else text = externalText(m);
  }

  if (!text) { empty.push(`${m.id} — ${m.name_ru}`); continue; }
  if (!DRY) await pool.query(`UPDATE metrics SET human_description = $1 WHERE id = $2`, [text, m.id]);
  filled++;
}

console.log(`заполнено: ${filled}, пропущено (ручные): ${skippedManual}, не смогли: ${empty.length}`);
if (empty.length) {
  console.log('\nБЕЗ ОПИСАНИЯ (заполнить руками в «Настройки → Метрики»):');
  for (const e of empty) console.log('  ·', e);
}
if (DRY) {
  console.log('\n--dry: примеры сгенерированного —');
  const samples = ['no_products_primary_count', 'primary_sales_amount', 'cr_deal_to_shipment', 'stage_now_unprocessed_count', 'unprocessed_count'];
  for (const id of samples) {
    const m = res.rows.find(r => r.id === id);
    if (!m) continue;
    const t = m.metric_type === 'collected' ? collectedText(m) : m.metric_type === 'calculated' ? calculatedText(m, nameById) : externalText(m);
    console.log(`\n[${id}] ${m.name_ru}\n  ${t}`);
  }
}
await pool.end();
