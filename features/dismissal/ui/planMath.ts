import {
  DISMISSAL_ALLOWED_ACTIONS, DISMISSAL_KINDS,
  type DismissalAction, type DismissalItem, type DismissalKind, type DismissalPlan, type DismissalRule,
} from '../types';

// Расчёт «что будет» по черновику плана — для итогов, сводки по получателям и проверок до «Готово».
// Сервер валидирует план сам; здесь — то же правило, чтобы подсказать человеку заранее.

/** Правило вида: из плана или по умолчанию (первое допустимое действие, без получателей). */
export function ruleOf(plan: DismissalPlan, kind: DismissalKind): DismissalRule {
  const r = plan.rules[kind];
  const allowed = DISMISSAL_ALLOWED_ACTIONS[kind];
  if (r && allowed.includes(r.action)) return { ...r, targets: r.targets ?? [] };
  return { action: allowed[0], targets: r?.targets ?? [], departmentId: r?.departmentId ?? null };
}

export interface ResolvedItem {
  item: DismissalItem;
  action: DismissalAction;
  /** Получатель для transfer (null — не назначен); для остальных действий — null. */
  target: number | null;
  overridden: boolean;
}

/** Получатели правила: состав отдела (если «раскидать по отделу») или явный список. */
export type DeptManagers = (departmentId: string) => number[];
export function ruleTargets(rule: DismissalRule, deptManagers: DeptManagers): number[] {
  return rule.departmentId ? deptManagers(rule.departmentId) : rule.targets;
}

/** Действие и получатель каждой строки. Без исключения получатель — по кругу среди targets
 *  правила (в порядке строк), как обещано подписью «несколько — по кругу, поровну». */
export function resolveItems(plan: DismissalPlan, items: DismissalItem[], deptManagers: DeptManagers): ResolvedItem[] {
  const rr: Partial<Record<DismissalKind, number>> = {};
  const targetsOf: Partial<Record<DismissalKind, number[]>> = {};
  return items.map(item => {
    const rule = ruleOf(plan, item.kind);
    const ov = plan.overrides[item.key];
    const allowed = DISMISSAL_ALLOWED_ACTIONS[item.kind];
    if (ov && allowed.includes(ov.action)) {
      if (ov.action !== 'transfer') return { item, action: ov.action, target: null, overridden: true };
      if (ov.target) return { item, action: 'transfer', target: ov.target, overridden: true };
    }
    const action: DismissalAction = ov && allowed.includes(ov.action) ? ov.action : rule.action;
    if (action !== 'transfer') return { item, action, target: null, overridden: false };
    const targets = targetsOf[item.kind] ??= ruleTargets(rule, deptManagers);
    if (!targets.length) return { item, action, target: null, overridden: !!ov };
    const i = rr[item.kind] ?? 0;
    rr[item.kind] = i + 1;
    return { item, action, target: targets[i % targets.length], overridden: !!ov };
  });
}

export interface PlanTotals {
  transfer: number;
  close: number;
  remove: number;
  skip: number;
  /** Строк «передать», которым некому передавать */
  missingTarget: number;
  /** Виды, где не хватает получателя */
  kindsMissingTarget: DismissalKind[];
  /** получатель → вид → сколько */
  byTarget: Map<number, Partial<Record<DismissalKind, number>>>;
}

export function planTotals(resolved: ResolvedItem[]): PlanTotals {
  const t: PlanTotals = { transfer: 0, close: 0, remove: 0, skip: 0, missingTarget: 0, kindsMissingTarget: [], byTarget: new Map() };
  const missingKinds = new Set<DismissalKind>();
  for (const r of resolved) {
    t[r.action]++;
    if (r.action === 'transfer') {
      if (r.target == null) { t.missingTarget++; missingKinds.add(r.item.kind); continue; }
      const m = t.byTarget.get(r.target) ?? {};
      m[r.item.kind] = (m[r.item.kind] ?? 0) + 1;
      t.byTarget.set(r.target, m);
    }
  }
  t.kindsMissingTarget = DISMISSAL_KINDS.filter(k => missingKinds.has(k));
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

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
