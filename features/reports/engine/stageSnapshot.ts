import { analyticsDb } from '@/lib/db/clients';
import type { DimensionConfig } from '@/lib/metrics/sqlGen';

// ── Каталог «Стадии (сейчас)» (задачи 2059+2063, Серёга 17.07) ──────────────────
//
// СНИМОК текущего состояния sa.deals — «сколько сделок ПРЯМО СЕЙЧАС стоит в
// стадии X» — сознательно НЕ идёт через buildCollectedSQL/genDealsExpr (там период
// жёстко бьётся параметрами $1/$2 в базовый SQL КАЖДОЙ collected-метрики разом —
// см. lib/metrics/sqlGen.ts). Этот движок вообще не принимает период: один SELECT
// по ЖИВОМУ d.stage_id, без единой даты. Дублировать resolveFilterClause/
// CLIENT_HISTORY_FIELDS тоже не нужно — метрики здесь metric_type='external'
// (не 'collected'), поэтому инцидент 14.07 (виртуальные scope_independent-поля
// ломали базовый SQL ЛЮБОГО отчёта) структурно не может повториться.
//
// ПРАВИЛА СЕМЕЙСТВА (решения Серёги 17.07, задача 2063, дословно: «пер-стадийные
// в повторных должны быть. … Называться они должны ТОЧЬ-В-ТОЧЬ как стадии.»):
//  1. Одна метрика = одно ТОЧНОЕ название стадии портала (суффикс воронки
//     «(ЧЛ)/(ЮЛ)/(B2C)/(B2B)» отброшен — это маркер воронки, не имя стадии).
//     Одноимённые стадии разных воронок агрегируются в одну метрику. Из-за этого
//     правила прежние 2059-группы, склеивавшие РАЗНОимённые стадии (например
//     «Взято в работу» = «Не дозвонился»+«Взял в работу»), РАСЩЕПЛЕНЫ.
//  2. Покрытие: funnels 0 (ЧЛ), 1 (ЮЛ), 2 (Повторные B2C), 3 (Повторные B2B).
//     Funnels 4 (Холодные звонки) и 7 (Тендеры) НЕ включены (Серёга про них не
//     говорил) — их сделки видны только в «Сделок в работе» (stage_type='WORK').
//  3. ИСКЛЮЧЕНИЕ из «точь-в-точь»: «Необработанные» — персональное переименование
//     Серёги (итерации 2059: «Лид (сейчас)» → удалена → возвращена как
//     «Необработанные»). В неё же по СМЫСЛУ (входная created-стадия) сложены
//     C2:NEW/C3:NEW «Сделка (B2C/B2B)» повторных воронок — отдельной метрики
//     «Сделка» сознательно нет (см. финальный отчёт 2063, решение согласовано).
//  4. Рабочие стадии = event_type IN (created, called, reserved, confirmed).
//     Терминальные sold/shipped/lost исключены по исходному ТЗ (в т.ч. «Заказ в
//     работе (B2C)» и «Счет оплачен (B2B)» — event_type='sold').
//
// Все stage_id и написания имён сверены с ЖИВЫМ sa.stages 17.07 (funnels 0-3,
// event_type IN (created,called,reserved,confirmed) — 29 стадий, все покрыты
// ниже, кроме sold-стадий). НЕ путать stage_now_unprocessed_count с каталожными
// unprocessed_count/unprocessed_primary_count — те за ПЕРИОД, эта — снимок.
export const STAGE_SNAPSHOT_GROUPS: Record<string, { metricId: string; stageIds: string[] }> = {
  // «Необработанные» (исключение из «точь-в-точь»): NEW/C1:NEW «Срочно
  // обработать» + C2:NEW/C3:NEW «Сделка» — все входные created-стадии.
  unprocessed:        { metricId: 'stage_now_unprocessed_count',         stageIds: ['NEW', 'C1:NEW', 'C2:NEW', 'C3:NEW'] },
  // «Не дозвонился» — расщеплено из прежней 2059-группы taken.
  no_answer:          { metricId: 'stage_now_no_answer_count',           stageIds: ['PREPARATION', 'C1:PREPARATION'] },
  // «Взял в работу» — прежняя taken минус «Не дозвонился».
  taken:              { metricId: 'stage_now_taken_count',               stageIds: ['PREPAYMENT_INVOICE', 'C1:PREPAYMENT_INVOICE'] },
  // «Сделал запрос снабженцу, созвонился с заказчиком» — одноимённые стадии всех
  // 4 воронок (в повторных это C2:PREPARATION/C3:PREPARATION — id обманчив,
  // название точь-в-точь совпадает, live-проверка 17.07).
  contacted:          { metricId: 'stage_now_contacted_count',           stageIds: ['EXECUTING', 'C1:EXECUTING', 'C2:PREPARATION', 'C3:PREPARATION'] },
  // «Созвонился и озвучил цены» — только ЧЛ (в ЮЛ одноимённой стадии НЕТ —
  // прежняя 2059-группа priced склеивала сюда C1:FINAL_INVOICE «Отправил КП и
  // позвонил», теперь это отдельная метрика kp_sent).
  priced:             { metricId: 'stage_now_priced_count',              stageIds: ['FINAL_INVOICE'] },
  // «Отправил КП и позвонил» — ЮЛ (C1:FINAL_INVOICE) + B2B (C3:PREPAYMENT_INVOICE),
  // названия совпадают точь-в-точь.
  kp_sent:            { metricId: 'stage_now_kp_sent_count',             stageIds: ['C1:FINAL_INVOICE', 'C3:PREPAYMENT_INVOICE'] },
  // «Созвонился и уточнил следующие материалы» — только повторные (B2C/B2B).
  next_materials:     { metricId: 'stage_now_next_materials_count',      stageIds: ['C2:3', 'C3:3'] },
  // «Заполнил все материалы и запланировал звонок» — только B2C.
  filled_planned:     { metricId: 'stage_now_filled_planned_call_count', stageIds: ['C2:PREPAYMENT_INVOICE'] },
  // «Есть цена дешевле, запросил предложение лучше» — все 4 воронки (тот же
  // смысл, что стадия в priceObjectionConversion.ts, но теперь + C2:4/C3:4).
  price_objection:    { metricId: 'stage_now_price_objection_count',     stageIds: ['UC_PU4HM2', 'C1:11', 'C2:4', 'C3:4'] },
  // «Забронировано» — ЧЛ + B2C (C2:EXECUTING — id обманчив, название совпадает).
  reservation:        { metricId: 'stage_now_reservation_count',         stageIds: ['UC_SQEHTU', 'C2:EXECUTING'] },
  // «Отправил счет и договор (Бронь)» — только ЮЛ; «(Бронь)» — часть имени стадии.
  invoice_contract:   { metricId: 'stage_now_invoice_contract_count',    stageIds: ['C1:1'] },
  // «Подтвержденная бронь» — ЧЛ + B2C.
  confirmed:          { metricId: 'stage_now_confirmed_count',           stageIds: ['1', 'C2:5'] },
  // «Наша цена лучшая, ждем оплату (Подтв.бронь)» — только ЮЛ.
  best_price_wait:    { metricId: 'stage_now_best_price_wait_count',     stageIds: ['C1:2'] },
  // «Отправил счет» — только B2B (C3:EXECUTING, event_type='confirmed').
  invoice_sent:       { metricId: 'stage_now_invoice_sent_count',        stageIds: ['C3:EXECUTING'] },
};

export const STAGE_SNAPSHOT_METRIC_IDS = Object.values(STAGE_SNAPSHOT_GROUPS).map(g => g.metricId);

// «Сделок в работе» (доп. задача Серёги 17.07, дословно): сумма ВСЕХ сделок, чья
// ТЕКУЩАЯ стадия — sa.stages.stage_type = 'WORK' (данные, живая проверка 17.07:
// stage_type ∈ {NEW, WORK, WON, LOSS}, WORK покрывает ВСЕ воронки 0/1/2/3/4/7
// разом — в отличие от STAGE_SNAPSHOT_GROUPS выше, которые покрывают только 0/1).
// Классическая троица (перв./повт./все) — тот же паттерн, что calls_count/_repeat/
// _all (callsMetrics.ts): считается НАПРЯМУЮ по funnels.is_repeat, ВСЕГДА все три
// колонки видны разом, БЕЗ обхода через funnel-пилюлю отчёта (Первичные/Повторные/
// Все) — она таким троицам не нужна, это тоже устоявшийся паттерн каталога.
//
// ВАЖНО (сверка со Серёгой запрошена): «Сделок в работе (все)» НЕ равно сумме
// per-stage метрик STAGE_SNAPSHOT_GROUPS выше, и это ожидаемо, НЕ баг — см.
// финальный отчёт задачи. Причины: (1) STAGE_GROUPS покрывает только funnels 0/1,
// WORK — все 6 воронок; (2) event_type='sold' стадии (2 шт., напр. «Продано (ЧЛ)»,
// «Заказ в работе, счёт оплачен (продано) (ЮЛ)») имеют stage_type='WORK' (заказ
// оплачен, но ещё не отгружен — бизнес считает это «в работе», НЕ терминалом) —
// они попадают в WORK, но НЕ входят ни в одну из per-stage метрик (там explicitly
// исключены «продажи» как терминал по первоначальному ТЗ); (3) стадии
// «Необработанных» (NEW/C1:NEW, stage_type='NEW') в WORK не входят, хотя своя
// per-stage метрика у них есть (stage_now_unprocessed_count).
export const DEALS_IN_WORK_METRIC_IDS = [
  'deals_in_work_count', 'deals_in_work_count_repeat', 'deals_in_work_count_all',
];

const STAGE_TO_METRIC = new Map<string, string>();
for (const g of Object.values(STAGE_SNAPSHOT_GROUPS)) {
  for (const id of g.stageIds) STAGE_TO_METRIC.set(id, g.metricId);
}
const CURATED_STAGE_IDS = [...STAGE_TO_METRIC.keys()];

interface FunnelMeta { id: number; isRepeat: boolean }
let _funnels: FunnelMeta[] | null = null;
let _funnelsAt = 0;
async function loadFunnelsLocal(): Promise<FunnelMeta[]> {
  if (_funnels && Date.now() - _funnelsAt < 30 * 60 * 1000) return _funnels;
  const res = await analyticsDb().query<{ id: number; is_repeat: boolean }>('SELECT id, is_repeat FROM funnels');
  _funnels = res.rows.map(r => ({ id: r.id, isRepeat: r.is_repeat }));
  _funnelsAt = Date.now();
  return _funnels;
}

export type SnapshotFlatRow = Record<string, unknown> & {
  dimension_id: string; dimension_name?: string; funnel_id: number;
};

export interface StageSnapshotResult {
  // Формат ИДЕНТИЧЕН buildCollectedSQL: dimension_id/funnel_id + колонки метрик —
  // вызывающий движок конкатенирует эти строки в свой общий rows[] ПЕРЕД
  // pill-агрегацией (funnel-пилюля работает как обычно: funnel_id — реальное
  // измерение сделки, обход наподобие ППП/scope_independent не нужен).
  pillRows: SnapshotFlatRow[];
  // «Сделок в работе» по измерению — уже готовая перв./повт./все, БЕЗ пилюли.
  workByDim: Map<string, { primary: number; repeat: number; all: number }>;
}

/**
 * Один агрегатный SELECT — снимок ЖИВОГО d.stage_id, БЕЗ единого параметра периода.
 * dim — тот же DimensionConfig, что уже строит buildCollectedSQL для этого же
 * измерения (менеджер / товарная группа / источник) — переиспользуем idExpr/
 * nameExpr/extraJoins/notNullWhere один в один, чтобы фильтры отчёта (пг/источник/
 * отдел/нерабочее время) резали снимок ТАК ЖЕ, как и обычные collected-метрики.
 */
export async function fetchStageSnapshot(dim: DimensionConfig): Promise<StageSnapshotResult> {
  const notNull = dim.notNullWhere ? `AND ${dim.notNullWhere}` : '';
  const nameSelect = dim.nameExpr ? `${dim.nameExpr} AS dimension_name,` : '';
  const nameGroup  = dim.nameExpr ? `, ${dim.nameExpr}` : '';
  const sql = `
    SELECT
      ${dim.idExpr} AS dimension_id,
      ${nameSelect}
      d.funnel_id,
      d.stage_id,
      s.stage_type,
      COUNT(*) AS cnt
    FROM deals d
    JOIN stages s ON s.id = d.stage_id
    ${dim.extraJoins ?? ''}
    WHERE (s.stage_type = 'WORK' OR d.stage_id = ANY($1::text[]))
      ${notNull}
    GROUP BY ${dim.idExpr}${nameGroup}, d.funnel_id, d.stage_id, s.stage_type
  `.trim();

  const res = await analyticsDb().query<{
    dimension_id: string; dimension_name?: string; funnel_id: number;
    stage_id: string; stage_type: string | null; cnt: string;
  }>(sql, [CURATED_STAGE_IDS]);

  const funnels = await loadFunnelsLocal();
  const isRepeatByFunnel = new Map(funnels.map(f => [f.id, f.isRepeat]));

  const pillByKey = new Map<string, SnapshotFlatRow>();
  const workByDim = new Map<string, { primary: number; repeat: number; all: number }>();

  for (const row of res.rows) {
    const cnt = Number(row.cnt);

    const metricId = STAGE_TO_METRIC.get(row.stage_id);
    if (metricId) {
      const key = `${row.dimension_id}|${row.funnel_id}`;
      let entry = pillByKey.get(key);
      if (!entry) {
        entry = { dimension_id: row.dimension_id, dimension_name: row.dimension_name, funnel_id: row.funnel_id };
        for (const id of STAGE_SNAPSHOT_METRIC_IDS) entry[id] = 0;
        pillByKey.set(key, entry);
      }
      (entry[metricId] as number) += cnt;
    }

    if (row.stage_type === 'WORK') {
      let w = workByDim.get(row.dimension_id);
      if (!w) { w = { primary: 0, repeat: 0, all: 0 }; workByDim.set(row.dimension_id, w); }
      w.all += cnt;
      if (isRepeatByFunnel.get(row.funnel_id)) w.repeat += cnt; else w.primary += cnt;
    }
  }

  return { pillRows: [...pillByKey.values()], workByDim };
}
