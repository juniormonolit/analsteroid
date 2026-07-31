import { analyticsDb } from '@/lib/db/clients';

// Историческая модель по товарным группам (шкала head_group_name) для раздела
// «Разгрузка отделов» (задача 2635, этап 1):
//  * медианные РАБОЧИЕ дни группы до продажи / до отказа / до любого завершения;
//  * условная вероятность продажи P(продажа | сделка жива и не продана,
//    накопив N рабочих дней) — ровно та же величина, что «условная вероятность»
//    в отчёте отсечек (owners-inbox/monolitika-callback-cutoff-by-group.md):
//    P(N) = продажи с t_sale > N / (они же + непроданные с t_total > N).
//
// РЕШЕНИЕ по производительности (задокументировано по ТЗ): модель считается НА
// ЛЕТУ одним SQL по всей истории deal_events (та же выгрузка, что в отчёте,
// ~40 тыс. строк / единицы секунд) и кэшируется В ПАМЯТИ процесса на 6 часов —
// предрассчитанная таблица в БД не нужна: истории мало (с 03.04.2026), пересчёт
// дешёвый, а кэш убирает его из горячего пути. Модель — ТОЛЬКО ПЕРВИЧКА
// (funnel_id по is_repeat=false), как в отчёте: к повторке отсечки/вероятности
// неприменимы без отдельного расчёта (там conversion 46% против 15%).

export interface GroupModel {
  medianSaleDays: number | null;   // медиана t_sale проданных
  medianLossDays: number | null;   // медиана t_lost отказных (lost и не sold)
  medianCloseDays: number | null;  // медиана по всем завершённым (sold ∪ lost)
  soldCount: number;
  // probByDay[n] = P(продажа | жива/не продана на день n), n = 0..MODEL_MAX_DAY;
  // за пределами массива берём последний элемент.
  probByDay: number[];
}

export interface OffloadModel {
  byGroup: Map<string, GroupModel>;
  overall: GroupModel; // пул всех групп — фолбэк для неизвестных/мелких групп
  computedAt: number;
}

export const MODEL_MAX_DAY = 90;
const MODEL_TTL_MS = 6 * 60 * 60 * 1000;
// Группа надёжна для собственной кривой вероятности при ≥30 продаж (то же
// правило ≥30 исходов, что в отчётах #2554/#2556) — иначе фолбэк на общий пул.
const MIN_SOLD_FOR_OWN_CURVE = 30;

interface HistRow {
  grp: string;
  sold: boolean;
  lost: boolean;
  t_sale: string | null;
  t_lost: string | null;
  t_total: string;
}

let cache: OffloadModel | null = null;

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(v * 10) / 10;
}

function buildGroupModel(rows: { sold: boolean; lost: boolean; tSale: number; tLost: number; tTotal: number }[]): GroupModel {
  const saleDays = rows.filter(r => r.sold).map(r => r.tSale).sort((a, b) => a - b);
  const lossDays = rows.filter(r => r.lost).map(r => r.tLost).sort((a, b) => a - b);
  const closeDays = [...saleDays, ...lossDays].sort((a, b) => a - b);

  const probByDay: number[] = [];
  for (let n = 0; n <= MODEL_MAX_DAY; n++) {
    // «жива и не продана на день n»: продажи с t_sale > n (ещё продадутся) +
    // непроданные с t_total > n (дожили, не продались). Право-цензурирование
    // хвоста то же, что в отчёте — вероятности на больших N слегка занижены.
    let soldAfter = 0, aliveUnsold = 0;
    for (const r of rows) {
      if (r.sold) { if (r.tSale > n) soldAfter++; }
      else if (r.tTotal > n) aliveUnsold++;
    }
    const denom = soldAfter + aliveUnsold;
    probByDay.push(denom > 0 ? soldAfter / denom : 0);
  }

  return {
    medianSaleDays: median(saleDays),
    medianLossDays: median(lossDays),
    medianCloseDays: median(closeDays),
    soldCount: saleDays.length,
    probByDay,
  };
}

export async function getOffloadModel(): Promise<OffloadModel> {
  if (cache && Date.now() - cache.computedAt < MODEL_TTL_MS) return cache;

  // Та же выгрузка, что в отчёте отсечек (SQL-блок в конце отчёта), + обрезка
  // времени по lost_at для медианы «до отказа».
  const sql = `
WITH work_stages AS (
  SELECT id FROM stages WHERE stage_type = 'WORK' AND event_type NOT IN ('sold','shipped')
),
first_entry AS (
  SELECT DISTINCT ON (de.deal_id) de.deal_id, de.event_at AS first_at
  FROM deal_events de JOIN work_stages s ON s.id = de.stage_id
  ORDER BY de.deal_id, de.event_at
),
cohort AS (
  SELECT fe.deal_id, fe.first_at, d.head_group_name, d.sold_at, d.lost_at,
         (d.sold_at IS NOT NULL AND d.sold_at >= fe.first_at) AS sold,
         (d.sold_at IS NULL AND d.lost_at IS NOT NULL AND d.lost_at >= fe.first_at) AS lost
  FROM first_entry fe
  JOIN deals d ON d.deal_id = fe.deal_id
  JOIN funnels f ON f.id = d.funnel_id
  WHERE f.is_repeat = false
),
ev AS (
  SELECT de.deal_id, de.stage_id, de.event_at,
         LEAD(de.event_at) OVER (PARTITION BY de.deal_id ORDER BY de.event_at) AS next_at
  FROM deal_events de JOIN cohort c ON c.deal_id = de.deal_id
),
agg AS (
  SELECT ev.deal_id,
    SUM(EXTRACT(EPOCH FROM COALESCE(ev.next_at, now()) - ev.event_at)) / 86400.0 AS t_total,
    SUM(CASE WHEN c.sold AND ev.event_at < c.sold_at
      THEN GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(ev.next_at, now()), c.sold_at) - ev.event_at)) ELSE 0 END) / 86400.0 AS t_sale,
    SUM(CASE WHEN c.lost AND ev.event_at < c.lost_at
      THEN GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(ev.next_at, now()), c.lost_at) - ev.event_at)) ELSE 0 END) / 86400.0 AS t_lost
  FROM ev
  JOIN work_stages ws ON ws.id = ev.stage_id
  JOIN cohort c ON c.deal_id = ev.deal_id
  GROUP BY ev.deal_id
)
SELECT COALESCE(NULLIF(c.head_group_name, ''), '(без группы)') AS grp,
       c.sold, c.lost, a.t_sale, a.t_lost, COALESCE(a.t_total, 0) AS t_total
FROM cohort c
LEFT JOIN agg a ON a.deal_id = c.deal_id
  `.trim();

  const res = await analyticsDb().query<HistRow>(sql);
  const parsed = res.rows.map(r => ({
    grp: r.grp,
    sold: r.sold,
    lost: r.lost,
    tSale: Number(r.t_sale ?? 0),
    tLost: Number(r.t_lost ?? 0),
    tTotal: Number(r.t_total),
  }));

  const byGrpRows = new Map<string, typeof parsed>();
  for (const r of parsed) {
    const arr = byGrpRows.get(r.grp) ?? [];
    arr.push(r);
    byGrpRows.set(r.grp, arr);
  }

  const overall = buildGroupModel(parsed);
  const byGroup = new Map<string, GroupModel>();
  for (const [grp, rows] of byGrpRows) {
    const m = buildGroupModel(rows);
    // мало продаж — кривая шумит: медианы оставляем свои, вероятность из пула
    if (m.soldCount < MIN_SOLD_FOR_OWN_CURVE) m.probByDay = overall.probByDay;
    byGroup.set(grp, m);
  }

  cache = { byGroup, overall, computedAt: Date.now() };
  return cache;
}

/** P(продажа) для сделки группы grp, накопившей workDays рабочих дней. */
export function probabilityFor(model: OffloadModel, headGroup: string | null, workDays: number): number {
  const grp = headGroup && headGroup !== '' ? headGroup : '(без группы)';
  const gm = model.byGroup.get(grp) ?? model.overall;
  const day = Math.min(Math.max(0, Math.floor(workDays)), gm.probByDay.length - 1);
  return gm.probByDay[day];
}
