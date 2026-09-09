// Формат сценария коучинга (дерево блоков) — общий для движка (lib/jobs/scenarios.ts),
// API и редактора (features/bots/ui/ScenarioEditor.tsx). Серверных импортов нет —
// файл попадает в клиентский бандл.
//
// Сценарий = триггер + две ветки блоков:
//   trigger — показатель на менеджера за окно, база (цель / своё среднее), порог =
//             база − просадка; когда значение ниже порога → ветка below, когда ≥ базы →
//             ветка norm, между — тишина;
//   блоки  — message (сообщение), wait (пауза N дней), check (проверка показателя с
//            ветвлением да/нет, вложенность любая), end (завершить цепочку с паузой).
// Цепочка идёт по блокам сверху вниз; пустая ветка check — «идти дальше по основной».
// Конец списка — цепочка завершена (пауза cooldown из триггера).

export type FlowBranch = 'below' | 'norm';

export interface FlowTrigger {
  metricId: string;
  windowDays: number;                 // окно расчёта, до вчера
  baseline: 'target' | 'own_avg';
  targetValue: number | null;         // для baseline=target
  baselineDays: number;               // для own_avg: своё значение за N дней ДО окна
  dropThreshold: number;              // порог = база − dropThreshold (п.п. для процентов)
  cooldownDays: number;               // пауза после цепочки «просадка»
  praiseCooldownDays: number;         // пауза после цепочки «в норме»
  holdDays: number;                   // цель «удержана», если ≥ порога столько дней подряд
  trackDays: number;                  // сколько дней наблюдать показатель после закрытия цепочки
}

export type CheckCondition =
  | 'recovered'   // значение ≥ порога
  | 'at_base'     // значение ≥ базы (цели)
  | 'improved'    // значение выше, чем в начале цепочки
  | 'worse';      // значение ниже, чем в начале цепочки

export type FlowNode =
  | { id: string; type: 'message'; text: string }
  | { id: string; type: 'wait'; days: number }
  | { id: string; type: 'check'; condition: CheckCondition; yes: FlowNode[]; no: FlowNode[] }
  | { id: string; type: 'end'; cooldownDays: number | null };

/** Кому: всем работающим менеджерам или выбранным (владелец 09.09). */
export interface FlowAudience { mode: 'all' | 'selected'; managerIds: number[] }

export interface ScenarioFlow {
  trigger: FlowTrigger;
  audience: FlowAudience;
  below: FlowNode[];
  norm: FlowNode[];
}

export const CONDITION_LABEL: Record<CheckCondition, string> = {
  recovered: 'Показатель вышел на порог',
  at_base:   'Показатель достиг цели (базы)',
  improved:  'Показатель выше, чем в начале цепочки',
  worse:     'Показатель ниже, чем в начале цепочки',
};

export const TEMPLATE_PLACEHOLDERS: { key: string; hint: string }[] = [
  { key: 'имя', hint: 'имя менеджера' },
  { key: 'показатель', hint: 'название метрики' },
  { key: 'значение', hint: 'текущее значение за окно' },
  { key: 'цель', hint: 'база: цель или своё среднее' },
  { key: 'порог', hint: 'база минус допустимая просадка' },
  { key: 'дельта', hint: 'отклонение от базы со знаком' },
  { key: 'было', hint: 'значение в начале цепочки' },
  { key: 'окно', hint: 'длина окна в днях' },
];

export function renderTemplate(tpl: string, ctx: Record<string, string>): string {
  return tpl.replace(/\{\s*([^}]+?)\s*\}/g, (m, key: string) => {
    const k = key.toLowerCase();
    return k in ctx ? ctx[k] : m;
  });
}

export function newNodeId(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

// ── Индекс дерева: где стоит блок и что после него ───────────────────────────
export interface NodeRef { node: FlowNode; list: FlowNode[]; index: number; branch: FlowBranch; depth: number }

export function indexFlow(flow: ScenarioFlow): Map<string, NodeRef> {
  const map = new Map<string, NodeRef>();
  const walk = (list: FlowNode[], branch: FlowBranch, depth: number) => {
    list.forEach((node, index) => {
      map.set(node.id, { node, list, index, branch, depth });
      if (node.type === 'check') { walk(node.yes, branch, depth + 1); walk(node.no, branch, depth + 1); }
    });
  };
  walk(flow.below, 'below', 0);
  walk(flow.norm, 'norm', 0);
  return map;
}

/** Следующий блок после данного: сосед по списку, а если список кончился — блок
 *  после родительской «проверки» (выход из ветки да/нет наверх). null — конец. */
export function nextAfter(flow: ScenarioFlow, idx: Map<string, NodeRef>, nodeId: string): FlowNode | null {
  const ref = idx.get(nodeId);
  if (!ref) return null;
  if (ref.index + 1 < ref.list.length) return ref.list[ref.index + 1];
  // родитель — check, у которого yes/no === ref.list
  for (const r of idx.values()) {
    if (r.node.type === 'check' && (r.node.yes === ref.list || r.node.no === ref.list)) return nextAfter(flow, idx, r.node.id);
  }
  return null;
}

export function countNodes(list: FlowNode[]): number {
  return list.reduce((n, x) => n + 1 + (x.type === 'check' ? countNodes(x.yes) + countNodes(x.no) : 0), 0);
}

// ── Валидация (API и редактор — одна и та же) ────────────────────────────────
export function validateFlow(raw: unknown): { flow: ScenarioFlow; errors: string[] } {
  const errors: string[] = [];
  const f = (raw ?? {}) as Partial<ScenarioFlow>;
  const t = (f.trigger ?? {}) as Partial<FlowTrigger>;
  const int = (v: unknown, d: number, min: number, max: number, label: string) => {
    const n = Number(v ?? d);
    if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${label}: целое от ${min} до ${max}`); return d; }
    return n;
  };
  const num = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n)) { errors.push(`${label}: число`); return null; }
    return n;
  };
  const baseline = t.baseline === 'own_avg' ? 'own_avg' : 'target';
  const trigger: FlowTrigger = {
    metricId: String(t.metricId ?? '').trim(),
    windowDays: int(t.windowDays, 30, 1, 365, 'Окно, дней'),
    baseline,
    targetValue: num(t.targetValue, 'Целевое значение'),
    baselineDays: int(t.baselineDays, 90, 7, 730, 'Своё среднее за, дней'),
    dropThreshold: Math.abs(num(t.dropThreshold, 'Допустимая просадка') ?? 0),
    cooldownDays: int(t.cooldownDays, 14, 0, 365, 'Пауза после цепочки «просадка»'),
    praiseCooldownDays: int(t.praiseCooldownDays, 14, 0, 365, 'Пауза после цепочки «в норме»'),
    holdDays: int(t.holdDays, 14, 1, 365, 'Удержание цели, дней'),
    trackDays: int(t.trackDays, 30, 0, 365, 'Наблюдение после закрытия, дней'),
  };
  if (!trigger.metricId) errors.push('Триггер: выберите показатель');
  if (baseline === 'target' && trigger.targetValue === null) errors.push('Триггер: задайте целевое значение');

  const ids = new Set<string>();
  const nodes = (list: unknown, path: string): FlowNode[] => {
    if (!Array.isArray(list)) return [];
    return list.map((n, i): FlowNode | null => {
      const o = (n ?? {}) as Record<string, unknown>;
      let id = String(o.id ?? '').trim() || newNodeId();
      while (ids.has(id)) id = newNodeId();
      ids.add(id);
      const where = `${path} · блок ${i + 1}`;
      switch (o.type) {
        case 'message': {
          const text = String(o.text ?? '').trim();
          if (!text) errors.push(`${where}: пустое сообщение`);
          if (text.length > 4000) errors.push(`${where}: сообщение длиннее 4000 символов`);
          return { id, type: 'message', text };
        }
        case 'wait': return { id, type: 'wait', days: int(o.days, 7, 1, 180, `${where} (ждать, дней)`) };
        case 'check': {
          const cond = ['recovered', 'at_base', 'improved', 'worse'].includes(String(o.condition)) ? o.condition as CheckCondition : 'recovered';
          return { id, type: 'check', condition: cond, yes: nodes(o.yes, `${where} → да`), no: nodes(o.no, `${where} → нет`) };
        }
        case 'end': return { id, type: 'end', cooldownDays: o.cooldownDays === null || o.cooldownDays === undefined || o.cooldownDays === '' ? null : int(o.cooldownDays, 14, 0, 365, `${where} (пауза)`) };
        default: errors.push(`${where}: неизвестный тип блока`); return null;
      }
    }).filter((x): x is FlowNode => x !== null);
  };
  const a = (f.audience ?? {}) as Partial<FlowAudience>;
  const managerIds = Array.isArray(a.managerIds) ? [...new Set(a.managerIds.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
  const audience: FlowAudience = { mode: a.mode === 'selected' ? 'selected' : 'all', managerIds };
  if (audience.mode === 'selected' && managerIds.length === 0) errors.push('Кому: выберите хотя бы одного менеджера или переключите на «всем»');
  const flow: ScenarioFlow = { trigger, audience, below: nodes(f.below, 'Ветка «просадка»'), norm: nodes(f.norm, 'Ветка «в норме»') };
  if (flow.below.length === 0 && flow.norm.length === 0) errors.push('Добавьте хотя бы один блок в ветку');
  if (countNodes(flow.below) + countNodes(flow.norm) > 200) errors.push('Слишком много блоков (макс. 200)');
  return { flow, errors };
}

// ── Шаблон нового сценария — пример владельца (конверсия, цель 15%) ──────────
export function defaultFlow(metricId: string): ScenarioFlow {
  const id = newNodeId;
  return {
    trigger: { metricId, windowDays: 30, baseline: 'target', targetValue: 15, baselineDays: 90, dropThreshold: 2, cooldownDays: 14, praiseCooldownDays: 14, holdDays: 14, trackDays: 30 },
    audience: { mode: 'all', managerIds: [] },
    below: [
      { id: id(), type: 'message', text: '{имя}, привет! Смотрю на твой показатель «{показатель}» за последние {окно} дней: {значение} при цели {цель} ({дельта}).\n\nДавай подтянем: пройдись по всем открытым броням и отзвонись каждому, у кого не было касания больше 3 дней — обычно это самая быстрая точка роста конверсии. Вернусь через неделю — посмотрим, что изменилось.' },
      { id: id(), type: 'wait', days: 7 },
      {
        id: id(), type: 'check', condition: 'recovered',
        yes: [
          { id: id(), type: 'message', text: '{имя}, молодец! «{показатель}» поднялся до {значение} (было {было}) — вышел на порог {порог}. Так держать! 💪' },
          { id: id(), type: 'end', cooldownDays: null },
        ],
        no: [
          { id: id(), type: 'message', text: '{имя}, проверяю, как договаривались. «{показатель}» — {значение}, всё ещё ниже порога {порог} (в начале было {было}).\n\nПосмотри, все ли брони прозвонены и по каждой ли назначен следующий шаг. Если что-то мешает — напиши мне в ответ, разберём. Проверю ещё через неделю.' },
          { id: id(), type: 'wait', days: 7 },
          {
            id: id(), type: 'check', condition: 'recovered',
            yes: [{ id: id(), type: 'message', text: '{имя}, вот это уже другое дело: «{показатель}» — {значение}, порог {порог} взят. Красавчик! 🔥' }],
            no: [{ id: id(), type: 'message', text: '{имя}, «{показатель}» пока держится на {значение}. Две недели советов не сработали — давай разберём вживую: напиши, когда удобно созвониться, посмотрим сделки вместе.' }],
          },
        ],
      },
    ],
    norm: [
      { id: id(), type: 'message', text: '{имя}, «{показатель}» за последние {окно} дней — {значение}: на уровне цели {цель} или выше. Отличная работа, так и продолжай! 🔥' },
    ],
  };
}
