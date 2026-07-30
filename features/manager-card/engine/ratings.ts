// Рейтинг ВСЕХ менеджеров за период — единый источник для:
//   * раздела «Рейтинг» (/rating, задача владельца 30.07);
//   * метрики каталога «Рейтинг» (manager_rating) в отчёте «по менеджерам»;
//   * (потенциально) любых будущих сводок.
//
// Формула та же, что в карточке менеджера: перцентильный балл 0-10 по каждой оси
// ШАБЛОНА (card_templates) относительно пула «менеджеры с продажами за период»,
// затем средневзвешенное по весам осей (веса живут в самой оси — миграция 107).
// Переиспользуются экспортированные из managerCard.ts buildAxisMap/salesPositiveIds/
// percentileScore/poolValuesForAxis/ratingFor — карточка и раздел НЕ должны
// расходиться в цифрах.

import { fetchByManagers } from '@/features/reports/engine/byManagers';
import { enrichManagerRowsForMetrics } from '@/features/reports/engine/enrichManagerRows';
import { loadMetrics } from '@/lib/metrics/catalog';
import { getCardTemplate, type TemplateKey } from '@/lib/settings/cardTemplates';
import type { DateRange } from '@/lib/period';
import type { ClientType } from '@/lib/metrics/types';
import {
  buildAxisMap, salesPositiveIds, percentileScore, poolValuesForAxis, ratingFor,
  resolveTemplateAxes, fetchTouchSpeedByManager, segmentToClientType,
  type AxisDef, type CardSegment,
} from './managerCard';

export interface RatingAxisScore {
  key: string;
  label: string;
  weight: number;
  invert: boolean;
  raw: number | null;
  /** Балл 0-10 (перцентиль в пуле). null — нет данных, ось исключена из рейтинга. */
  score: number | null;
}

export interface ManagerRatingRow {
  managerId: string;
  rating: number | null;
  axes: RatingAxisScore[];
  /** Участвует ли в пуле нормировки (были продажи за период). */
  inPool: boolean;
}

export interface ManagerRatingsResult {
  /** managerId → рейтинг и баллы по осям. */
  byManager: Map<string, ManagerRatingRow>;
  /** Оси шаблона (порядок = порядок в шаблоне/паутине). */
  axes: AxisDef[];
  /** Размер пула нормировки (менеджеры с продажами за период). */
  poolSize: number;
}

export async function computeManagerRatings(opts: {
  period: DateRange;
  segment?: CardSegment;
  clientType?: ClientType;
  templateKey?: TemplateKey;
}): Promise<ManagerRatingsResult> {
  const clientType = opts.clientType ?? segmentToClientType(opts.segment ?? 'all');
  const templateKey = opts.templateKey ?? 'manager';

  const [poolRaw, touchMap, template, allMetrics] = await Promise.all([
    fetchByManagers({ period: opts.period, dealScope: 'all', clientType, accountType: 'managers' }),
    fetchTouchSpeedByManager(opts.period),
    getCardTemplate(templateKey),
    loadMetrics(),
  ]);

  const axes = resolveTemplateAxes(template.axes, allMetrics);
  // Оси из каталога метрик требуют обогащения (звонки/активность/стадии); если
  // шаблон состоит только из legacy-осей — вызов no-op, лишних запросов нет.
  const catalogKeys = axes.filter(a => a.source === 'catalog').map(a => a.bareKey);
  const pool = await enrichManagerRowsForMetrics(poolRaw, opts.period, catalogKeys);

  const axisMap = buildAxisMap(pool, touchMap, axes);
  const eligible = salesPositiveIds(pool);

  // Значения пула по каждой оси считаем ОДИН раз (иначе O(осей × менеджеров²)).
  const poolValues = new Map<string, number[]>();
  for (const def of axes) poolValues.set(def.key, poolValuesForAxis(axisMap, eligible, def.key));

  const byManager = new Map<string, ManagerRatingRow>();
  for (const row of pool) {
    const id = row.dimensionId;
    const own = axisMap.get(id);
    const axisScores: RatingAxisScore[] = axes.map(def => {
      const raw = own?.get(def.key) ?? null;
      return {
        key: def.key,
        label: def.label,
        weight: def.weight,
        invert: def.invert,
        raw,
        score: percentileScore(raw, poolValues.get(def.key) ?? [], def.invert),
      };
    });
    byManager.set(id, {
      managerId: id,
      rating: ratingFor(axisMap, eligible, id, axes),
      axes: axisScores,
      inPool: eligible.has(id),
    });
  }

  return { byManager, axes, poolSize: eligible.size };
}

/** Только рейтинги (для инъекции метрики «Рейтинг» в отчёт по менеджерам). */
export async function computeRatingValues(opts: {
  period: DateRange;
  clientType?: ClientType;
  templateKey?: TemplateKey;
}): Promise<Map<string, number | null>> {
  const { byManager } = await computeManagerRatings(opts);
  return new Map([...byManager].map(([id, r]) => [id, r.rating]));
}
