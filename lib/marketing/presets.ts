// Стандартные маркетинговые отчёты (раздел «Маркетинг» в сайдбаре).
// «Сущность → дрилл-даун по второй сущности»; метрики/режимы — под задачу отчёта.

import type { ComparisonDisplay } from '@/lib/metrics/types';

const BASE_METRICS = [
  'primary_deals_count',
  'primary_reservations_count',
  'primary_confirmed_count',
  'primary_sales_count',
  'primary_sales_amount',
];

const QUALITY_METRICS = [
  'primary_deals_count',
  'primary_reservations_count',
  'primary_confirmed_count',
  'primary_sales_count',
  'cr_deal_to_reservation',
  'cr_reservation_to_sale',
  'cr_deal_to_sale',
];

const REFUSAL_METRICS = [
  'reservation_to_lost_count',
  'confirmed_to_lost_count',
  'sale_to_lost_count',
  'sale_to_lost_amount',
  'cr_reservation_to_lost_all',
  'cr_confirmed_to_lost_all',
  'cr_sale_to_lost_all',
];

const REPEAT_METRICS = [
  'primary_sales_count',
  'repeat_created_count',
  'repeat_sales_count',
  'cr_primary_to_repeat_created',
  'cr_repeat_created_to_sale',
  'ppp_count',
  'ppp_conversion',
  'repeat_sales_amount',
];

export interface MarketingPreset {
  title: string;
  sourceDimension: string;
  drilldownDimension: string;
  metricIds: string[];
  comparisonDisplay?: ComparisonDisplay;
  drilldownGrouped?: boolean;
}

export const MARKETING_PRESETS: Record<string, MarketingPreset> = {
  'brand-contacts':    { title: 'Бренды: типы контактов',  sourceDimension: 'brand',         drilldownDimension: 'contact_type',  metricIds: BASE_METRICS },
  'channel-brands':    { title: 'Каналы: бренды',          sourceDimension: 'channel_group', drilldownDimension: 'brand',         metricIds: BASE_METRICS },
  'platform-channels': { title: 'Витрины: каналы',         sourceDimension: 'platform',      drilldownDimension: 'ad_channel',    metricIds: BASE_METRICS },
  'branch-channels':   { title: 'Филиалы: каналы',         sourceDimension: 'branch',        drilldownDimension: 'channel_group', metricIds: BASE_METRICS },
  'brand-managers':    { title: 'Бренды: менеджеры',       sourceDimension: 'brand',         drilldownDimension: 'manager',       metricIds: BASE_METRICS },
  'sources-deals':     { title: 'Источники (детально)',    sourceDimension: 'source',        drilldownDimension: 'contact_type',  metricIds: BASE_METRICS, drilldownGrouped: false },
  'lead-quality':      { title: 'Качество лида',           sourceDimension: 'channel_group', drilldownDimension: 'brand',         metricIds: QUALITY_METRICS },
  'refusals':          { title: 'Отказы по каналам',       sourceDimension: 'channel_group', drilldownDimension: 'brand',         metricIds: REFUSAL_METRICS },
  'repeat-sales':      { title: 'Повторность по каналам',  sourceDimension: 'channel_group', drilldownDimension: 'brand',         metricIds: REPEAT_METRICS },
  'dynamics':          { title: 'Динамика брендов',        sourceDimension: 'brand',         drilldownDimension: 'contact_type',  metricIds: BASE_METRICS, comparisonDisplay: 'full' },
};
