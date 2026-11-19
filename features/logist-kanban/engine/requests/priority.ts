// SLA и приоритет («огонёк») — чистые функции. Веса — в настройках (logist_request_settings, админ),
// здесь значения по умолчанию и их проверка. Решение владельца: SLA по умолчанию 3 рабочих часа на цикл.
import type { LogistSettings, NotifyRecipientsSettings, PriorityFactor, PriorityInfo, PriorityWeights, RequestStatus, RequestType, SlaInfo } from './contract';
import { addWorkHours, workHoursBetween, workHoursLeft } from './worktime';

export const DEFAULT_WEIGHTS: PriorityWeights = {
  slaOverdue: 100, slaOverduePerHour: 10, slaOverdueCapHours: 10, slaHot: 40,
  amountPer100k: 3, amountMax: 30,
  deliverySoon: 30, deliverySoonDays: 3,
  waitingPerHour: 4, waitingMax: 40,
  perReturn: 15,
  cheaper: 15,
};
/** Логист очереди (права и рассылка, recipients.ts) — должность содержит «логист» или «снабж» (решение владельца 19.11). */
export const DEFAULT_NOTIFY: NotifyRecipientsSettings = { positionPatterns: ['логист', 'снабж'], includeBitrixIds: [], excludeBitrixIds: [] };
export const DEFAULT_SETTINGS: LogistSettings = { slaHours: 3, slaHotHours: 1, hotScore: 60, weights: DEFAULT_WEIGHTS, robotMode: 'send', notify: DEFAULT_NOTIFY };

const strList = (v: unknown, max: number, re?: RegExp): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
    .map(x => String(x).trim().slice(0, 100)).filter(x => x && (!re || re.test(x))))];
  return out.slice(0, max);
};

export function mergeNotify(raw: unknown): NotifyRecipientsSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    positionPatterns: (strList(r.positionPatterns, 30) ?? DEFAULT_NOTIFY.positionPatterns).map(x => x.toLowerCase().replace(/ё/g, 'е')),
    includeBitrixIds: strList(r.includeBitrixIds, 500, /^\d+$/) ?? [],
    excludeBitrixIds: strList(r.excludeBitrixIds, 500, /^\d+$/) ?? [],
  };
}

const num = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;

/** Сливает сохранённое (частичное, возможно мусорное) с умолчаниями. */
export function mergeSettings(raw: unknown): LogistSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const w = (r.weights && typeof r.weights === 'object' ? r.weights : {}) as Record<string, unknown>;
  const weights = { ...DEFAULT_WEIGHTS };
  for (const k of Object.keys(DEFAULT_WEIGHTS) as (keyof PriorityWeights)[]) {
    const v = num(w[k], 0, 10_000);
    if (v !== null) weights[k] = v;
  }
  return {
    slaHours: num(r.slaHours, 0.25, 200) ?? DEFAULT_SETTINGS.slaHours,
    slaHotHours: num(r.slaHotHours, 0, 100) ?? DEFAULT_SETTINGS.slaHotHours,
    hotScore: num(r.hotScore, 0, 100_000) ?? DEFAULT_SETTINGS.hotScore,
    weights,
    robotMode: r.robotMode === 'draft' ? 'draft' : 'send',
    notify: mergeNotify(r.notify),
  };
}

// ── SLA ─────────────────────────────────────────────────────────────────────────────────

export interface SlaInput {
  status: RequestStatus;
  /** старт текущего цикла (отправка / последний возврат) */
  cycleStartedAt: string | null;
  /** SLA очереди; null — из настроек */
  queueSlaHours: number | null;
}

export function computeSla(r: SlaInput, s: LogistSettings, now: Date): SlaInfo {
  const hours = r.queueSlaHours ?? s.slaHours;
  if ((r.status !== 'new' && r.status !== 'in_work') || !r.cycleStartedAt) {
    return { hours, deadline: null, leftHours: null, state: 'none' };
  }
  const deadline = addWorkHours(r.cycleStartedAt, hours);
  const leftHours = workHoursLeft(deadline, now);
  const state = now.getTime() > deadline.getTime() ? 'overdue' : leftHours <= s.slaHotHours ? 'hot' : 'ok';
  return { hours, deadline: deadline.toISOString(), leftHours, state };
}

// ── приоритет ───────────────────────────────────────────────────────────────────────────

export interface PriorityInput {
  type: RequestType;
  status: RequestStatus;
  amount: number;
  /** YYYY-MM-DD */
  deliveryDate: string | null;
  returnsCount: number;
  lastEventAt: string;
  sla: SlaInfo;
}

const fmtH = (h: number) => `${(Math.round(h * 10) / 10).toLocaleString('ru-RU')} раб. ч`;
const fmtMoney = (x: number) =>
  x >= 1_000_000 ? `${(Math.round(x / 100_000) / 10).toLocaleString('ru-RU')} млн ₽` : `${Math.round(x / 1000).toLocaleString('ru-RU')} тыс. ₽`;
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Дней от сегодняшней даты МСК до YYYY-MM-DD (отрицательное — прошла). */
export function daysUntil(date: string, now: Date): number {
  const today = new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

export function computePriority(r: PriorityInput, s: LogistSettings, now: Date): PriorityInfo {
  if (r.status === 'draft' || r.status === 'accepted' || r.status === 'cancelled') {
    return { score: 0, reasons: [], factors: [], hot: false };
  }
  const w = s.weights;
  const f: PriorityFactor[] = [];
  // SLA — только когда запрос на логисте
  if (r.sla.state === 'overdue' && r.sla.leftHours !== null) {
    const over = Math.min(Math.max(0, -r.sla.leftHours), w.slaOverdueCapHours);
    f.push({ key: 'sla', points: w.slaOverdue + w.slaOverduePerHour * over, label: over > 0 ? `SLA просрочен на ${fmtH(over)}` : 'SLA просрочен' });
  } else if (r.sla.state === 'hot' && r.sla.leftHours !== null) {
    const k = s.slaHotHours > 0 ? 1 - Math.max(0, r.sla.leftHours) / s.slaHotHours : 1;
    f.push({ key: 'sla', points: w.slaHot * Math.max(0.25, k), label: `До конца SLA ${fmtH(Math.max(0, r.sla.leftHours))}` });
  }
  if (r.amount > 0 && w.amountPer100k > 0) {
    f.push({ key: 'amount', points: Math.min(w.amountMax, (r.amount / 100_000) * w.amountPer100k), label: `Сумма ${fmtMoney(r.amount)}` });
  }
  if (r.deliveryDate && w.deliverySoonDays > 0) {
    const d = daysUntil(r.deliveryDate, now);
    if (d <= w.deliverySoonDays) {
      const k = d <= 0 ? 1 : (w.deliverySoonDays - d + 1) / (w.deliverySoonDays + 1);
      f.push({ key: 'delivery', points: w.deliverySoon * k, label: d < 0 ? 'Дата поставки уже прошла' : d === 0 ? 'Поставка сегодня' : `Поставка через ${d} дн.` });
    }
  }
  const waiting = workHoursBetween(r.lastEventAt, now);
  if (waiting > 0 && w.waitingPerHour > 0) {
    f.push({ key: 'waiting', points: Math.min(w.waitingMax, waiting * w.waitingPerHour), label: `Ждёт ${fmtH(waiting)}` });
  }
  if (r.returnsCount > 0 && w.perReturn > 0) {
    f.push({ key: 'returns', points: r.returnsCount * w.perReturn, label: `Возвратов: ${r.returnsCount}` });
  }
  if (r.type === 'cheaper' && w.cheaper > 0) {
    f.push({ key: 'cheaper', points: w.cheaper, label: 'У заказчика цена конкурента' });
  }
  for (const x of f) x.points = round1(x.points);
  const score = round1(f.reduce((a, x) => a + x.points, 0));
  const reasons = [...f].filter(x => x.points > 0).sort((a, b) => b.points - a.points).slice(0, 3).map(x => x.label);
  return { score, reasons, factors: f, hot: score >= s.hotScore || r.sla.state === 'overdue' };
}
