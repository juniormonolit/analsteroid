// Пресеты конструктора отчётов по роли.
//
// Ответ владельца №1 по спеке: «предустановленные по роли — менеджеру
// открывается менеджерский шаблон, руководителю руководский. Перестроил под
// себя → сохранил как свой». Смысл — НОЛЬ действий для того, кому и так сойдёт
// стандартный отчёт: зашёл, нажал «Собрать», прочитал.
//
// Пресеты живут в коде, а не строками в БД: состав зависит от того, какие
// отделы человеку доступны СЕЙЧАС (перевели РОПа на другой отдел — пресет
// обязан это учесть), поэтому считается на запрос. В таблице он бы протух.

import type { SessionUser } from '@/lib/auth/session';
import { hasFullManagerAccess } from '@/lib/org/managerAccess';
import { availableEntities } from './entities';
import type { EntityInput } from './entities';

export type PeriodKey = 'day' | 'week' | 'month';

export interface ReportTemplateState {
  period: PeriodKey;
  entities: EntityInput[];
  metricIds: string[];
}

export interface ReportTemplate {
  id: string;
  name: string;
  /** Пресет по роли — его нельзя удалить, можно только пересохранить как свой. */
  kind: 'preset' | 'personal';
  isDefault: boolean;
  state: ReportTemplateState;
}

// Личный отчёт: суммы и штуки по себе. Конверсии сюда не берём — на одном
// человеке за день они шумят так, что читать нечего.
const MANAGER_METRICS = [
  'primary_sales_amount',
  'repeat_sales_amount',
  'primary_sales_count',
  'primary_reservations_count',
  'primary_deals_count',
];

// Руководский: те же суммы плюс конверсии — на отделе они уже осмысленны.
// Набор совпадает с ежедневным отчётом владельца, чтобы РОП видел ту же картину,
// по которой его и спрашивают.
const LEAD_METRICS = [
  'primary_sales_amount',
  'repeat_sales_amount',
  'primary_sales_count',
  'primary_deals_count',
  'primary_reservations_count',
  'ppp_count',
];

/**
 * Пресеты, доступные конкретному человеку. Первый в списке — то, что
 * открывается по умолчанию, если личного шаблона по умолчанию нет.
 */
export async function rolePresets(session: SessionUser): Promise<ReportTemplate[]> {
  const available = await availableEntities(session);
  const out: ReportTemplate[] = [];

  const hasSelf = !!available.self;
  const depts = available.departments;
  const full = hasFullManagerAccess(session);

  // Руководский пресет — только если есть чем руководить. Иначе менеджер получил
  // бы шаблон с пустым списком сущностей и отчёт из воздуха.
  if (depts.length > 0) {
    out.push({
      id: 'preset:lead',
      name: depts.length === 1 ? 'Мой отдел' : 'Мои отделы',
      kind: 'preset',
      isDefault: false,
      state: {
        period: 'month',
        entities: depts.map(d => ({ kind: 'department' as const, id: d.id })),
        metricIds: LEAD_METRICS,
      },
    });
  }

  if (hasSelf) {
    out.push({
      id: 'preset:manager',
      name: 'Личный отчёт',
      kind: 'preset',
      isDefault: false,
      state: { period: 'month', entities: [{ kind: 'self' }], metricIds: MANAGER_METRICS },
    });
  }

  // Руководству — разбивка по филиалам: это их привычный срез («МОСКВА» и т.п.).
  if (full && available.branches.length > 0) {
    out.push({
      id: 'preset:branches',
      name: 'По филиалам',
      kind: 'preset',
      isDefault: false,
      state: {
        period: 'month',
        entities: available.branches.map(b => ({ kind: 'branch' as const, id: b.id })),
        metricIds: LEAD_METRICS,
      },
    });
  }

  return out;
}

const PERIODS: PeriodKey[] = ['day', 'week', 'month'];
const MAX_ENTITIES = 12;
const MAX_METRICS = 60;

/** Разбор состояния из БД/запроса: чужой jsonb доверия не заслуживает. */
export function parseTemplateState(raw: unknown): ReportTemplateState | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const period = PERIODS.includes(o.period as PeriodKey) ? (o.period as PeriodKey) : 'month';

  if (!Array.isArray(o.entities) || o.entities.length === 0 || o.entities.length > MAX_ENTITIES) return null;
  const entities: EntityInput[] = [];
  for (const item of o.entities) {
    if (!item || typeof item !== 'object') return null;
    const kind = (item as Record<string, unknown>).kind;
    const id = (item as Record<string, unknown>).id;
    if (kind === 'self') { entities.push({ kind: 'self' }); continue; }
    if ((kind === 'department' || kind === 'branch') && typeof id === 'string' && id.length > 0 && id.length <= 200) {
      entities.push({ kind, id });
      continue;
    }
    return null;
  }

  const metricIds = Array.isArray(o.metricIds)
    ? o.metricIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200).slice(0, MAX_METRICS)
    : [];
  if (metricIds.length === 0) return null;

  return { period, entities, metricIds };
}
