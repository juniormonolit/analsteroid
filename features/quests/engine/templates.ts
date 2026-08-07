// Шаблоны выдачи квестов — конструктор в админке (задача 60, миграция 164).
//
// Шаблон описывает, ЧТО и КОМУ выдавать, а движок (quests.ts) превращает его в
// кандидата наравне со встроенными «слабостями». Разделение намеренное: правила
// подбора цели, тиры и награды остаются в одном месте, шаблон только
// параметризует их.
//
// Здесь — типы, чтение из БД, проверка аудитории и валидация ввода из формы.
// Построение кандидата живёт в quests.ts, чтобы не тащить туда-сюда GenQuest и
// не заводить кольцевой импорт (тип категории импортируется как `import type`,
// он стирается при компиляции).

import type { Pool, PoolClient } from 'pg';
import type { QuestCategory, QuestPeriod } from './quests';

export type TemplateKind = 'category' | 'metric';
export type TargetMode = 'personal_p75' | 'personal_median' | 'company_median' | 'fixed';

export const TARGET_MODES: TargetMode[] = ['personal_p75', 'personal_median', 'company_median', 'fixed'];
export const TARGET_MODE_LABELS: Record<TargetMode, string> = {
  personal_p75: 'Личный p75 (как у встроенных)',
  personal_median: 'Личная медиана + 1',
  company_median: 'Медиана компании (всем одинаково)',
  fixed: 'Фиксированное число',
};

export interface QuestAudience {
  deptIds?: string[];
  managerIds?: number[];
  minLevel?: number;
}

export interface QuestTemplate {
  id: number;
  enabled: boolean;
  name: string;
  kind: TemplateKind;
  category: QuestCategory | null;
  metricId: string | null;
  periodType: QuestPeriod;
  targetMode: TargetMode;
  targetFixed: number | null;
  targetFloor: number | null;
  targetCeiling: number | null;
  rewardEballs: number | null;
  weight: number;
  audience: QuestAudience;
  titleTemplate: string | null;
}

export function templateFromDb(r: Record<string, unknown>): QuestTemplate {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r.id),
    enabled: Boolean(r.enabled),
    name: String(r.name),
    kind: r.kind as TemplateKind,
    category: (r.category as QuestCategory) ?? null,
    metricId: (r.metric_id as string) ?? null,
    periodType: r.period_type as QuestPeriod,
    targetMode: r.target_mode as TargetMode,
    targetFixed: num(r.target_fixed),
    targetFloor: num(r.target_floor),
    targetCeiling: num(r.target_ceiling),
    rewardEballs: num(r.reward_eballs),
    weight: Number(r.weight ?? 1),
    audience: (r.audience as QuestAudience) ?? {},
    titleTemplate: (r.title_template as string) ?? null,
  };
}

/** Включённые шаблоны периода. Пустой список = движок работает как раньше,
 *  только на встроенных кандидатах — это и есть состояние «конструктором ещё
 *  не пользовались». Таблица маленькая (её ведёт руками владелец), поэтому
 *  читается без кэша: свежесть после правки формы важнее одного SELECT-а. */
export async function loadQuestTemplates(
  db: Pool | PoolClient, periodType?: QuestPeriod,
): Promise<QuestTemplate[]> {
  try {
    const r = await db.query<Record<string, unknown>>(
      `SELECT * FROM quest_templates WHERE enabled${periodType ? ' AND period_type = $1' : ''}
        ORDER BY weight DESC, id`,
      periodType ? [periodType] : [],
    );
    return r.rows.map(templateFromDb);
  } catch {
    return []; // до миграции 164 таблицы нет — движок работает по-старому
  }
}

/** Подходит ли шаблон этому менеджеру. Пустая аудитория = всем. */
export function matchesAudience(
  t: QuestTemplate, ctx: { deptId: string | null; xpLevel: number; mgr: number },
): boolean {
  const a = t.audience ?? {};
  if (Array.isArray(a.managerIds) && a.managerIds.length > 0) {
    if (!a.managerIds.map(Number).includes(ctx.mgr)) return false;
  }
  if (Array.isArray(a.deptIds) && a.deptIds.length > 0) {
    if (ctx.deptId === null || !a.deptIds.map(String).includes(String(ctx.deptId))) return false;
  }
  if (a.minLevel != null && Number(a.minLevel) > 0 && ctx.xpLevel < Number(a.minLevel)) return false;
  return true;
}

// ── валидация ввода из формы конструктора ────────────────────────────────────

export interface TemplateInput {
  enabled?: unknown; name?: unknown; kind?: unknown; category?: unknown; metricId?: unknown;
  periodType?: unknown; targetMode?: unknown; targetFixed?: unknown; targetFloor?: unknown;
  targetCeiling?: unknown; rewardEballs?: unknown; weight?: unknown; audience?: unknown;
  titleTemplate?: unknown;
}

const CATEGORIES: QuestCategory[] = ['sales_count', 'sales_amount', 'group_sales', 'repeat_sales',
  'crosssell', 'distinct_groups', 'bookings_count'];
const PERIODS: QuestPeriod[] = ['day', 'week', 'month'];

/** Приводит ввод формы к строкам БД. Возвращает ошибку текстом — она уходит
 *  в форму как есть, поэтому формулировки человеческие, а не «invalid field». */
export function validateTemplate(
  b: TemplateInput,
): { ok: true; value: Omit<QuestTemplate, 'id'> } | { ok: false; error: string } {
  const name = String(b.name ?? '').trim();
  if (name.length < 2 || name.length > 120) return { ok: false, error: 'Название: от 2 до 120 символов' };

  const kind = b.kind === 'metric' ? 'metric' : 'category';
  const category = kind === 'category' ? String(b.category ?? '') as QuestCategory : null;
  const metricId = kind === 'metric' ? String(b.metricId ?? '').trim() : null;
  if (kind === 'category' && !CATEGORIES.includes(category as QuestCategory)) {
    return { ok: false, error: 'Не выбрана категория квеста' };
  }
  if (kind === 'metric' && !metricId) return { ok: false, error: 'Не выбрана метрика каталога' };

  const periodType = String(b.periodType ?? '') as QuestPeriod;
  if (!PERIODS.includes(periodType)) return { ok: false, error: 'Период: день, неделя или месяц' };

  const targetMode = String(b.targetMode ?? 'personal_p75') as TargetMode;
  if (!TARGET_MODES.includes(targetMode)) return { ok: false, error: 'Неизвестный способ расчёта цели' };

  const optNum = (v: unknown, label: string, min: number): { v: number | null } | { error: string } => {
    if (v === null || v === undefined || v === '') return { v: null };
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return { error: `${label}: число от ${min}` };
    return { v: n };
  };
  const fixed = optNum(b.targetFixed, 'Фиксированная цель', 0.0001);
  if ('error' in fixed) return { ok: false, error: fixed.error };
  if (targetMode === 'fixed' && fixed.v === null) {
    return { ok: false, error: 'Для фиксированной цели нужно указать число' };
  }
  const floor = optNum(b.targetFloor, 'Пол цели', 0);
  if ('error' in floor) return { ok: false, error: floor.error };
  const ceiling = optNum(b.targetCeiling, 'Потолок цели', 0);
  if ('error' in ceiling) return { ok: false, error: ceiling.error };
  if (floor.v !== null && ceiling.v !== null && ceiling.v < floor.v) {
    return { ok: false, error: 'Потолок цели ниже пола' };
  }
  const reward = optNum(b.rewardEballs, 'Награда', 0);
  if ('error' in reward) return { ok: false, error: reward.error };

  const weightRaw = b.weight === undefined || b.weight === '' ? 1 : Number(b.weight);
  if (!Number.isFinite(weightRaw) || weightRaw < 0 || weightRaw > 100) {
    return { ok: false, error: 'Вес в выдаче: число от 0 до 100' };
  }

  const aRaw = (b.audience ?? {}) as Record<string, unknown>;
  const audience: QuestAudience = {};
  if (Array.isArray(aRaw.deptIds) && aRaw.deptIds.length > 0) audience.deptIds = aRaw.deptIds.map(String);
  if (Array.isArray(aRaw.managerIds) && aRaw.managerIds.length > 0) {
    const ids = aRaw.managerIds.map(Number).filter(Number.isFinite);
    if (ids.length > 0) audience.managerIds = ids;
  }
  const lvl = Number(aRaw.minLevel ?? 0);
  if (Number.isFinite(lvl) && lvl > 0) audience.minLevel = Math.floor(lvl);

  const titleTemplate = String(b.titleTemplate ?? '').trim() || null;
  if (titleTemplate && titleTemplate.length > 200) return { ok: false, error: 'Формулировка: не длиннее 200 символов' };

  return {
    ok: true,
    value: {
      enabled: b.enabled === undefined ? true : Boolean(b.enabled),
      name, kind, category, metricId, periodType, targetMode,
      targetFixed: fixed.v, targetFloor: floor.v, targetCeiling: ceiling.v,
      rewardEballs: reward.v, weight: weightRaw, audience, titleTemplate,
    },
  };
}
