import type { DismissalItem, DismissalPlan } from '../types';
import { fmtNum, plural, ruleOf, ROP_FALLBACK_KINDS, type PlanTotals, type RepeatClient, type ResolvedItem } from './planMath';
import type { StepKey, StepStatus } from './wizardCtx';

// Состояние вкладок мастера и блокеры запуска (спека §1, §7).

const OTHER_KINDS = ['task_other', 'activity_other', 'task_creator', 'task_participant'] as const;

export function computeStatuses(a: {
  plan: DismissalPlan;
  items: DismissalItem[];
  resolved: Map<string, ResolvedItem>;
  totals: PlanTotals;
  top: RepeatClient[];
  rest: RepeatClient[];
  primaryQ: DismissalItem[];
  primaryN: DismissalItem[];
  visited: Set<StepKey>;
  ropId: number | null;
}): Record<StepKey, StepStatus> {
  const { plan, resolved, visited } = a;
  const missingIn = (items: DismissalItem[]) => items.filter(it => {
    const r = resolved.get(it.key);
    return r?.action === 'transfer' && r.target == null;
  }).length;
  const mk = (key: StepKey, n: number, unit: [string, string, string], remaining: number, blockers: string[]): StepStatus => {
    if (n === 0) return { state: 'empty', count: 'нет', blockers };
    if (blockers.length || (remaining > 0 && visited.has(key))) return { state: 'warn', count: remaining > 0 ? `осталось ${fmtNum(remaining)}` : 'проверьте', blockers };
    if (visited.has(key)) return { state: 'done', count: `${fmtNum(n - remaining)} из ${fmtNum(n)}`, blockers };
    return { state: 'todo', count: `${fmtNum(n)} ${plural(n, unit)}`, blockers };
  };
  const CL: [string, string, string] = ['заказчик', 'заказчика', 'заказчиков'];
  const DL: [string, string, string] = ['сделка', 'сделки', 'сделок'];

  // 1. Топ: у каждого должен быть ручной получатель; без него — уходит по правилу шага 2.
  const repRule = ruleOf(plan, 'deal_repeat');
  const topNoManual = a.top.filter(c => c.items.some(it => !plan.overrides[it.key]?.target && plan.overrides[it.key]?.action !== 'brak' && plan.overrides[it.key]?.action !== 'skip'));
  const topBlock: string[] = [];
  if (topNoManual.length && repRule.action === 'brak') topBlock.push(`${fmtNum(topNoManual.length)} ${plural(topNoManual.length, CL)} из топа закроются — выберите получателя`);
  else {
    const miss = missingIn(a.top.flatMap(c => c.items));
    if (miss) topBlock.push(`${fmtNum(miss)} ${plural(miss, DL)} топа без получателя`);
  }

  // 2. Остальная повторка
  const restMiss = missingIn(a.rest.flatMap(c => c.items));
  const restBlock = restMiss ? [`${fmtNum(restMiss)} ${plural(restMiss, DL)} без получателя — выберите людей или отдел`] : [];

  // 3–4. Первичка
  const pqMiss = missingIn(a.primaryQ);
  const pnMiss = missingIn(a.primaryN);

  // 5. Задачи: РОП нужен, если на него что-то уходит или включено сообщение при наличии задач без сделок
  const others = a.items.filter(i => (OTHER_KINDS as readonly string[]).includes(i.kind));
  const hasOtherForRop = a.items.some(i => i.kind === 'task_other' || i.kind === 'activity_other');
  const ropNeeded = a.totals.toRop > 0 || (!!plan.notifyRop && hasOtherForRop);
  const tasksBlock: string[] = [];
  if (ropNeeded && !a.ropId) tasksBlock.push('не выбран РОП');
  const tMiss = others.filter(it => {
    const r = resolved.get(it.key);
    return r?.action === 'transfer' && r.target == null && !(ROP_FALLBACK_KINDS.includes(it.kind) && r.toRop);
  }).length;
  if (tMiss) tasksBlock.push(`${fmtNum(tMiss)} ${plural(tMiss, ['задача', 'задачи', 'задач'])} без получателя`);
  const followCount = a.items.filter(i => i.kind === 'task_deal' || i.kind === 'activity_deal').length;

  const st: Record<StepKey, StepStatus> = {
    top: mk('top', a.top.length, CL, topNoManual.length, topBlock),
    rest: mk('rest', a.rest.length, CL, restMiss ? a.rest.filter(c => missingIn(c.items) > 0).length : 0, restBlock),
    primary: mk('primary', a.primaryQ.length, DL, pqMiss, pqMiss ? [`${fmtNum(pqMiss)} ${plural(pqMiss, DL)} без получателя`] : []),
    brak: mk('brak', a.primaryN.length, DL, pnMiss, pnMiss ? [`${fmtNum(pnMiss)} ${plural(pnMiss, DL)} к передаче без получателя`] : []),
    tasks: { ...mk('tasks', others.length + followCount, ['задача', 'задачи', 'задач'], 0, tasksBlock) },
    final: { state: 'todo', count: `${fmtNum(a.totals.changes)} ${plural(a.totals.changes, ['запись', 'записи', 'записей'])}`, blockers: [] },
  };
  // Шаг 5 доступен всегда (пароль, сообщение РОПу) — даже без задач не «пустой».
  if (st.tasks.state === 'empty') st.tasks = { state: visited.has('tasks') ? 'done' : 'todo', count: 'нет задач', blockers: tasksBlock };
  const anyBlock = (Object.keys(st) as StepKey[]).some(k => k !== 'final' && st[k].blockers.length);
  if (anyBlock) st.final = { ...st.final, state: 'warn' };
  return st;
}

export function allBlockers(st: Record<StepKey, StepStatus>): { step: StepKey; text: string }[] {
  return (Object.keys(st) as StepKey[]).flatMap(k => st[k].blockers.map(text => ({ step: k, text })));
}
