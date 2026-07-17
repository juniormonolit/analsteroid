import { analyticsDb } from '@/lib/db/clients';
import type { DimensionConfig } from '@/lib/metrics/sqlGen';
import { STAGE_GROUPS } from './stageConversions';

// ── Каталог «Стадии (сейчас)» (задача 2059, Серёга 17.07 + доп. в тот же день) ──
//
// СНИМОК текущего состояния sa.deals — «сколько сделок ПРЯМО СЕЙЧАС стоит в
// стадии X» — сознательно НЕ идёт через buildCollectedSQL/genDealsExpr (там период
// жёстко бьётся параметрами $1/$2 в базовый SQL КАЖДОЙ collected-метрики разом —
// см. lib/metrics/sqlGen.ts). Этот движок вообще не принимает период: один SELECT
// по ЖИВОМУ d.stage_id, без единой даты. Дублировать resolveFilterClause/
// CLIENT_HISTORY_FIELDS тоже не нужно — метрики здесь metric_type='external'
// (не 'collected'), поэтому инцидент 14.07 [[reference_analsteroid_reports_
// virtual_fields_incident]] (виртуальные scope_independent-поля ломали базовый SQL
// ЛЮБОГО отчёта) структурно не может повториться: этот код не трогает
// resolveFilterClause и не эмитит d.<виртуальное_поле> вообще.
//
// Группы стадий (6 метрик, funnels 0=ЧЛ/1=ЮЛ) — переиспользование STAGE_GROUPS,
// того же канонического словаря, что уже используют конверсии стадий
// (stageConversions.ts). Bitrix stage_id НЕ параллельны между воронками — вне
// funnels 0/1 (2/3=Повторные Б2C/Б2Б, 4=Холодные звонки, 7=Тендеры) канонической
// группировки такого же вида ещё нет (см. WORKLOG/финальный отчёт задачи —
// открытый вопрос Серёге, не блокирует).
//
// «Лид» (STAGE_GROUPS.new, была stage_now_new_count) — УДАЛЕНА по решению Серёги
// 17.07 («лид не нужен»): метрика убрана из каталога (DELETE в правке миграции
// 103) и из этого реестра. НЕ добавлять обратно без явного запроса.
//
// + price_objection — стадия «Есть цена дешевле, запросил предложение лучше»
// (UC_PU4HM2 ЧЛ / C1:11 ЮЛ) — рабочая (event_type='called'), но НЕ входит ни в
// одну из групп STAGE_GROUPS (тот же список ID, что и priceObjectionConversion.ts,
// живая проверка 10.07/17.07).
//
// Терминальные (sale/shipped — «Продажа»/«Отгрузка») и «Отказ» — исключены по
// заданию (только рабочие статусы).
export const STAGE_SNAPSHOT_GROUPS: Record<string, { metricId: string; stageIds: string[] }> = {
  taken:           { metricId: 'stage_now_taken_count',            stageIds: STAGE_GROUPS.taken },
  contacted:       { metricId: 'stage_now_contacted_count',        stageIds: STAGE_GROUPS.contacted },
  priced:          { metricId: 'stage_now_priced_count',           stageIds: STAGE_GROUPS.priced },
  reservation:     { metricId: 'stage_now_reservation_count',      stageIds: STAGE_GROUPS.reservation },
  confirmed:       { metricId: 'stage_now_confirmed_count',        stageIds: STAGE_GROUPS.confirmed },
  price_objection: { metricId: 'stage_now_price_objection_count',  stageIds: ['UC_PU4HM2', 'C1:11'] },
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
// исключены «продажи» как терминал по первоначальному ТЗ); (3) стадии группы
// «Лид» (NEW/C1:NEW, stage_type='NEW') в WORK не входят, а своей метрики больше
// не имеют (удалена по решению Серёги 17.07).
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
