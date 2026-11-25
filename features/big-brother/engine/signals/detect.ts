// «Большой брат», поток G — детекторы сигналов риска (чистые функции над дневным рядом человека).
// Норма — собственная история человека (предыдущие рабочие дни), а не общая планка. Пороги — THRESHOLDS; калибровка
// ретроспективно по датам увольнений (Увольнятор → sa.employee_tenures.end_date) — WORKLOG 25.11, поток G.
// Только подсказка директору: никаких автодействий и сообщений сотруднику.
import type { RiskSignal, SeriesPoint, SignalKind } from './types';

export type Thresholds = { [K in keyof typeof THRESHOLDS_DEFAULT]: number };

export const THRESHOLDS_DEFAULT = {
  /** Подряд рабочих дней без сигналов / без Монолитики. */
  silentDays: 5,
  /** Сколько рабочих дней до провала берём нормой. */
  baselineDays: 20,
  /** «Обычно в работе»: доля рабочих дней с сигналом в норме. */
  usualInWork: 0.5, // калибровка 25.11: при 0.7 no_signal ловил 8% уволенных за 4–2 нед., при 0.5 — 13% (контроль 3%)
  /** «Обычно заходит»: доля рабочих дней с Монолитикой в норме. */
  usualMono: 0.5,
  /** Спад: средние отрезки за последние 5 рабочих дней < этой доли нормы… */
  dropRatio: 0.4,
  /** …при норме не меньше (5-мин отрезков в день, 12 = 1 ч). */
  dropMinBaseline: 12,
  /** Всплеск выгрузок: за 7 дней ≥ exportMin и ≥ exportFactor × средняя неделя нормы (4 недели). */
  exportMin: 10,
  exportFactor: 3,
  /** Новый режим / ночь — только если в норме было хотя бы столько дней с Монолитикой. */
  monoHistoryDays: 5,
} as const;
export const THRESHOLDS: Thresholds = THRESHOLDS_DEFAULT;

const SURFACE_RU: Record<string, string> = { web: 'браузер на компьютере', mobile: 'браузер телефона', pwa: 'приложение (PWA)', bx_iframe: 'Битрикс' };
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** 5-мин отрезки → часы с одной цифрой после запятой. */
const hours = (buckets: number) => String(Math.round((buckets * 5) / 60 * 10) / 10).replace('.', ',');

/**
 * Сигналы человека на дату asOf. series — по возрастанию даты, может быть с дырами (день без строки = нет данных:
 * для «тишины» такой рабочий день считается тихим, только если он внутри диапазона данных).
 * monoSince — первая дата, с которой вообще пишется журнал Монолитики (до неё no_mono/night/new_surface/export молчат).
 */
export function detectSignals(
  personId: string, series: SeriesPoint[], asOf: string, monoSince: string | null, th: Thresholds = THRESHOLDS,
): RiskSignal[] {
  const THRESHOLDS = th;
  const out: RiskSignal[] = [];
  const pts = series.filter(p => p.date <= asOf);
  const work = pts.filter(p => p.isWorkday);
  if (!work.length) return out;
  const add = (kind: SignalKind, since: string, detail: string, weight: number) => out.push({ personId, kind, since, detail, weight });

  // ── тишина: хвост подряд рабочих дней без признака ──
  const silentRun = (has: (p: SeriesPoint) => boolean, from?: string) => {
    let i = work.length - 1;
    while (i >= 0 && !has(work[i]) && (!from || work[i].date >= from)) i--;
    return { run: work.slice(i + 1), base: work.slice(Math.max(0, i + 1 - THRESHOLDS.baselineDays), i + 1) };
  };

  const s1 = silentRun(p => p.inWork);
  if (s1.run.length >= THRESHOLDS.silentDays && s1.base.length >= THRESHOLDS.baselineDays / 2) {
    const share = s1.base.filter(p => p.inWork).length / s1.base.length;
    if (share >= THRESHOLDS.usualInWork) {
      add('no_signal', s1.run[0].date, `${s1.run.length} раб. дн. подряд ни звонков, ни сделок, ни задач, ни Монолитики; до этого в работе ${pct(share)} дней`, 100 + s1.run.length);
    }
  }

  if (monoSince) {
    const s2 = silentRun(p => p.mono > 0, monoSince);
    const base2 = s2.base.filter(p => p.date >= monoSince);
    if (s2.run.length >= THRESHOLDS.silentDays && base2.length >= THRESHOLDS.monoHistoryDays) {
      const share = base2.filter(p => p.mono > 0).length / base2.length;
      if (share >= THRESHOLDS.usualMono && !out.some(s => s.kind === 'no_signal')) {
        add('no_mono', s2.run[0].date, `${s2.run.length} раб. дн. подряд не заходил в Монолитику; раньше заходил ${pct(share)} рабочих дней`, 80 + s2.run.length);
      }
    }
  }

  // ── спад: последние 5 рабочих дней против 20 перед ними ──
  if (!out.length && work.length >= 5 + THRESHOLDS.baselineDays / 2) {
    const last = work.slice(-5), base = work.slice(-5 - THRESHOLDS.baselineDays, -5);
    const avg = (l: SeriesPoint[]) => l.reduce((s, p) => s + p.buckets, 0) / l.length;
    const a = avg(last), b = avg(base);
    if (b >= THRESHOLDS.dropMinBaseline && a < b * THRESHOLDS.dropRatio) {
      add('activity_drop', last[0].date, `за 5 раб. дн. ~${hours(a)} ч активности в день против нормы ~${hours(b)} ч (${pct(a / b)})`, 60);
    }
  }

  if (!monoSince) return out;
  const week = pts.filter(p => p.date > shift(asOf, -7));
  const prior = pts.filter(p => p.date <= shift(asOf, -7) && p.date >= monoSince);
  const priorMonoDays = prior.filter(p => p.mono > 0).length;

  // ── всплеск выгрузок ──
  const wk = week.reduce((s, p) => s + p.exports, 0);
  const base4 = prior.filter(p => p.date > shift(asOf, -35));
  if (base4.length >= 7 && wk >= THRESHOLDS.exportMin) {
    const perWeek = base4.reduce((s, p) => s + p.exports, 0) / (base4.length / 7);
    if (wk >= THRESHOLDS.exportFactor * Math.max(1, perWeek)) {
      add('export_spike', week.find(p => p.exports > 0)?.date ?? asOf, `${wk} выгрузок и проваливаний за неделю против ~${Math.round(perWeek)} в обычную неделю`, 70);
    }
  }

  if (priorMonoDays >= THRESHOLDS.monoHistoryDays) {
    // ── ночь ──
    const nightWeek = week.filter(p => p.night > 0);
    const nightBefore = prior.filter(p => p.date > shift(asOf, -37)).some(p => p.night > 0);
    if (nightWeek.length && !nightBefore) {
      add('night', nightWeek[0].date, `ночная активность ${nightWeek.length} ${nightWeek.length === 1 ? 'день' : 'дн.'} за неделю (22:00–06:00), раньше ночью не заходил`, 50);
    }
    // ── новый режим входа ──
    const seen = new Set(prior.filter(p => p.date > shift(asOf, -67)).flatMap(p => p.surfaces));
    const fresh = [...new Set(week.flatMap(p => p.surfaces))].filter(s => s && s !== 'server' && !seen.has(s));
    if (fresh.length) {
      const first = week.find(p => p.surfaces.some(s => fresh.includes(s)))!;
      add('new_surface', first.date, `впервые за 60 дней: ${fresh.map(s => SURFACE_RU[s] ?? s).join(', ')}`, 30);
    }
  }
  return out;
}

function shift(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
