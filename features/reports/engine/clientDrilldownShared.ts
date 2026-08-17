// Общий словарь клиентского дрилла — БЕЗ серверных импортов (ни pg, ни redis):
// его импортирует и движок (clientDrilldown.ts, сервер), и DrilldownDrawer.tsx
// ('use client'). Урок сборки 17.08: UI импортировал список прямо из движка, и
// Turbopack потащил pg/ioredis в браузерный бандл — build падал «Can't resolve dns».

// Копия LTV_WINDOWS_DAYS из clientMetrics.ts (тот файл серверный — импортировать
// отсюда нельзя). Меняются вместе: окна метрик cohort_repeat_revenue_*.
const LTV_WINDOWS = [30, 60, 90, 180, 360] as const;

// Правила населения дрилла по метрике. rnCond — какие отгрузки клиента берём
// (порядковый номер в его истории), windowDays — окно когорты от первой отгрузки.
export type ClientDrillRule =
  | { kind: 'base'; rnCond?: string; complexOnly?: boolean }
  | { kind: 'cohort'; windowDays?: number; firstOnly?: boolean };

export const CLIENT_DRILL_RULES: Record<string, ClientDrillRule> = {
  all_clients_delivered:    { kind: 'base' },
  delivered_deals_count:    { kind: 'base' },
  group_buyers_count:       { kind: 'base' },
  new_clients_count:        { kind: 'base', rnCond: '= 1' },
  new_clients_amount:       { kind: 'base', rnCond: '= 1' },
  repeat_clients_delivered: { kind: 'base', rnCond: '>= 2' },
  repeat_clients_amount:    { kind: 'base', rnCond: '>= 2' },
  repeat_rate_clients:      { kind: 'base', rnCond: '>= 2' },
  first_repeat_clients:     { kind: 'base', rnCond: '= 2' },
  complex_clients:          { kind: 'base', complexOnly: true },
  cohort_repeat_clients:    { kind: 'cohort' },
  cohort_first_revenue:     { kind: 'cohort', firstOnly: true },
  cohort_ltv_total_revenue: { kind: 'cohort' },
  ...Object.fromEntries(LTV_WINDOWS.map(w => [
    `cohort_repeat_revenue_${w}`, { kind: 'cohort', windowDays: w } as ClientDrillRule,
  ])),
};

export const CLIENT_DRILL_METRIC_IDS = Object.keys(CLIENT_DRILL_RULES);
