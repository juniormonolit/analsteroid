'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SOURCE_DIMENSIONS, DRILLDOWN_DIMENSIONS, isCustomDimension,
  type SourceDimension, type DrilldownDimension,
} from '@/lib/marketing/dimensions';

export interface SourceInfoLite {
  source_id: string; name?: string;
  contact_type: string | null; branch: string | null; platform: string | null;
  brand: string | null; ad_channel: string | null; channel_group: string | null;
}
export interface GroupingLite { key: `g:${number}`; label: string; builtinKey?: string | null; assign: Record<string, string> }
export interface MarketingCatalog {
  sources: SourceInfoLite[];
  managerBranches: Record<string, string>;
  groupings: GroupingLite[];
}

/** Справочник источников + группировки «Ещё → Источники» (общий кэш React Query). */
export function useMarketingCatalog(enabled = true) {
  return useQuery({
    queryKey: ['marketing-sources'],
    queryFn: () => fetch('/api/catalog/marketing-sources').then(r => r.json()) as Promise<MarketingCatalog>,
    staleTime: 60 * 1000,
    enabled,
  });
}

export interface DimensionOption<K extends string> { key: K; label: string; custom: boolean }

/**
 * Измерения отчёта «по источникам»: сначала группировки маркетолога, затем встроенные
 * разрезы справочника. withManager — для разбивки дрилл-дауна («Менеджеры»).
 */
interface DimensionOptions<K extends string> {
  options: DimensionOption<K>[];
  labelOf: (k: string | undefined) => string;
  /** Встроенный разрез → связанная группировка (`g:<id>`), как canonicalDimension на сервере. */
  canonicalOf: <T extends string | undefined>(k: T) => T | `g:${number}`;
}
export function useSourceDimensionOptions(withManager: true): DimensionOptions<DrilldownDimension>;
export function useSourceDimensionOptions(withManager?: false): DimensionOptions<SourceDimension>;
export function useSourceDimensionOptions(withManager = false) {
  const { data } = useMarketingCatalog();
  return useMemo(() => {
    const groupings = data?.groupings ?? [];
    // Старые разрезы, заменённые группировкой маркетолога (миграция 242), в списке не дублируем.
    const linked = new Map(groupings.filter(g => g.builtinKey).map(g => [g.builtinKey as string, g.key]));
    const canonicalOf = <T extends string | undefined>(k: T): T | `g:${number}` => (k && linked.get(k)) || k;
    const custom = groupings.map(g => ({ key: g.key, label: g.label, custom: true }));
    const builtin = (withManager ? DRILLDOWN_DIMENSIONS : SOURCE_DIMENSIONS)
      .filter(d => !linked.has(d.key)).map(d => ({ ...d, custom: false }));
    const options = [...custom, ...builtin];
    const labelOf = (k: string | undefined) => {
      const c = canonicalOf(k);
      return options.find(o => o.key === c)?.label ?? (isCustomDimension(c) ? 'Группа' : 'Бренд');
    };
    return { options, labelOf, canonicalOf };
  }, [data, withManager]);
}
