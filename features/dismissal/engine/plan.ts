// Разворот плана в строки: правило вида + исключение строки. Валидация — до «Готово» (start).
//
// v2: deal_primary — умолчание по строке (qualified → transfer, иначе brak, если в воронке есть автобрак);
// deal_repeat — «змейкой» по рангу заказчика (1..N, N..1, …), все сделки заказчика — одному получателю;
// follow (задачи/дела сделок) — за итогом своей сделки; task_other / activity_other / task_creator без
// получателей — на РОПа (plan.ropBitrixId). Прочие виды — по кругу в порядке строк (ord).
import {
  DEFAULT_TOP_COUNT, DISMISSAL_ACTION_LABELS, REPEAT_BRAK_REASONS, type RepeatBrakReason, DISMISSAL_ALLOWED_ACTIONS, DISMISSAL_KIND_LABELS, DISMISSAL_KINDS,
  type DismissalAction, type DismissalItemInfo, type DismissalKind, type DismissalPlan,
} from '../types';

export interface PlanItemRef { key: string; kind: DismissalKind; ord: number; info: DismissalItemInfo }
/** note — пометка для журнала строки («вслед за сделкой …», «на РОПа»). */
export interface ResolvedItem { key: string; action: DismissalAction; target: number | null; note: string | null }

const ACTIONS: DismissalAction[] = ['transfer', 'brak', 'follow', 'close', 'remove', 'skip'];
const ROP_KINDS: DismissalKind[] = ['task_other', 'activity_other', 'task_creator'];
const isKind = (k: string): k is DismissalKind => (DISMISSAL_KINDS as readonly string[]).includes(k);
const posInt = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** План по умолчанию: на каждый вид — первое допустимое действие, без получателей; РОП подставит сканирование. */
export function defaultPlan(): DismissalPlan {
  const rules: DismissalPlan['rules'] = {};
  for (const k of DISMISSAL_KINDS) rules[k] = { action: DISMISSAL_ALLOWED_ACTIONS[k][0], targets: [] };
  return { rules, overrides: {}, topCount: DEFAULT_TOP_COUNT, ropBitrixId: null, notifyRop: true, passwordReset: true };
}

/**
 * Привести присланный план к форме контракта. Структурный мусор (неизвестный вид/действие,
 * действие не из DISMISSAL_ALLOWED_ACTIONS) — ошибка; исключение на исчезнувшую строку — молча отбрасываем;
 * transfer без получателя сохранить можно (черновик), запретит start. Поля верхнего уровня, которых нет
 * в присланном плане (ropBitrixId, notifyRop, passwordReset, topCount), берутся из prev.
 */
export function sanitizePlan(raw: unknown, itemKinds: Map<string, DismissalKind>, prev?: DismissalPlan): { plan: DismissalPlan } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'План не передан' };
  const p = raw as Record<string, unknown> & { rules?: Record<string, unknown>; overrides?: Record<string, unknown> };
  const base = { ...defaultPlan(), ...(prev ?? {}) };
  const plan: DismissalPlan = { rules: {}, overrides: {} };
  for (const [k, v] of Object.entries(p.rules ?? {})) {
    if (!isKind(k)) return { error: `Неизвестный вид: ${k}` };
    const r = v as { action?: unknown; targets?: unknown; departmentId?: unknown } | null;
    const action = r?.action as DismissalAction;
    if (!ACTIONS.includes(action) || !DISMISSAL_ALLOWED_ACTIONS[k].includes(action)) return { error: `«${DISMISSAL_KIND_LABELS[k]}»: действие ${String(r?.action)} недопустимо` };
    const targets = [...new Set((Array.isArray(r?.targets) ? r!.targets as unknown[] : []).map(posInt).filter((n): n is number => n !== null))];
    const dep = r?.departmentId;
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
  const tc = 'topCount' in p ? posInt(p.topCount) : base.topCount ?? null;
  plan.topCount = Math.min(tc ?? DEFAULT_TOP_COUNT, 500);
  plan.ropBitrixId = 'ropBitrixId' in p ? posInt(p.ropBitrixId) : base.ropBitrixId ?? null;
  plan.notifyRop = 'notifyRop' in p ? p.notifyRop !== false : base.notifyRop !== false;
  plan.passwordReset = 'passwordReset' in p ? p.passwordReset !== false : base.passwordReset !== false;
  const reason = 'repeatBrakReason' in p ? p.repeatBrakReason : base.repeatBrakReason;
  if (reason != null && reason !== '') {
    if (!REPEAT_BRAK_REASONS.some(r => r.value === reason)) return { error: `Неизвестная причина закрытия повторки: ${String(reason)}` };
    plan.repeatBrakReason = reason as RepeatBrakReason;
  }
  const note = 'note' in p ? p.note : base.note;
  if (typeof note === 'string' && note.trim()) plan.note = note.trim().slice(0, 2000);
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

/** Действие строки по умолчанию (без исключения). */
function ruleAction(kind: DismissalKind, rule: DismissalPlan['rules'][DismissalKind], info: DismissalItemInfo): DismissalAction {
  const action = rule?.action ?? DISMISSAL_ALLOWED_ACTIONS[kind][0];
  if (kind === 'deal_primary') {
    // «Передать» на первичке = умолчание по строке; «В автобрак» правилом — там, где стадия есть, иначе передать.
    if (action === 'transfer') return info.qualified || !info.brakAvailable ? 'transfer' : 'brak';
    if (action === 'brak') return info.brakAvailable ? 'brak' : 'transfer';
  }
  return action;
}

/**
 * Разворот: действие и получатель каждой строки + список проблем (пусто — можно запускать).
 * В resolved follow уже развёрнут (transfer / close / skip), note — откуда.
 */
export function resolvePlan(plan: DismissalPlan, items: PlanItemRef[], sourceId: number): { resolved: ResolvedItem[]; problems: string[] } {
  const problems: string[] = [];
  const out = new Map<string, ResolvedItem>();
  const sorted = [...items].sort((a, b) => DISMISSAL_KINDS.indexOf(a.kind) - DISMISSAL_KINDS.indexOf(b.kind) || a.ord - b.ord);
  const missing = new Map<DismissalKind, number>();
  const rop = plan.ropBitrixId ?? null;
  for (const k of DISMISSAL_KINDS) {
    const rule = plan.rules[k];
    if (rule?.targets.includes(sourceId)) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: среди получателей — сам увольняемый`);
    if (rule && !DISMISSAL_ALLOWED_ACTIONS[k].includes(rule.action)) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: действие «${DISMISSAL_ACTION_LABELS[rule.action]}» недопустимо`);
  }
  if (rop === sourceId) problems.push('РОП не может быть самим увольняемым — выберите другого');

  // Первый проход: действие каждой строки (follow пока как есть).
  const actionOf = new Map<string, DismissalAction>();
  for (const it of sorted) {
    const ov = plan.overrides[it.key];
    const action = ov?.action ?? ruleAction(it.kind, plan.rules[it.kind], it.info);
    if (!DISMISSAL_ALLOWED_ACTIONS[it.kind].includes(action)) { problems.push(`Строка ${it.key}: действие «${DISMISSAL_ACTION_LABELS[action]}» недопустимо`); continue; }
    // Повторка (v3): «закрыть» есть в обеих повторных воронках (REPEAT_BRAK_STAGE), проверка стадии — у исполнителя.
    if (action === 'brak' && it.kind === 'deal_primary' && !it.info.brakAvailable) { problems.push(`Строка ${it.key}: в этой воронке нет стадии автобрака`); continue; }
    actionOf.set(it.key, action);
  }

  // Повторка: змейка по заказчикам в порядке ранга (ord = ранг, затем id). Ручные получатели — вне змейки.
  const repeatTargets = plan.rules.deal_repeat?.targets ?? [];
  const snake = new Map<string, number>(); // clientKey → получатель
  let ci = 0;
  for (const it of sorted) {
    if (it.kind !== 'deal_repeat' || actionOf.get(it.key) !== 'transfer' || plan.overrides[it.key]?.target || !repeatTargets.length) continue;
    const client = it.info.clientKey ?? it.key;
    if (snake.has(client)) continue;
    const n = repeatTargets.length, round = Math.floor(ci / n), pos = ci % n;
    snake.set(client, repeatTargets[round % 2 === 0 ? pos : n - 1 - pos]);
    ci++;
  }

  const rr: Partial<Record<DismissalKind, number>> = {};
  for (const it of sorted) {
    const action = actionOf.get(it.key);
    if (!action) continue;
    if (action === 'follow') continue; // второй проход
    const ov = plan.overrides[it.key];
    const rule = plan.rules[it.kind];
    let target: number | null = null;
    let note: string | null = null;
    if (action === 'transfer') {
      if (ov?.target) target = ov.target;
      else if (it.kind === 'deal_repeat') target = snake.get(it.info.clientKey ?? it.key) ?? null;
      else if (rule?.targets.length) {
        const i = rr[it.kind] ?? 0;
        target = rule.targets[i % rule.targets.length];
        rr[it.kind] = i + 1;
      } else if (ROP_KINDS.includes(it.kind) && !rule?.departmentId) {
        if (!rop) { problems.push(`«${DISMISSAL_KIND_LABELS[it.kind]}»: РОП не определён — выберите РОПа или получателя`); continue; }
        target = rop;
        note = 'на РОПа';
      }
      if (!target) { missing.set(it.kind, (missing.get(it.kind) ?? 0) + 1); continue; }
      if (target === sourceId) { problems.push(`Строка ${it.key}: получатель — сам увольняемый`); continue; }
    }
    out.set(it.key, { key: it.key, action, target, note });
  }

  // follow: за итогом своей сделки.
  for (const it of sorted) {
    if (actionOf.get(it.key) !== 'follow') continue;
    const dealKey = it.info.dealKey;
    const deal = dealKey ? out.get(dealKey) : undefined;
    if (!dealKey || !deal) {
      // Сделки нет среди строк (или у неё ошибка плана — она уже в problems): не трогаем.
      out.set(it.key, { key: it.key, action: 'skip', target: null, note: 'Сделка не в прогоне — не трогали' });
      continue;
    }
    const dealId = dealKey.split(':')[1];
    if (deal.action === 'transfer') out.set(it.key, { key: it.key, action: 'transfer', target: deal.target, note: `вслед за сделкой #${dealId}` });
    else if (deal.action === 'brak') out.set(it.key, { key: it.key, action: 'close', target: null, note: dealKey.startsWith('deal_repeat:') ? `сделка #${dealId} закрыта` : `сделка #${dealId} в автобраке` });
    else out.set(it.key, { key: it.key, action: 'skip', target: null, note: `сделку #${dealId} не трогаем` });
  }

  for (const [k, n] of missing) problems.push(`«${DISMISSAL_KIND_LABELS[k]}»: «Передать» без получателя (${n} шт.)`);
  return { resolved: sorted.map(it => out.get(it.key)).filter((x): x is ResolvedItem => !!x), problems: [...new Set(problems)] };
}
