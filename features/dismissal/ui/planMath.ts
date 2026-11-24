import {
  DEFAULT_TOP_COUNT, DISMISSAL_ALLOWED_ACTIONS,
  type DismissalAction, type DismissalItem, type DismissalKind, type DismissalPlan, type DismissalRule,
} from '../types';

// Расчёт «что будет» по черновику плана (v3: повторку можно закрыть — brak) — для подписей строк, итогов и сводки «Готово».
// Сервер валидирует и разворачивает план сам (в start); здесь — то же правило, чтобы человек видел
// результат заранее. Расхождения в мелочах (точный порядок змейки) допустимы — это предпросмотр.

/** Виды, у которых пустые targets при transfer = РОП (plan.ropBitrixId). */
export const ROP_FALLBACK_KINDS: DismissalKind[] = ['task_other', 'activity_other', 'task_creator'];

export type DeptManagers = (departmentId: string) => number[];

/** Действие строки по умолчанию: первичка — по строке (qualified → передать, иначе автобрак, если есть). */
export function defaultAction(item: DismissalItem): DismissalAction {
  if (item.kind === 'deal_primary') {
    if (item.info?.qualified) return 'transfer';
    return item.info?.brakAvailable ? 'brak' : 'transfer';
  }
  return DISMISSAL_ALLOWED_ACTIONS[item.kind][0];
}

/** Действие допустимо для строки (brak первички — только если в воронке есть стадия автобрака;
 *  brak повторки — «закрыть» с причиной plan.repeatBrakReason, доступен всегда). */
export function actionAllowed(item: DismissalItem, a: DismissalAction): boolean {
  if (!DISMISSAL_ALLOWED_ACTIONS[item.kind].includes(a)) return false;
  if (a === 'brak' && item.kind === 'deal_primary') return !!item.info?.brakAvailable;
  return true;
}

/** Правило вида: из плана или по умолчанию. Для первички action правила не используется (умолчание по строке). */
export function ruleOf(plan: DismissalPlan, kind: DismissalKind): DismissalRule {
  const r = plan.rules[kind];
  const allowed = DISMISSAL_ALLOWED_ACTIONS[kind];
  const action = r && allowed.includes(r.action) ? r.action : allowed[0];
  return { action, targets: r?.targets ?? [], departmentId: r?.departmentId ?? null };
}

export function ruleTargets(rule: DismissalRule, deptManagers: DeptManagers): number[] {
  return rule.departmentId ? deptManagers(rule.departmentId) : rule.targets;
}

export const topCountOf = (plan: DismissalPlan) => plan.topCount ?? DEFAULT_TOP_COUNT;

export interface ResolvedItem {
  item: DismissalItem;
  /** Итоговое действие; follow развёрнут: transfer (за сделкой) / close (сделка в автобраке) / skip */
  action: DismissalAction;
  /** Для follow — исходно «вслед за сделкой» */
  viaFollow: boolean;
  target: number | null;
  /** Получатель — РОП по умолчанию */
  toRop: boolean;
  overridden: boolean;
}

export interface RepeatClient {
  key: string;
  name: string;
  rank: number;
  ltv: number;
  shipments: number;
  items: DismissalItem[];
}

/** Заказчики повторки в порядке ранга (rank, LTV, отгрузки); сделки одного заказчика вместе. */
export function repeatClients(items: DismissalItem[]): RepeatClient[] {
  const m = new Map<string, RepeatClient>();
  for (const it of items) {
    if (it.kind !== 'deal_repeat') continue;
    const key = it.info?.clientKey ?? `deal:${it.entityId}`;
    let c = m.get(key);
    if (!c) {
      c = { key, name: it.info?.clientName ?? it.title, rank: it.info?.rank ?? Number.MAX_SAFE_INTEGER, ltv: it.info?.ltv ?? 0, shipments: it.info?.shipments ?? 0, items: [] };
      m.set(key, c);
    }
    c.items.push(it);
  }
  return [...m.values()].sort((a, b) => a.rank - b.rank || b.ltv - a.ltv || b.shipments - a.shipments || a.name.localeCompare(b.name, 'ru'));
}

/** Змейка: 0,1,…,k-1,k-1,…,1,0,0,1,… — чтобы суммарный LTV у получателей выходил ровным. */
export function snake(i: number, k: number): number {
  const lap = Math.floor(i / k), pos = i % k;
  return lap % 2 === 0 ? pos : k - 1 - pos;
}

export function resolveItems(plan: DismissalPlan, items: DismissalItem[], deptManagers: DeptManagers): ResolvedItem[] {
  const rop = plan.ropBitrixId ?? null;
  const out = new Map<string, ResolvedItem>();
  const rrIdx: Partial<Record<DismissalKind, number>> = {};
  const targetsOf = (k: DismissalKind) => ruleTargets(ruleOf(plan, k), deptManagers);

  // 1) повторка: ручной получатель — как есть; остальные заказчики — змейкой по рангу (по заказчику целиком).
  const repTargets = targetsOf('deal_repeat');
  const repRule = ruleOf(plan, 'deal_repeat');
  let snakeIdx = 0;
  for (const c of repeatClients(items)) {
    const free: DismissalItem[] = [];
    for (const it of c.items) {
      const ov = plan.overrides[it.key];
      // ручной получатель без явного действия = передать, даже если правило — «закрыть»
      const action = ov && actionAllowed(it, ov.action) ? ov.action : repRule.action;
      if (action !== 'transfer') out.set(it.key, { item: it, action, viaFollow: false, target: null, toRop: false, overridden: !!ov });
      else if (ov?.target) out.set(it.key, { item: it, action, viaFollow: false, target: ov.target, toRop: false, overridden: true });
      else free.push(it);
    }
    if (free.length) {
      const t = repTargets.length ? repTargets[snake(snakeIdx++, repTargets.length)] : null;
      for (const it of free) out.set(it.key, { item: it, action: 'transfer', viaFollow: false, target: t, toRop: false, overridden: !!plan.overrides[it.key] });
    }
  }

  // 2) остальное, кроме follow
  for (const it of items) {
    if (it.kind === 'deal_repeat' || out.has(it.key)) continue;
    const ov = plan.overrides[it.key];
    const rule = ruleOf(plan, it.kind);
    const base = it.kind === 'deal_primary' ? defaultAction(it) : rule.action;
    const action = ov && actionAllowed(it, ov.action) ? ov.action : base;
    if (action === 'follow') continue;
    if (action !== 'transfer') { out.set(it.key, { item: it, action, viaFollow: false, target: null, toRop: false, overridden: !!ov }); continue; }
    if (ov?.target) { out.set(it.key, { item: it, action, viaFollow: false, target: ov.target, toRop: false, overridden: true }); continue; }
    const ts = targetsOf(it.kind);
    if (ts.length) {
      const i = rrIdx[it.kind] ?? 0;
      rrIdx[it.kind] = i + 1;
      out.set(it.key, { item: it, action, viaFollow: false, target: ts[i % ts.length], toRop: false, overridden: !!ov });
    } else if (ROP_FALLBACK_KINDS.includes(it.kind)) {
      out.set(it.key, { item: it, action, viaFollow: false, target: rop, toRop: true, overridden: !!ov });
    } else {
      out.set(it.key, { item: it, action, viaFollow: false, target: null, toRop: false, overridden: !!ov });
    }
  }

  // 3) follow — за сделкой
  for (const it of items) {
    if (out.has(it.key)) continue;
    const deal = it.info?.dealKey ? out.get(it.info.dealKey) : undefined;
    const ov = !!plan.overrides[it.key];
    if (!deal || deal.action === 'skip') out.set(it.key, { item: it, action: 'skip', viaFollow: true, target: null, toRop: false, overridden: ov });
    else if (deal.action === 'brak') out.set(it.key, { item: it, action: 'close', viaFollow: true, target: null, toRop: false, overridden: ov });
    else out.set(it.key, { item: it, action: 'transfer', viaFollow: true, target: deal.target, toRop: false, overridden: ov });
  }

  return items.map(it => out.get(it.key)!);
}

export interface PlanTotals {
  repeat: { transfer: number; brak: number; skip: number; byTarget: Map<number, { deals: number; ltv: number; clients: Set<string> }> };
  primary: { transfer: number; brak: number; brakAmount: number; skip: number; byTarget: Map<number, { deals: number; amount: number }> };
  follow: { transfer: number; close: number; skip: number; byTarget: Map<number, number> };
  /** задачи/дела без сделок + постановщик → РОПу (по умолчанию) */
  toRop: number;
  otherTransfer: number;
  close: number;
  remove: number;
  skip: number;
  /** Сделки «передать», которым некому передавать (по видам) */
  missing: Partial<Record<DismissalKind, number>>;
  /** Сколько записей изменится в Битриксе (всё, кроме «не трогать») */
  changes: number;
  /** Сколько останется на уволенном («не трогать» всех видов) */
  leftOnSource: number;
}

export function planTotals(resolved: ResolvedItem[]): PlanTotals {
  const t: PlanTotals = {
    repeat: { transfer: 0, brak: 0, skip: 0, byTarget: new Map() },
    primary: { transfer: 0, brak: 0, brakAmount: 0, skip: 0, byTarget: new Map() },
    follow: { transfer: 0, close: 0, skip: 0, byTarget: new Map() },
    toRop: 0, otherTransfer: 0, close: 0, remove: 0, skip: 0, missing: {}, changes: 0, leftOnSource: 0,
  };
  for (const r of resolved) {
    const k = r.item.kind;
    if (r.action === 'skip') t.leftOnSource++; else t.changes++;
    if (r.action === 'transfer' && r.target == null && !r.viaFollow) t.missing[k] = (t.missing[k] ?? 0) + 1;
    if (k === 'deal_repeat') {
      if (r.action === 'brak') { t.repeat.brak++; continue; }
      if (r.action !== 'transfer') { t.repeat.skip++; continue; }
      t.repeat.transfer++;
      if (r.target == null) continue;
      const e = t.repeat.byTarget.get(r.target) ?? { deals: 0, ltv: 0, clients: new Set<string>() };
      e.deals++;
      const ck = r.item.info?.clientKey ?? r.item.key;
      if (!e.clients.has(ck)) { e.clients.add(ck); e.ltv += r.item.info?.ltv ?? 0; }
      t.repeat.byTarget.set(r.target, e);
    } else if (k === 'deal_primary') {
      if (r.action === 'transfer') {
        t.primary.transfer++;
        if (r.target != null) {
          const e = t.primary.byTarget.get(r.target) ?? { deals: 0, amount: 0 };
          e.deals++; e.amount += r.item.info?.amount ?? 0;
          t.primary.byTarget.set(r.target, e);
        }
      } else if (r.action === 'brak') { t.primary.brak++; t.primary.brakAmount += r.item.info?.amount ?? 0; }
      else t.primary.skip++;
    } else if (r.viaFollow) {
      if (r.action === 'transfer') {
        t.follow.transfer++;
        if (r.target != null) t.follow.byTarget.set(r.target, (t.follow.byTarget.get(r.target) ?? 0) + 1);
      } else if (r.action === 'close') t.follow.close++; else t.follow.skip++;
    } else if (r.action === 'transfer') {
      if (r.toRop) t.toRop++; else t.otherTransfer++;
    } else if (r.action === 'close') t.close++;
    else if (r.action === 'remove') t.remove++;
    else t.skip++;
  }
  return t;
}

/** Склонение: plural(5, ['сделка','сделки','сделок']) */
export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

export const fmtNum = (n: number) => n.toLocaleString('ru-RU');
export { fmtRub } from '@/features/realizations/ui/format';

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** «12,4 млн» — компактно для плиток и сводок. */
export function fmtMln(n: number | null | undefined): string {
  const v = n ?? 0;
  if (!v) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
  if (Math.abs(v) >= 1e3) return `${Math.round(v / 1e3).toLocaleString('ru-RU')} тыс.`;
  return Math.round(v).toLocaleString('ru-RU');
}
