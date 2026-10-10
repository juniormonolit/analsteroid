import { analyticsDb } from '@/lib/db/clients';
import { loadMetrics } from '@/lib/metrics/catalog';
import { buildCollectedSQL } from '@/lib/metrics/sqlGen';
import { CATEGORY_ORDER, getManagerOrgMap } from '@/lib/org/deptCategories';
import { getMonthWorkingDays } from '@/lib/plans/dailyPlan';
import { toZonedTime } from 'date-fns-tz';
import { grandTotal, groups, type DecompRow } from '../data';

// ── «ССП тест»: декомпозиция года против факта отгрузок по месяцам ──────────────
//
// План — лист «Общая» файла «2026 Декомпозиция (Основная).xlsx», уже перенесённый
// в features/decomposition/data.ts (те же цифры, что и годовые plan_targets_year
// из миграций 046/047). Факт — отгрузки (delivered_at) по тем же метрикам, что и
// «Сводная» (primary_shipments_amount + repeat_shipments_amount), разложенные по
// филиалу/категории через lib/org/deptCategories — ровно тем же маппингом, что
// считает план/факт карточки филиалов (lib/jobs/planSummary.ts). Отличие от
// Сводной: разрез ПО МЕСЯЦАМ, а не одна цифра YTD.
//
// Сопоставление строк листа с категориями факта — решения владельца из миграции 047:
//   * МСК «НЦ Металл» слит в «НЦ» (нет отдельного отдела; в data.ts уже свёрнуто);
//   * СПб «НЦ ЖБИ-рег» слит в «НЦ ЖБИ» (продуктовый ярлык без своих сотрудников);
//   * КРД «НЦ ЖБИ» показывается как «НЦ» (реальный отдел — «КРД НЦ»);
//   * СПб ЮЛ и голый «Отдел продаж» — в «ОС».

const TZ = 'Europe/Moscow';

export type PlanFactLevel = 'russia' | 'branch' | 'dept';

export interface PlanFactRow {
  key: string;
  label: string;
  level: PlanFactLevel;
  branch: string | null;
  category: string | null;
  /** План по месяцам (Январь..Декабрь). null — у строки нет плана в декомпозиции. */
  planMonths: number[] | null;
  planYear: number | null;
  /** Факт по месяцам; будущие месяцы — 0 (в UI показываются как «—»). */
  factMonths: number[];
  factYtd: number;
  /** План «к дате»: завершённые месяцы целиком + текущий × доля прошедших рабочих дней. */
  planToDate: number | null;
  note?: string;
}

export interface PlanFactResult {
  year: number;
  /** Сегодня (МСК), YYYY-MM-DD. */
  today: string;
  /** Индекс текущего месяца 0..11 (для года не текущего — 11 или -1). */
  currentMonth: number;
  /** Доля прошедших рабочих дней текущего месяца (0..1). */
  currentMonthWeight: number;
  workingDays: { total: number; passed: number };
  rows: PlanFactRow[];
  updatedAt: string;
}

interface PlanSpec { key: string; label: string; level: PlanFactLevel; branch: string | null; category: string | null; row: DecompRow; note?: string }

function sumRows(a: DecompRow, b: DecompRow, label: string): DecompRow {
  return { label, year: a.year + b.year, months: a.months.map((v, i) => v + b.months[i]) };
}

/** Строки плана в порядке показа, уже сопоставленные с категориями факта. */
function planSpecs(): PlanSpec[] {
  const out: PlanSpec[] = [];
  out.push({ key: 'russia', label: 'ИТОГО (РОССИЯ)', level: 'russia', branch: null, category: null, row: grandTotal });
  for (const g of groups) {
    const rows: PlanSpec[] = [];
    if (g.city === 'СПБ') {
      const byLabel = new Map(g.rows.map(r => [r.label, r]));
      const zhbi = byLabel.get('СПБ (НЦ ЖБИ)')!;
      const zhbiReg = byLabel.get('СПБ (НЦ ЖБИ-рег)')!;
      rows.push({ key: 'СПБ:ОС', label: 'СПБ (ОС)', level: 'dept', branch: 'СПБ', category: 'ОС', row: byLabel.get('СПБ (ОС)')! });
      rows.push({ key: 'СПБ:НЦ', label: 'СПБ (НЦ)', level: 'dept', branch: 'СПБ', category: 'НЦ', row: byLabel.get('СПБ (НЦ)')! });
      rows.push({
        key: 'СПБ:НЦ ЖБИ', label: 'СПБ (НЦ ЖБИ + ЖБИ-рег)', level: 'dept', branch: 'СПБ', category: 'НЦ ЖБИ',
        row: sumRows(zhbi, zhbiReg, 'СПБ (НЦ ЖБИ + ЖБИ-рег)'),
        note: 'План «НЦ ЖБИ-рег» сложен с «НЦ ЖБИ»: отдельного отдела нет, факт считается по «Отделу ЖБИ».',
      });
      rows.push({ key: 'СПБ:НЦ Металл', label: 'СПБ (НЦ Металл)', level: 'dept', branch: 'СПБ', category: 'НЦ Металл', row: byLabel.get('СПБ (НЦ Металл)')! });
    } else if (g.city === 'МСК') {
      const byLabel = new Map(g.rows.map(r => [r.label, r]));
      rows.push({ key: 'МСК:ОС', label: 'МСК (ОС)', level: 'dept', branch: 'МСК', category: 'ОС', row: byLabel.get('МСК (ОС)')! });
      rows.push({
        key: 'МСК:НЦ', label: 'МСК (НЦ + НЦ Металл)', level: 'dept', branch: 'МСК', category: 'НЦ', row: byLabel.get('МСК (НЦ)')!,
        note: 'План «НЦ Металл» сложен с «НЦ»: отдельного отдела в МСК нет.',
      });
      rows.push({ key: 'МСК:ЖБИ', label: 'МСК (ЖБИ)', level: 'dept', branch: 'МСК', category: 'ЖБИ', row: byLabel.get('МСК (ЖБИ)')! });
    } else if (g.city === 'КРД') {
      const byLabel = new Map(g.rows.map(r => [r.label, r]));
      rows.push({ key: 'КРД:ОС', label: 'КРД (ОС)', level: 'dept', branch: 'КРД', category: 'ОС', row: byLabel.get('КРД (ОС)')! });
      rows.push({
        key: 'КРД:НЦ', label: 'КРД (НЦ ЖБИ)', level: 'dept', branch: 'КРД', category: 'НЦ', row: byLabel.get('КРД (НЦ ЖБИ)')!,
        note: 'Факт — по отделу «КРД НЦ» (отдельного отдела ЖБИ в Краснодаре нет).',
      });
    }
    // Сортировка подотделов — как в карточках Сводной.
    rows.sort((a, b) => CATEGORY_ORDER.indexOf(a.category!) - CATEGORY_ORDER.indexOf(b.category!));
    out.push({ key: `branch:${g.city}`, label: `ИТОГО (${g.city})`, level: 'branch', branch: g.city, category: null, row: g.total });
    out.push(...rows);
  }
  return out;
}

/** Факт отгрузок за год: Map<managerId, number[12]> (месяцы по МСК). */
async function fetchShipmentsByManagerMonth(year: number): Promise<Map<string, number[]>> {
  const allMetrics = await loadMetrics();
  const shipmentMetrics = allMetrics.filter(m => m.id === 'primary_shipments_amount' || m.id === 'repeat_shipments_amount');
  const out = new Map<string, number[]>();
  if (shipmentMetrics.length === 0) return out;

  // У обеих метрик date_field = delivered_at — бакет по нему же (как в by-periods).
  const dateField = shipmentMetrics[0].dateField ?? 'delivered_at';
  const monthExpr = `to_char(date_trunc('month', (d.${dateField} AT TIME ZONE '${TZ}')), 'MM')`;
  const sql = buildCollectedSQL(shipmentMetrics, {
    idExpr: `d.current_manager_id::text || '|' || ${monthExpr}`,
    groupBy: `GROUP BY d.current_manager_id, ${monthExpr}`,
    notNullWhere: 'd.current_manager_id IS NOT NULL',
  });
  if (!sql) return out;

  const res = await analyticsDb().query<Record<string, unknown> & { dimension_id: string }>(
    sql, [`${year}-01-01T00:00:00+03:00`, `${year + 1}-01-01T00:00:00+03:00`],
  );
  for (const row of res.rows) {
    const [managerId, mm] = row.dimension_id.split('|');
    const monthIdx = Number(mm) - 1;
    if (!(monthIdx >= 0 && monthIdx < 12)) continue;
    const sum = shipmentMetrics.reduce((acc, m) => {
      const v = row[m.id];
      return acc + (v !== null && v !== undefined ? Number(v) : 0);
    }, 0);
    let arr = out.get(managerId);
    if (!arr) { arr = new Array(12).fill(0); out.set(managerId, arr); }
    arr[monthIdx] += sum;
  }
  return out;
}

const zero12 = () => new Array<number>(12).fill(0);
const add12 = (into: number[], from: number[]) => { for (let i = 0; i < 12; i++) into[i] += from[i]; };

/** asOf — дата среза YYYY-MM-DD (по умолчанию сегодня МСК). */
export async function buildDecompositionPlanFact(year: number, asOf?: string): Promise<PlanFactResult> {
  const now = asOf ? new Date(`${asOf}T12:00:00Z`) : toZonedTime(new Date(), TZ);
  const today = now.toISOString().slice(0, 10);
  const nowYear = now.getFullYear();
  const currentMonth = year < nowYear ? 11 : year > nowYear ? -1 : now.getMonth();
  const currentMonthFirst = `${year}-${String(Math.max(currentMonth, 0) + 1).padStart(2, '0')}-01`;

  const [factByManager, orgMap, wd] = await Promise.all([
    fetchShipmentsByManagerMonth(year),
    getManagerOrgMap(),
    year === nowYear ? getMonthWorkingDays(currentMonthFirst, today) : Promise.resolve({ total: 1, passed: 1 }),
  ]);
  const currentMonthWeight = year < nowYear ? 1 : year > nowYear ? 0 : (wd.total > 0 ? Math.min(1, wd.passed / wd.total) : 0);

  // Раскладка факта: Россия — все менеджеры; филиал — по метке; категория — по
  // resolveDeptCategory. Менеджер без филиала в оргструктуре — «СПБ» (как в Сводной).
  const russia = zero12();
  const byBranch = new Map<string, number[]>();
  const byDept = new Map<string, number[]>();
  for (const [managerId, months] of factByManager) {
    add12(russia, months);
    const info = orgMap.get(managerId);
    const branch = info?.branch ?? 'СПБ';
    if (!byBranch.has(branch)) byBranch.set(branch, zero12());
    add12(byBranch.get(branch)!, months);
    if (info?.category) {
      const key = `${branch}:${info.category}`;
      if (!byDept.has(key)) byDept.set(key, zero12());
      add12(byDept.get(key)!, months);
    }
  }

  const planToDate = (months: number[]): number => {
    let s = 0;
    for (let i = 0; i < 12; i++) {
      if (i < currentMonth) s += months[i];
      else if (i === currentMonth) s += months[i] * currentMonthWeight;
    }
    return s;
  };
  const ytd = (months: number[]): number => months.slice(0, Math.max(currentMonth, -1) + 1).reduce((a, b) => a + b, 0);

  const rows: PlanFactRow[] = planSpecs().map(spec => {
    const fact = spec.level === 'russia' ? russia
      : spec.level === 'branch' ? (byBranch.get(spec.branch!) ?? zero12())
      : (byDept.get(spec.key) ?? zero12());
    return {
      key: spec.key,
      label: spec.label,
      level: spec.level,
      branch: spec.branch,
      category: spec.category,
      planMonths: spec.row.months,
      planYear: spec.row.year,
      factMonths: fact,
      factYtd: ytd(fact),
      planToDate: planToDate(spec.row.months),
      ...(spec.note ? { note: spec.note } : {}),
    };
  });

  // Филиалы с фактом, но без плана в декомпозиции (например «Екатеринбург») —
  // отдельной строкой без плана, чтобы «Россия» сходилась с суммой филиалов.
  const planned = new Set(groups.map(g => g.city));
  for (const [branch, months] of byBranch) {
    if (planned.has(branch)) continue;
    if (months.every(v => v === 0)) continue;
    rows.push({
      key: `branch:${branch}`, label: `${branch} (вне декомпозиции)`, level: 'branch', branch, category: null,
      planMonths: null, planYear: null, factMonths: months, factYtd: ytd(months), planToDate: null,
      note: 'Филиала нет в декомпозиции — показан только факт, в «ИТОГО (РОССИЯ)» учтён.',
    });
  }

  return {
    year,
    today,
    currentMonth,
    currentMonthWeight,
    workingDays: { total: wd.total, passed: wd.passed },
    rows,
    updatedAt: new Date().toISOString(),
  };
}

// L1-кэш на процесс: страницу открывают несколько руководителей подряд, а запрос
// по сделкам за год — тяжёлый. 5 минут — как у соседних движков отчётов.
const _cache = new Map<number, { at: number; value: PlanFactResult }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getDecompositionPlanFact(year: number, asOf?: string): Promise<PlanFactResult> {
  if (asOf) return buildDecompositionPlanFact(year, asOf); // срез в прошлое — без кэша, запрос редкий
  const hit = _cache.get(year);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await buildDecompositionPlanFact(year);
  _cache.set(year, { at: Date.now(), value });
  return value;
}
