import type { ClientType, ProductGroupMode, CreatedTimeFilter, FirstTouchFilter } from '@/lib/metrics/types';
import { createdTimeWhere, firstTouchWhere } from '@/lib/metrics/offHoursFilters';
import { buildDealFilterWhere, type DealFilter } from '@/lib/metrics/dealFilters';
import { buildProductGroupFilter } from './productGroupFilter';

// Общие сделочные фильтры отчёта для СПЕЦ-ДВИЖКОВ метрик (аудит владельца 31.08:
// «все метрики должны подчиняться фильтрации отчёта»). Основной collected-путь
// (byManagers и родня) собирает эти же условия сам; движки-инжекторы (прозвон
// броней, CR стадий, «Есть цена дешевле», «вошли в стадию», «созвонились →
// продажа», факты «% плана» фиксированных окон) исторически не получали НИЧЕГО
// и считали по всем сделкам — этот модуль даёт им один и тот же WHERE-хвост.
//
// Сюда входят фильтры, режущие НАБОР СДЕЛОК: физики/юрики (clientType → воронки,
// те же номера, что funnel_type в sqlGen.ts), товарные группы, время создания
// (рабочее/нерабочее), первое касание, «Фильтр сделок» (deal_filters). dealScope
// (перв./повт./все) сюда сознательно НЕ входит: у спец-метрик тройки зашиты в
// сами id (…_repeat/_all), как и во всём каталоге.
//
// Условия пишутся про алиас `d` таблицы deals (sa.deals) — все движки-потребители
// его и используют; параметризованные куски продолжают нумерацию с paramOffset.
export interface CommonDealFilterOpts {
  clientType?: ClientType;
  productGroupMode?: ProductGroupMode;
  productGroupIds?: string[];
  createdTimeFilter?: CreatedTimeFilter;
  firstTouchFilter?: FirstTouchFilter;
  dealFilters?: DealFilter[];
}

export interface CommonDealWhere {
  /** Готовые условия, соединённые AND, БЕЗ ведущего AND; '' — фильтров нет. */
  sql: string;
  /** Bound-параметры (добавить к массиву параметров запроса после paramOffset занятых). */
  params: unknown[];
  /** Стабильный ключ для кэшей/React Query. */
  key: string;
}

export function buildCommonDealWhere(opts: CommonDealFilterOpts, paramOffset: number): CommonDealWhere {
  const parts: string[] = [];
  const params: unknown[] = [];

  const ct = opts.clientType ?? 'all';
  if (ct === 'b2c') parts.push('d.funnel_id IN (0, 2)');
  else if (ct === 'b2b') parts.push('d.funnel_id IN (1, 3)');

  const pg = buildProductGroupFilter(
    { productGroupMode: opts.productGroupMode, productGroupIds: opts.productGroupIds },
    paramOffset,
  );
  if (pg) { parts.push(pg.sql); params.push(...pg.params); }

  const ctw = createdTimeWhere('d', opts.createdTimeFilter);
  if (ctw) parts.push(ctw);
  const ftw = firstTouchWhere('d', opts.firstTouchFilter);
  if (ftw) parts.push(ftw);

  const df = buildDealFilterWhere(opts.dealFilters);
  if (df.sql) parts.push(df.sql);

  return {
    sql: parts.join(' AND '),
    params,
    key: [
      ct,
      opts.productGroupMode ?? 'kc',
      (opts.productGroupIds ?? []).join(','),
      opts.createdTimeFilter ?? 'all',
      opts.firstTouchFilter ?? 'all',
      df.key,
    ].join('|'),
  };
}
