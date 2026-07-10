import { loadMetrics, resolveMetricIds, withDependencies } from '@/lib/metrics/catalog';
import { fetchManagerActivity } from './managerActivity';
import { fetchStageConversions, STAGE_PAIRS } from './stageConversions';
import { fetchPriceObjectionConversion } from './priceObjectionConversion';
import {
  fetchCallsBaseMetrics, fetchDealCallAdditive, fetchTouchAndFirstCallMedians, fetchCallSilence,
  type Bucket, type CallsBaseRow, type DealCallAdditiveRow, type TouchAndFirstCallRow,
} from './callsMetrics';
import { computeCalculated } from './calculated';
import type { DateRange } from '@/lib/period';
import type { ReportRow } from '@/lib/metrics/types';

// Движок «любая метрика per-manager за произвольный период» (задача 10.07, п.2 —
// «Оси паутины из ВСЕХ метрик»): извлечённые из app/api/reports/run/route.ts гейты
// enrichActivity/enrichStageConv/enrichPriceObjection/enrichCalls, так, чтобы
// карточка менеджера (features/manager-card/engine/managerCard.ts) и ФИФА-сетка/
// карточка отдела (teamCard.ts) могли посчитать ЛЮБУЮ выбранную в шаблоне ось —
// не выдумывая параллельный расчёт, а переиспользуя ТЕ ЖЕ fetch*-функции движка
// отчётов, что и /api/reports/run. route.ts НЕ рефакторен на этот модуль (риск
// регрессии в проде выше выигрыша от дедупликации на объём этой задачи) — но обе
// копии вызывают один и тот же набор fetch*() из engine, поэтому расчёт в карточке
// и в отчёте математически идентичен по построению.
//
// В отличие от route.ts (считает current+comparison ОДНИМ проходом), здесь один
// вызов = ОДИН период — вызывающий код (managerCard.ts/teamCard.ts) вызывает
// дважды (период + период сравнения), как и раньше делал для periodPool/prevPool.
export async function enrichManagerRowsForMetrics(
  rows: ReportRow[],
  period: DateRange,
  requestedMetricIds: string[],
): Promise<ReportRow[]> {
  if (requestedMetricIds.length === 0) return rows;

  const allMetrics = await loadMetrics();
  const requested = resolveMetricIds(requestedMetricIds, allMetrics);
  const withDeps = withDependencies(requested, allMetrics);
  const calculatedMetrics = withDeps.filter(m => m.metricType === 'calculated');

  let out = rows;

  // ── Активность менеджеров («Дней в работе» / «% выхода» / «Сделок/день») ──────
  const activityMetricIds = ['manager_worked_days_count', 'manager_attendance_pct', 'manager_deals_per_worked_day'];
  if (withDeps.some(m => activityMetricIds.includes(m.id))) {
    const activity = await fetchManagerActivity(period);
    out = out.map(row => {
      const a = activity?.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          manager_worked_days_count: activity ? (a?.workedDays ?? 0) : null,
          manager_primary_deals_activity: activity ? (a?.primaryDealsForActivity ?? 0) : null,
        },
      };
    });
  }

  // ── Матрица CR по основному пути (конверсии стадий, migrations/064) ──────────
  const stageConversionHiddenIds = [...new Set(STAGE_PAIRS.flatMap(p => [`stage_${p.from}_denom`, `stage_${p.id}_num`]))];
  if (withDeps.some(m => stageConversionHiddenIds.includes(m.id))) {
    const conv = await fetchStageConversions(period);
    out = out.map(row => {
      const c = conv?.get(row.dimensionId);
      const metrics: Record<string, number | null> = {};
      for (const pair of STAGE_PAIRS) {
        metrics[`stage_${pair.from}_denom`] = conv ? (c?.denom[pair.from] ?? 0) : null;
        metrics[`stage_${pair.id}_num`] = conv ? (c?.num[pair.id] ?? 0) : null;
      }
      return { ...row, metrics: { ...row.metrics, ...metrics } };
    });
  }

  // ── CR «Есть цена дешевле» → Бронь/Продажа/Отказ ──────────────────────────────
  const priceObjectionHiddenIds = [
    'stage_price_lower_denom_primary', 'stage_price_lower_denom_repeat',
    'stage_price_lower_to_reservation_num_primary', 'stage_price_lower_to_reservation_num_repeat',
    'stage_price_lower_to_sale_num_primary', 'stage_price_lower_to_sale_num_repeat',
    'stage_price_lower_to_lost_num_primary', 'stage_price_lower_to_lost_num_repeat',
  ];
  if (withDeps.some(m => priceObjectionHiddenIds.includes(m.id))) {
    const po = await fetchPriceObjectionConversion(period);
    out = out.map(row => {
      const p = po?.get(row.dimensionId);
      return {
        ...row,
        metrics: {
          ...row.metrics,
          stage_price_lower_denom_primary: po ? (p?.denomPrimary ?? 0) : null,
          stage_price_lower_denom_repeat: po ? (p?.denomRepeat ?? 0) : null,
          stage_price_lower_to_reservation_num_primary: po ? (p?.numReservationPrimary ?? 0) : null,
          stage_price_lower_to_reservation_num_repeat: po ? (p?.numReservationRepeat ?? 0) : null,
          stage_price_lower_to_sale_num_primary: po ? (p?.numSalePrimary ?? 0) : null,
          stage_price_lower_to_sale_num_repeat: po ? (p?.numSaleRepeat ?? 0) : null,
          stage_price_lower_to_lost_num_primary: po ? (p?.numLostPrimary ?? 0) : null,
          stage_price_lower_to_lost_num_repeat: po ? (p?.numLostRepeat ?? 0) : null,
        },
      };
    });
  }

  // ── КОЛСТАТ (va.calls) ────────────────────────────────────────────────────────
  const callsMetricIds = [
    'calls_count', 'calls_count_repeat', 'calls_count_all',
    'calls_duration_out', 'calls_duration_out_repeat', 'calls_duration_out_all',
    'calls_duration_in', 'calls_duration_in_repeat', 'calls_duration_in_all',
    'calls_completed_duration_sum', 'calls_completed_duration_sum_repeat', 'calls_completed_duration_sum_orphan',
    'calls_completed_count', 'calls_completed_count_repeat', 'calls_completed_count_orphan',
    'calls_avg_duration', 'calls_avg_duration_repeat', 'calls_avg_duration_all',
    'calls_median_duration', 'calls_median_duration_repeat', 'calls_median_duration_all',
    'calls_first_call_duration_median', 'calls_first_call_duration_median_repeat', 'calls_first_call_duration_median_all',
    'calls_touch_speed_median', 'calls_touch_speed_median_repeat', 'calls_touch_speed_median_all',
    'calls_to_reservation_num', 'calls_to_reservation_num_repeat',
    'calls_to_reservation_denom', 'calls_to_reservation_denom_repeat',
    'calls_to_reservation_avg', 'calls_to_reservation_avg_repeat', 'calls_to_reservation_avg_all',
    'calls_missed_outbound', 'calls_missed_outbound_repeat', 'calls_missed_outbound_orphan',
    'calls_outbound_total', 'calls_outbound_total_repeat', 'calls_outbound_total_orphan',
    'calls_missed_rate', 'calls_missed_rate_repeat', 'calls_missed_rate_all',
    'calls_deals_no_call', 'calls_deals_no_call_repeat', 'calls_deals_no_call_all',
    'calls_silence_deals', 'calls_silence_deals_repeat', 'calls_silence_deals_all',
  ];
  if (withDeps.some(m => callsMetricIds.includes(m.id))) {
    const [base, additive, touch, silence] = await Promise.all([
      fetchCallsBaseMetrics(period),
      fetchDealCallAdditive(period),
      fetchTouchAndFirstCallMedians(period),
      fetchCallSilence(period.to),
    ]);

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const zeroBucket: Bucket = { primary: 0, repeat: 0, all: 0 };
    const orphanOf = (b: Bucket) => round1(b.all) - round1(b.primary) - round1(b.repeat);

    out = out.map(row => {
      const b = base?.get(row.dimensionId);
      const bb: CallsBaseRow = b ?? {
        count: zeroBucket, outDurationMin: zeroBucket, inDurationMin: zeroBucket,
        completedDurationSumMin: zeroBucket, completedCount: zeroBucket, medianDurationMin: zeroBucket,
        outboundCount: zeroBucket, missedOutboundCount: zeroBucket,
      };
      const a = additive?.get(row.dimensionId);
      const aa: DealCallAdditiveRow = a ?? { dealsNoCalls: zeroBucket, dealsWithReservation: zeroBucket, callsBeforeReservationSum: zeroBucket };
      const t = touch?.get(row.dimensionId);
      const tt: TouchAndFirstCallRow = t ?? { medianTouchMinutes: zeroBucket, medianFirstCallDurationMin: zeroBucket };
      const ss = silence?.get(row.dimensionId) ?? zeroBucket;

      const metrics: Record<string, number | null> = {
        calls_count: base ? bb.count.primary : null,
        calls_count_repeat: base ? bb.count.repeat : null,
        calls_count_all: base ? bb.count.all : null,
        calls_duration_out: base ? round1(bb.outDurationMin.primary) : null,
        calls_duration_out_repeat: base ? round1(bb.outDurationMin.repeat) : null,
        calls_duration_out_all: base ? round1(bb.outDurationMin.all) : null,
        calls_duration_in: base ? round1(bb.inDurationMin.primary) : null,
        calls_duration_in_repeat: base ? round1(bb.inDurationMin.repeat) : null,
        calls_duration_in_all: base ? round1(bb.inDurationMin.all) : null,
        calls_completed_duration_sum: base ? round1(bb.completedDurationSumMin.primary) : null,
        calls_completed_duration_sum_repeat: base ? round1(bb.completedDurationSumMin.repeat) : null,
        calls_completed_duration_sum_orphan: base ? round1(orphanOf(bb.completedDurationSumMin)) : null,
        calls_completed_count: base ? bb.completedCount.primary : null,
        calls_completed_count_repeat: base ? bb.completedCount.repeat : null,
        calls_completed_count_orphan: base ? orphanOf(bb.completedCount) : null,
        calls_median_duration: base ? round1(bb.medianDurationMin.primary) : null,
        calls_median_duration_repeat: base ? round1(bb.medianDurationMin.repeat) : null,
        calls_median_duration_all: base ? round1(bb.medianDurationMin.all) : null,
        calls_missed_outbound: base ? bb.missedOutboundCount.primary : null,
        calls_missed_outbound_repeat: base ? bb.missedOutboundCount.repeat : null,
        calls_missed_outbound_orphan: base ? orphanOf(bb.missedOutboundCount) : null,
        calls_outbound_total: base ? bb.outboundCount.primary : null,
        calls_outbound_total_repeat: base ? bb.outboundCount.repeat : null,
        calls_outbound_total_orphan: base ? orphanOf(bb.outboundCount) : null,
        calls_first_call_duration_median: touch ? round1(tt.medianFirstCallDurationMin.primary) : null,
        calls_first_call_duration_median_repeat: touch ? round1(tt.medianFirstCallDurationMin.repeat) : null,
        calls_first_call_duration_median_all: touch ? round1(tt.medianFirstCallDurationMin.all) : null,
        calls_touch_speed_median: touch ? round1(tt.medianTouchMinutes.primary) : null,
        calls_touch_speed_median_repeat: touch ? round1(tt.medianTouchMinutes.repeat) : null,
        calls_touch_speed_median_all: touch ? round1(tt.medianTouchMinutes.all) : null,
        calls_to_reservation_num: additive ? aa.callsBeforeReservationSum.primary : null,
        calls_to_reservation_num_repeat: additive ? aa.callsBeforeReservationSum.repeat : null,
        calls_to_reservation_denom: additive ? aa.dealsWithReservation.primary : null,
        calls_to_reservation_denom_repeat: additive ? aa.dealsWithReservation.repeat : null,
        calls_deals_no_call: additive ? aa.dealsNoCalls.primary : null,
        calls_deals_no_call_repeat: additive ? aa.dealsNoCalls.repeat : null,
        calls_deals_no_call_all: additive ? aa.dealsNoCalls.all : null,
        calls_silence_deals: silence ? ss.primary : null,
        calls_silence_deals_repeat: silence ? ss.repeat : null,
        calls_silence_deals_all: silence ? ss.all : null,
      };
      return { ...row, metrics: { ...row.metrics, ...metrics } };
    });
  }

  // ── Calculated (формулы из metrics.formula, после всех enrich-блоков выше) ────
  return out.map(row => ({ ...row, metrics: computeCalculated(row.metrics, calculatedMetrics) }));
}
