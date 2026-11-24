import type { SearchSelectOption } from '@/components/ui/SearchSelect';
import type {
  DismissalItem, DismissalKind, DismissalOverride, DismissalPlan, DismissalRule, DismissalRunDetail,
} from '../types';
import type { DeptManagers, PlanTotals, RepeatClient, ResolvedItem } from './planMath';

// Общий контекст мастера черновика (v3): данные плана, производные, действия и навигация.

export type StepKey = 'top' | 'rest' | 'primary' | 'brak' | 'tasks' | 'final';

export const STEPS: { key: StepKey; title: string; next: string | null }[] = [
  { key: 'top', title: 'Сладкая повторка', next: 'Далее: остальная повторка' },
  { key: 'rest', title: 'Остальная повторка', next: 'Далее: сладкая первичка' },
  { key: 'primary', title: 'Сладкая первичка', next: 'Далее: оставшаяся первичка' },
  { key: 'brak', title: 'Оставшаяся первичка', next: 'Далее: задачи' },
  { key: 'tasks', title: 'Задачи без сделок', next: 'К итогу' },
  { key: 'final', title: 'Итог и запуск', next: null },
];
export const STEP_KEYS = STEPS.map(s => s.key);

export type StepState = 'empty' | 'todo' | 'warn' | 'done';
export interface StepStatus {
  state: StepState;
  /** Счётчик во вкладке: «20 заказчиков» / «осталось 6» / «20 из 20» / «нет» */
  count: string;
  /** Блокеры запуска — человеческим текстом */
  blockers: string[];
}

export type SaveState = { s: 'idle' | 'saving' | 'saved' } | { s: 'error'; msg: string };

export interface WizardCtx {
  run: DismissalRunDetail;
  plan: DismissalPlan;
  items: DismissalItem[];
  resolved: Map<string, ResolvedItem>;
  totals: PlanTotals;
  recipients: SearchSelectOption[];
  deptOptions: SearchSelectOption[];
  deptManagers: DeptManagers;
  deptName: (id: string) => string;
  deptsReady: boolean;
  usersReady: boolean;
  ownDeptId: string | null;
  nameOf: (id: number | null | undefined) => string;
  ropName: string | null;
  kuznetsova: string;
  /** Повторка по заказчикам в порядке ранга; топ — первые topCount */
  clients: RepeatClient[];
  top: RepeatClient[];
  rest: RepeatClient[];
  /** Первичка: прошла критерий (шаг 3) / не прошла (шаг 4) — по статичному info.qualified */
  primaryQ: DismissalItem[];
  primaryN: DismissalItem[];
  statuses: Record<StepKey, StepStatus>;
  step: StepKey;
  goStep: (k: StepKey) => void;
  save: SaveState;
  retrySave: () => void;
  update: (fn: (p: DismissalPlan) => DismissalPlan) => void;
  setRule: (kind: DismissalKind, patch: Partial<DismissalRule>) => void;
  setOverrides: (patch: Record<string, DismissalOverride | null>) => void;
  setTopCount: (n: number) => void;
}

/** Ключи сделок заказчиков. */
export const dealKeysOf = (clients: RepeatClient[]) => clients.flatMap(c => c.items.map(i => i.key));
