// Общий словарь клиентского дрилла — БЕЗ серверных импортов (ни pg, ни redis):
// его импортирует и движок (clientDrilldown.ts, сервер), и DrilldownDrawer.tsx
// ('use client'). Урок сборки 17.08: UI импортировал список прямо из движка, и
// Turbopack потащил pg/ioredis в браузерный бандл — build падал «Can't resolve dns».

// Копия LTV_WINDOWS_DAYS из clientMetrics.ts (тот файл серверный — импортировать
// отсюда нельзя). Меняются вместе: окна метрик cohort_repeat_revenue_*.
const LTV_WINDOWS = [30, 60, 90, 180, 360] as const;

// Правила населения дрилла по метрике. rnCond — какие отгрузки клиента берём
// (порядковый номер в его истории), windowDays — окно когорты от первой отгрузки.
// compare — с чем ячейку метрики сверяет «Разбор метрики» (MetricBreakdownModal):
// число заказчиков населения, число их сделок или сумма. Задаётся ЯВНО и только
// у сумм/счётчиков; у средних, медиан, долей и коэффициентов поля нет — их
// ячейка с итогом населения несравнима, и разбор так и пишет (ревью 03.09:
// угадывание единицы по id — regex /clients?/ — сверяло group_buyers_count,
// счётчик ЗАКАЗЧИКОВ, с числом сделок; client_ltv (медиана) — с суммой).
export type ClientDrillCompare = 'customers' | 'deals' | 'amount';
export type ClientDrillRule =
  | { kind: 'base'; rnCond?: string; complexOnly?: boolean; compare?: ClientDrillCompare }
  | { kind: 'cohort'; windowDays?: number; firstOnly?: boolean;
      // allClients — вся когорта, не только повторные (cohort_clients, #4996);
      // returnedOnly — повторные, у кого ВТОРАЯ отгрузка уложилась в окно
      // (население «% вернувшихся N дн»: 2+ отгрузки именно внутри окна).
      allClients?: boolean; returnedOnly?: boolean; compare?: ClientDrillCompare };

export const CLIENT_DRILL_RULES: Record<string, ClientDrillRule> = {
  all_clients_delivered:    { kind: 'base', compare: 'customers' },
  delivered_deals_count:    { kind: 'base', compare: 'deals' },
  group_buyers_count:       { kind: 'base', compare: 'customers' },
  new_clients_count:        { kind: 'base', rnCond: '= 1', compare: 'customers' },
  new_clients_amount:       { kind: 'base', rnCond: '= 1', compare: 'amount' },
  repeat_clients_delivered: { kind: 'base', rnCond: '>= 2', compare: 'customers' },
  repeat_clients_amount:    { kind: 'base', rnCond: '>= 2', compare: 'amount' },
  repeat_rate_clients:      { kind: 'base', rnCond: '>= 2' },
  first_repeat_clients:     { kind: 'base', rnCond: '= 2', compare: 'customers' },
  complex_clients:          { kind: 'base', complexOnly: true, compare: 'customers' },
  cohort_repeat_clients:    { kind: 'cohort', compare: 'customers' },
  cohort_first_revenue:     { kind: 'cohort', firstOnly: true, compare: 'amount' },
  cohort_ltv_total_revenue: { kind: 'cohort', compare: 'amount' },
  ...Object.fromEntries(LTV_WINDOWS.map(w => [
    `cohort_repeat_revenue_${w}`, { kind: 'cohort', windowDays: w, compare: 'amount' } as ClientDrillRule,
  ])),
  // #4994: коэффициент = всё/первый заказ — население то же, что у LTV за всё время.
  cohort_repeat_ratio:      { kind: 'cohort' },
  // Средние LTV (на повторного клиента) — то же население, что их суммы.
  cohort_ltv_total:         { kind: 'cohort' },
  ...Object.fromEntries(LTV_WINDOWS.map(w => [
    `cohort_ltv_${w}`, { kind: 'cohort', windowDays: w } as ClientDrillRule,
  ])),
  // #4996: «Клиентов» — ВСЯ когорта; «% вернувшихся N дн» — вернувшиеся в окне.
  cohort_clients:           { kind: 'cohort', allClients: true, compare: 'customers' },
  cohort_return_rate_total: { kind: 'cohort' },
  ...Object.fromEntries(LTV_WINDOWS.map(w => [
    `cohort_return_rate_${w}`, { kind: 'cohort', windowDays: w, returnedOnly: true } as ClientDrillRule,
  ])),
};

export const CLIENT_DRILL_METRIC_IDS = Object.keys(CLIENT_DRILL_RULES);

// ВСЯ клиентская семья (копия списков clientMetrics.ts — тот файл серверный,
// импортировать нельзя; меняются вместе). Нужна дриллу, чтобы клик по метрике,
// у которой НЕТ точного правила населения (медианы, средние, доли, снимки,
// обзвон), всё равно открывал заказчиков — с населением «все отгрузки периода»
// (баг-репорт владельца 17.08: «дрилл на заказчиков в повторных поломался —
// там сделки, сгруппированные в товарные группы или менеджеров» — такие метрики
// проваливались в мини-отчёт, бесполезный для клиентских чисел).
export const CLIENT_FAMILY_METRIC_IDS: string[] = [
  ...CLIENT_DRILL_METRIC_IDS,
  'avg_groups_per_client', 'avg_groups_per_order', 'avg_products_per_order',
  'median_time_to_2nd', 'median_time_between_orders',
  'median_time_to_2nd_diff_cat', 'median_time_between_orders_diff_cat',
  'followup_clients_due', 'followup_clients_called',
  'median_cycle_time_days', 'median_client_lifetime_months',
  'active_clients_90d', 'client_share_count_pct', 'client_share_amount_pct',
  'client_days_since_last', 'client_order_frequency_days', 'client_ltv',
  'client_categories_count', 'client_churn_risk_pct',
  // Проценты/средние без точного населения — фолбэк «все отгрузки периода».
  // Пропущены при первичной сборке словаря (баг-репорт владельца 24.08: клик по
  // ним отвечал 400, а UI показывал «Нет заказчиков»).
  'complex_clients_pct', 'repeat_amount_share', 'contactability_pct', 'avg_orders_per_client',
];

/** Метрика дрилла с фолбэком: без точного правила — «все отгрузки клиентов периода». */
export const CLIENT_DRILL_FALLBACK_ID = 'all_clients_delivered';
