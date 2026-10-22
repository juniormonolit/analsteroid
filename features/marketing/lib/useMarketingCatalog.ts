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
export interface GroupingLite { key: `g:${number}`; label: string; assign: Record<string, string> }
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
export function useSourceDimensionOptions(withManager: true): { options: DimensionOption<DrilldownDimension>[]; labelOf: (k: string | undefined) => string };
export function useSourceDimensionOptions(withManager?: false): { options: DimensionOption<SourceDimension>[]; labelOf: (k: string | undefined) => string };
export function useSourceDimensionOptions(withManager = false) {
  const { data } = useMarketingCatalog();
  return useMemo(() => {
    const custom = (data?.groupings ?? []).map(g => ({ key: g.key, label: g.label, custom: true }));
    const builtin = (withManager ? DRILLDOWN_DIMENSIONS : SOURCE_DIMENSIONS).map(d => ({ ...d, custom: false }));
    const options = [...custom, ...builtin];
    const labelOf = (k: string | undefined) =>
      options.find(o => o.key === k)?.label ?? (isCustomDimension(k) ? 'Группа' : 'Бренд');
    return { options, labelOf };
  }, [data, withManager]);
}
