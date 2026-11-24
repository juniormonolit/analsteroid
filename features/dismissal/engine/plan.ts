// Разворот плана в строки: правило вида + исключение строки. Несколько получателей → по кругу,
// стабильно по порядку строк (ord). Валидация — до «Готово» (start).
import { DISMISSAL_ACTION_LABELS, DISMISSAL_ALLOWED_ACTIONS, DISMISSAL_KIND_LABELS, DISMISSAL_KINDS, type DismissalAction, type DismissalKind, type DismissalPlan } from '../types';

export interface PlanItemRef { key: string; kind: DismissalKind; ord: number }
export interface ResolvedItem { key: string; action: DismissalAction; target: number | null }

const ACTIONS: DismissalAction[] = ['transfer', 'close', 'remove', 'skip'];
const isKind = (k: string): k is DismissalKind => (DISMISSAL_KINDS as readonly string[]).includes(k);
const posInt = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** План по умолчанию: на каждый вид — первое допустимое действие, без получателей. */
export function defaultPlan(): DismissalPlan {
  const rules: DismissalPlan['rules'] = {};
  for (const k of DISMISSAL_KINDS) rules[k] = { action: DISMISSAL_ALLOWED_ACTIONS[k][0], targets: [] };
  return { rules, overrides: {} };
}

/**
 * Привести присланный план к форме контракта. Структурный мусор (неизвестный вид/действие,
 * действие не из DISMISSAL_ALLOWED_ACTIONS, исключение на несуществующую строку) — ошибка;
 * transfer без получателя сохранить можно (черновик), запретит start.
 */
export function sanitizePlan(raw: unknown, itemKinds: Map<string, DismissalKind>): { plan: DismissalPlan } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'План не передан' };
  const p = raw as { rules?: Record<string, unknown>; overrides?: Record<string, unknown>; note?: unknown };
  const plan: DismissalPlan = { rules: {}, overrides: {} };
  for (const [k, v] of Object.entries(p.rules ?? {})) {
    if (!isKind(k)) return { error: `Неизвестный вид: ${k}` };
    const r = v as { action?: unknown; targets?: unknown } | null;
    const action = r?.action as DismissalAction;
    if (!ACTIONS.includes(action) || !DISMISSAL_ALLOWED_ACTIONS[k].includes(action)) return { error: `«${DISMISSAL_KIND_LABELS[k]}»: действие ${String(r?.action)} недопустимо` };
    const targets = [...new Set((Array.isArray(r?.targets) ? r!.targets as unknown[] : []).map(posInt).filter((n): n is number => n !== null))];
    const dep = (r as { departmentId?: unknown } | null)?.departmentId;
    const departmentId = typeof dep === 'string' && /^\d+$/.test(dep.trim()) ? dep.trim() : typeof dep === 'number' && dep > 0 ? String(dep) : null;
    plan.rules[k] = departmentId ? { action, targets, departmentId } : { action, targets };
  }
  for (const [key, v] of Object.entries(p.overrides ?? {})) {
    const kind = itemKinds.get(key);
    if (!kind) continue; // строка исчезла после пересборки — исключение молча отбрасываем
    const o = v as { action?: unknown; target?: unknown } | null;
    const action = o?.action as DismissalAction;
    if (!ACTIONS.includes(action) || !DISMISSAL_ALLOWED_ACTIONS[kind].includes(action)) return { error: `Строка ${key}: действие ${String(o?.action)} недопустимо` };
    plan.overrides[key] = { action, target: posInt(o?.target) };
  }
  if (typeof p.note === 'string' && p.note.trim()) plan.note = p.note.trim().slice(0, 2000);
  return { plan };
}

/**
 * «Раскидать по отделу»: подставить в правила с departmentId текущий состав отдела (в момент start).
 * departmentTargets — активные сотрудники отдела без увольняемого.
 */
export async function expandDepartments(plan: DismissalPlan, departmentTargets: (id: string) => Promise<number[]>): Promise<{ plan: DismissalPlan; problems: string[] }> {
  const rules: DismissalPlan['rules'] = {};
  const problems: string[] = [];
  for (const k of DISMISSAL_KINDS) {
    const r = plan.rules[k];
    if (!r) continue;
    if (r.departmentId && r.action === 'transfer') {
      const targets = await departmentTargets(r.departmentId);
      if (!targets.length) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: в выбранном отделе нет активных менеджеров (кроме увольняемого) — раскидать не на кого`);
      rules[k] = { ...r, targets };
    } else rules[k] = r;
  }
  return { plan: { ...plan, rules }, problems };
}

/**
 * Разворот: действие и получатель каждой строки + список проблем (пусто — можно запускать).
 * items — в порядке (kind, ord).
 */
export function resolvePlan(plan: DismissalPlan, items: PlanItemRef[], sourceId: number): { resolved: ResolvedItem[]; problems: string[] } {
  const problems: string[] = [];
  const resolved: ResolvedItem[] = [];
  const rr: Partial<Record<DismissalKind, number>> = {};
  const sorted = [...items].sort((a, b) => DISMISSAL_KINDS.indexOf(a.kind) - DISMISSAL_KINDS.indexOf(b.kind) || a.ord - b.ord);
  const missing = new Map<DismissalKind, number>();
  for (const k of DISMISSAL_KINDS) {
    const rule = plan.rules[k];
    if (rule?.targets.includes(sourceId)) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: среди получателей — сам увольняемый`);
    if (rule && !DISMISSAL_ALLOWED_ACTIONS[k].includes(rule.action)) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: действие «${DISMISSAL_ACTION_LABELS[rule.action]}» недопустимо`);
  }
  for (const it of sorted) {
    const rule = plan.rules[it.kind] ?? { action: DISMISSAL_ALLOWED_ACTIONS[it.kind][0], targets: [] };
    const ov = plan.overrides[it.key];
    const action = ov?.action ?? rule.action;
    if (!DISMISSAL_ALLOWED_ACTIONS[it.kind].includes(action)) { problems.push(`Строка ${it.key}: действие «${DISMISSAL_ACTION_LABELS[action]}» недопустимо`); continue; }
    let target: number | null = null;
    if (action === 'transfer') {
      if (ov?.target) target = ov.target;
      else if (rule.targets.length) {
        const i = rr[it.kind] ?? 0;
        target = rule.targets[i % rule.targets.length];
        rr[it.kind] = i + 1;
      }
      if (!target) { missing.set(it.kind, (missing.get(it.kind) ?? 0) + 1); continue; }
      if (target === sourceId) { problems.push(`Строка ${it.key}: получатель — сам увольняемый`); continue; }
    }
    resolved.push({ key: it.key, action, target });
  }
  for (const [k, n] of missing) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: «Передать» без получателя (${n} шт.)`);
  return { resolved, problems: [...new Set(problems)] };
}
