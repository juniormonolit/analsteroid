// Фаза 0 движка диагностики (ТЗ №1 §12): проверки данных ПЕРЕД кодом. Каждая проверка —
// отдельный SQL к живым sa/va через analyticsDb() (YC analytics — мёртвая копия, не
// использовать), со своим try/catch и таймингом: упавшая проверка не валит остальные.
// Запускается супер-админом из браузера (вариант «В» владельца 10.09 — с рабочей
// машины SA-БД недоступна), результат уходит и в stdout прода с маркером [diag-checks],
// чтобы его можно было прочитать из app.log.
import { analyticsDb, systemDb } from '@/lib/db/clients';

export interface CheckResult {
  key: string;
  title: string;
  status: 'ok' | 'warn' | 'error';
  note: string;                 // вывод человеческим языком
  rows: Record<string, unknown>[];
  ms: number;
}

type Check = { key: string; title: string; run: () => Promise<Pick<CheckResult, 'status' | 'note' | 'rows'>> };

const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

async function sa<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await analyticsDb().connect();
  try {
    await client.query(`SET statement_timeout = '120s'`);
    return (await client.query<T>(sql, params)).rows;
  } finally { client.release(); }
}

const CHECKS: Check[] = [
  {
    key: 'timestamps', title: '12.1 Глубина таймстампов сделок и событий',
    async run() {
      const [d] = await sa<Record<string, string>>(`
        SELECT min(created_at)::date::text AS created_min, min(reserved_at)::date::text AS reserved_min, min(sold_at)::date::text AS sold_min,
               min(delivered_at)::date::text AS delivered_min, min(lost_at)::date::text AS lost_min,
               count(*)::text AS deals_total,
               count(*) FILTER (WHERE reserved_at < '2026-01-01')::text AS reserved_before_2026,
               count(*) FILTER (WHERE sold_at < '2026-01-01')::text AS sold_before_2026,
               count(*) FILTER (WHERE created_at >= now() - interval '90 days')::text AS created_90d,
               count(*) FILTER (WHERE (sold_at IS NOT NULL OR lost_at IS NOT NULL) AND coalesce(sold_at, lost_at) >= now() - interval '90 days')::text AS closed_90d
          FROM sa.deals`);
      const [e] = await sa<Record<string, string>>(`SELECT min(event_at)::date::text AS events_min, count(*)::text AS events_total, count(DISTINCT deal_id)::text AS deals_with_events FROM sa.deal_events`);
      const byMonth = await sa<Record<string, string>>(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, count(*)::text AS created,
               count(*) FILTER (WHERE reserved_at IS NOT NULL)::text AS reserved, count(*) FILTER (WHERE sold_at IS NOT NULL)::text AS sold
          FROM sa.deals WHERE created_at >= now() - interval '18 months' GROUP BY 1 ORDER BY 1`);
      const ok = n(d.reserved_before_2026) > 1000;
      return {
        status: ok ? 'ok' : 'warn',
        note: `Сделки с ${d.created_min}; reserved_at с ${d.reserved_min} (${d.reserved_before_2026} до 2026), sold_at с ${d.sold_min}. ` +
          `deal_events с ${e.events_min} (${e.events_total} событий, ${e.deals_with_events} сделок). Закрытых за 90 дн: ${d.closed_90d}. ` +
          (ok ? 'Триггер заполнил историю — own-база по таймстампам доступна сразу.' : 'Таймстампы только у свежих сделок — own-база на старте будет неполной.'),
        rows: [{ ...d, ...e }, ...byMonth],
      };
    },
  },
  {
    key: 'calls', title: '12.2 Звонки: глубина va.calls vs CALLS_DATA_START=30.03.2026',
    async run() {
      const rows = await sa<Record<string, string>>(`
        SELECT to_char(date_trunc('month', called_at), 'YYYY-MM') AS m, count(*)::text AS calls,
               count(*) FILTER (WHERE deal_id IS NOT NULL)::text AS with_deal, count(DISTINCT manager_id)::text AS managers
          FROM va.calls GROUP BY 1 ORDER BY 1`);
      const before = rows.filter(r => r.m < '2026-03');
      const linkedBefore = before.reduce((s, r) => s + n(r.with_deal), 0), allBefore = before.reduce((s, r) => s + n(r.calls), 0);
      return {
        status: 'ok',
        note: `Месяцев со звонками: ${rows.length} (${rows[0]?.m} … ${rows.at(-1)?.m}). До 03.2026: ${allBefore} звонков, из них со сделкой ${linkedBefore} (${pct(linkedBefore, allBefore)}%). ` +
          `Если доля со сделкой до марта сравнима с поздней — константу CALLS_DATA_START можно сдвинуть назад.`,
        rows,
      };
    },
  },
  {
    key: 'source', title: '12.3 Источник сделки: заполненность deals.source_id по месяцам',
    async run() {
      const rows = await sa<Record<string, string>>(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, count(*)::text AS deals,
               count(*) FILTER (WHERE source_id IS NOT NULL AND source_id <> '')::text AS with_source
          FROM sa.deals WHERE created_at >= now() - interval '12 months' GROUP BY 1 ORDER BY 1`);
      const top = await sa<Record<string, string>>(`
        SELECT coalesce(source_id, '∅') AS source_id, count(*)::text AS deals FROM sa.deals
         WHERE created_at >= now() - interval '3 months' GROUP BY 1 ORDER BY count(*) DESC LIMIT 25`);
      const last = rows.at(-1);
      return { status: last && pct(n(last.with_source), n(last.deals)) > 80 ? 'ok' : 'warn',
        note: `Заполненность source_id за последний месяц: ${last ? pct(n(last.with_source), n(last.deals)) : 0}%. Топ-25 значений за 3 мес — в строках (словарь: lib/marketing/sources.ts).`,
        rows: [...rows, ...top] };
    },
  },
  {
    key: 'leads', title: '12.4 Лиды: есть ли таблица лидов (дата, источник, оператор КЦ, исход)',
    async run() {
      const rows = await sa<Record<string, string>>(`
        SELECT table_schema, table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
          FROM information_schema.columns
         WHERE table_schema IN ('sa', 'va', 'public') AND (table_name ILIKE '%lead%' OR table_name ILIKE '%lid%' OR table_name ILIKE '%kc%' OR table_name ILIKE '%qualif%')
         GROUP BY 1, 2 ORDER BY 1, 2`);
      return { status: rows.length ? 'ok' : 'warn',
        note: rows.length ? `Найдено таблиц-кандидатов: ${rows.length}.` : 'Таблиц лидов в sa/va/public нет — субъекты «Источник» и «КЦ» откладываются, нужна интеграция лидов Битрикса.',
        rows };
    },
  },
  {
    key: 'loss_reasons', title: '12.5 Причины отказа: стадии LOSS по воронкам и распределение за 3 мес',
    async run() {
      const stages = await sa<Record<string, string>>(`
        SELECT s.funnel_id::text, f.name AS funnel, s.id AS stage_id, s.name AS stage, count(d.*)::text AS lost_3m
          FROM stages s JOIN funnels f ON f.id = s.funnel_id
          LEFT JOIN sa.deals d ON d.stage_id = s.id AND d.lost_at >= now() - interval '3 months'
         WHERE s.stage_type = 'LOSS' GROUP BY 1, 2, 3, 4 ORDER BY 1, count(d.*) DESC`);
      const total = stages.reduce((s, r) => s + n(r.lost_3m), 0);
      return { status: 'ok', note: `Стадий отказа: ${stages.length}; отказов за 3 мес: ${total}. Нужна разметка владельцем: «не целевой» (КЦ), «нет в наличии/сроки» (снабжение), «дорого» (коммерция).`, rows: stages };
    },
  },
  {
    key: 'handover', title: '12.6 Передачи сделок: доля сделок со сменой менеджера в deal_events (3 мес)',
    async run() {
      const rows = await sa<Record<string, string>>(`
        WITH recent AS (SELECT deal_id AS id, current_manager_id FROM sa.deals WHERE created_at >= now() - interval '3 months'),
        mgrs AS (SELECT e.deal_id, count(DISTINCT e.manager_id) AS n_mgr FROM sa.deal_events e JOIN recent r ON r.id = e.deal_id WHERE e.manager_id IS NOT NULL GROUP BY 1)
        SELECT coalesce(h.branch, '∅') AS branch, count(*)::text AS deals, count(*) FILTER (WHERE m.n_mgr > 1)::text AS handed_over
          FROM recent r LEFT JOIN mgrs m ON m.deal_id = r.id
          LEFT JOIN sa.org_resolved_hierarchy h ON h.manager_bitrix_user_id = r.current_manager_id::text
         GROUP BY 1 ORDER BY count(*) DESC`);
      const deals = rows.reduce((s, r) => s + n(r.deals), 0), ho = rows.reduce((s, r) => s + n(r.handed_over), 0);
      const share = pct(ho, deals);
      return { status: share > 10 ? 'warn' : 'ok', note: `Передано ${ho} из ${deals} (${share}%). ${share > 10 ? 'БОЛЬШЕ 10% — стоп, к владельцу (ТЗ §3.3).' : 'В норме: исключаем такие сделки из тиковых окон.'}`, rows };
    },
  },
  {
    key: 'zombie', title: '12.7 Кривая зомби: P(продажа | сделка ещё открыта в возрасте t) по топ-12 групп',
    async run() {
      // Закрытые за 6 мес сделки, дошедшие до брони: возраст закрытия от reserved_at.
      // P(sold | открыта в возрасте t) ≈ доля проданных среди закрытых в возрасте ≥ t.
      const rows = await sa<Record<string, string>>(`
        WITH closed AS (
          SELECT head_group_name, (sold_at IS NOT NULL) AS sold,
                 GREATEST(0, EXTRACT(epoch FROM (coalesce(sold_at, lost_at) - reserved_at)) / 86400)::int AS age
            FROM sa.deals
           WHERE reserved_at IS NOT NULL AND coalesce(sold_at, lost_at) >= now() - interval '6 months' AND coalesce(sold_at, lost_at) IS NOT NULL
        ),
        top AS (SELECT head_group_name FROM closed GROUP BY 1 ORDER BY count(*) DESC LIMIT 12),
        grid AS (SELECT t FROM generate_series(0, 60) t)
        SELECT c.head_group_name, g.t, count(*)::text AS n_open_at_t, count(*) FILTER (WHERE c.sold)::text AS n_sold,
               round(100.0 * count(*) FILTER (WHERE c.sold) / count(*), 1)::text AS p_sold_pct
          FROM closed c JOIN top USING (head_group_name) CROSS JOIN grid g
         WHERE c.age >= g.t
         GROUP BY 1, 2 HAVING count(*) >= 30 ORDER BY 1, 2`);
      // порог = первое t, где P ≤ 5%
      // Пороги для трёх отсечек — владелец 10.09: «может 10% или 15%? посчитай».
      const thr: Record<string, { p5: number | null; p10: number | null; p15: number | null; p0: number | null }> = {};
      for (const r of rows) {
        const g = String(r.head_group_name);
        const t = thr[g] ??= { p5: null, p10: null, p15: null, p0: null };
        const p = Number(r.p_sold_pct), day = Number(r.t);
        if (day === 0) t.p0 = p;
        if (t.p15 === null && p <= 15) t.p15 = day;
        if (t.p10 === null && p <= 10) t.p10 = day;
        if (t.p5 === null && p <= 5) t.p5 = day;
      }
      const summary = Object.entries(thr).map(([g, t]) => ({ head_group_name: g, p_sold_day0_pct: t.p0, zombie_at_15pct: t.p15 ?? '>60', zombie_at_10pct: t.p10 ?? '>60', zombie_at_5pct: t.p5 ?? '>60' }));
      return { status: 'ok', note: `Порог зомби по группам (день, когда P(продажа) падает до 15% / 10% / 5%): ${summary.map(s => `${s.head_group_name}: ${s.zombie_at_15pct} / ${s.zombie_at_10pct} / ${s.zombie_at_5pct}`).join('; ')}. Первые строки — сводка, дальше кривые (возраст от брони, дни, до 60).`, rows: [...summary, ...rows] };
    },
  },
  {
    key: 'zombie_early', title: '12.7б Зомби ДО брони: P(дойдёт до брони/продажи | ещё без брони в возрасте t) по топ-12 групп',
    async run() {
      // Кривая от брони (12.7) показала: забронированная сделка живёт долго и часто продаётся
      // поздно — там зомби почти нет. «Висяк» владельца — это сделки, застрявшие ДО брони:
      // созданы, но ни брони, ни продажи, ни отказа. Возраст — от created_at до первого из
      // reserved/sold/lost; ещё открытые старше 60 дней — цензурируем как «не продвинулись».
      const rows = await sa<Record<string, string>>(`
        WITH d AS (
          SELECT head_group_name,
                 (reserved_at IS NOT NULL OR sold_at IS NOT NULL) AS advanced,
                 LEAST(60, GREATEST(0, EXTRACT(epoch FROM (LEAST(coalesce(reserved_at, 'infinity'::timestamptz), coalesce(sold_at, 'infinity'::timestamptz), coalesce(lost_at, 'infinity'::timestamptz), now()) - created_at)) / 86400))::int AS age
            FROM sa.deals
           WHERE created_at >= now() - interval '6 months' AND created_at < now() - interval '60 days' AND funnel_id IN (0, 1, 2, 3)
        ),
        top AS (SELECT head_group_name FROM d GROUP BY 1 ORDER BY count(*) DESC LIMIT 12),
        grid AS (SELECT t FROM generate_series(0, 30) t)
        SELECT d.head_group_name, g.t, count(*)::text AS n_open_at_t, count(*) FILTER (WHERE d.advanced)::text AS n_advanced,
               round(100.0 * count(*) FILTER (WHERE d.advanced) / count(*), 1)::text AS p_advance_pct
          FROM d JOIN top USING (head_group_name) CROSS JOIN grid g
         WHERE d.age >= g.t
         GROUP BY 1, 2 HAVING count(*) >= 30 ORDER BY 1, 2`);
      const thr: Record<string, { p0: number | null; p15: number | null; p10: number | null; p5: number | null }> = {};
      for (const r of rows) {
        const g = String(r.head_group_name); const t = thr[g] ??= { p0: null, p15: null, p10: null, p5: null };
        const p = Number(r.p_advance_pct), day = Number(r.t);
        if (day === 0) t.p0 = p;
        if (t.p15 === null && p <= 15) t.p15 = day;
        if (t.p10 === null && p <= 10) t.p10 = day;
        if (t.p5 === null && p <= 5) t.p5 = day;
      }
      const summary = Object.entries(thr).map(([g, t]) => ({ head_group_name: g, p_advance_day0_pct: t.p0, zombie_at_15pct: t.p15 ?? '>30', zombie_at_10pct: t.p10 ?? '>30', zombie_at_5pct: t.p5 ?? '>30' }));
      return { status: 'ok', note: `День, когда P(сделка без брони ещё продвинется) падает до 15% / 10% / 5%: ${summary.map(x => `${x.head_group_name}: ${x.zombie_at_15pct} / ${x.zombie_at_10pct} / ${x.zombie_at_5pct}`).join('; ')}.`, rows: [...summary, ...rows] };
    },
  },
  {
    key: 'calls_linked', title: '12.2б Звонки: доля звонков, чей deal_id реально есть в sa.deals (по месяцам)',
    async run() {
      const rows = await sa<Record<string, string>>(`
        SELECT to_char(date_trunc('month', c.called_at), 'YYYY-MM') AS m, count(*)::text AS calls,
               count(d.deal_id)::text AS linked_to_existing_deal, round(100.0 * count(d.deal_id) / count(*), 1)::text AS linked_pct
          FROM va.calls c LEFT JOIN sa.deals d ON d.deal_id = c.deal_id
         GROUP BY 1 ORDER BY 1`);
      return { status: 'ok', note: 'Если доля привязанных к реальным сделкам до 03.2026 не хуже поздней — CALLS_DATA_START можно сдвинуть на 01.2025.', rows };
    },
  },
  {
    key: 'diag_tables', title: '12.8 Существующие таблицы diag_* / bot_scenario_* в system',
    async run() {
      const rows = (await systemDb().query<Record<string, string>>(`
        SELECT table_name, (SELECT count(*) FROM information_schema.columns c WHERE c.table_name = t.table_name)::text AS columns
          FROM information_schema.tables t WHERE table_schema = 'public' AND (table_name LIKE 'diag_%' OR table_name LIKE 'bot_scenario%') ORDER BY 1`)).rows;
      const diag = rows.filter(r => r.table_name.startsWith('diag_'));
      return { status: diag.length ? 'warn' : 'ok', note: diag.length ? `Уже есть diag_*: ${diag.map(r => r.table_name).join(', ')} — проверить конфликт.` : 'diag_* нет — создаём с нуля (миграция 206+). bot_scenario_* — рабочая v1, не трогаем.', rows };
    },
  },
  {
    key: 'catalog', title: '12.9 Каталог: метрики дерева (есть / неактивны / нет)',
    async run() {
      const want = ['cr_deal_to_sale', 'cr_reservation_to_sale', 'cr_confirmed_to_sale', 'cr_sale_to_shipment', 'cr_deal_to_price', 'cr_stage_priced_to_reservation',
        'cr_deal_to_reservation', 'cr_reservation_to_confirmed', 'cr_repeat_created_to_sale', 'booking_call_rate_reserved', 'calls_touch_speed_median',
        'price_speed_median_hours', 'calls_deals_no_call', 'calls_to_reservation_avg', 'calls_silence_deals', 'calls_missed_rate', 'avg_groups_per_order',
        'primary_deals_count', 'repeat_created_count', 'primary_shipments_count', 'primary_shipments_amount', 'primary_shipments_avg_amount',
        'repeat_shipments_count', 'repeat_shipments_amount', 'repeat_shipments_avg_amount', 'zombie_share', 'multi_group_order_share', 'advice_contact_rate'];
      const { ycAnalyticsDb } = await import('@/lib/db/clients');
      const r = await ycAnalyticsDb().query<Record<string, string>>(`SELECT id, name_ru, metric_type, is_active::text, is_hidden_in_ui::text FROM metrics WHERE id = ANY($1)`, [want]);
      const have = new Map(r.rows.map(x => [x.id, x]));
      const rows = want.map(id => { const x = have.get(id); return { id, found: x ? 'да' : 'НЕТ', name: x?.name_ru ?? '', type: x?.metric_type ?? '', active: x ? (x.is_active === 'true' ? 'да' : 'НЕАКТИВНА') : '' }; });
      const missing = rows.filter(x => x.found === 'НЕТ').map(x => x.id), inactive = rows.filter(x => x.active === 'НЕАКТИВНА').map(x => x.id);
      return { status: missing.length ? 'warn' : 'ok', note: `Нет в каталоге: ${missing.join(', ') || '—'}. Неактивны: ${inactive.join(', ') || '—'} (узнать причину до сида дерева).`, rows };
    },
  },
  {
    key: 'attribution', title: '12.10 Атрибуция: конверсия сделка→бронь по «менеджеру первого события» vs current_manager_id (3 мес)',
    async run() {
      const rows = await sa<Record<string, string>>(`
        WITH recent AS (
          SELECT d.deal_id AS id, d.current_manager_id::text AS cur_mgr, (d.reserved_at IS NOT NULL) AS reserved FROM sa.deals d WHERE d.created_at >= now() - interval '3 months' AND d.created_at < now() - interval '14 days'
        ),
        first_ev AS (SELECT DISTINCT ON (e.deal_id) e.deal_id, e.manager_id::text AS first_mgr FROM sa.deal_events e JOIN recent r ON r.id = e.deal_id ORDER BY e.deal_id, e.event_at),
        j AS (SELECT r.*, f.first_mgr FROM recent r LEFT JOIN first_ev f ON f.deal_id = r.id),
        by_cur AS (SELECT cur_mgr AS mgr, count(*) AS n, avg(reserved::int) AS cr FROM j GROUP BY 1),
        by_first AS (SELECT first_mgr AS mgr, count(*) AS n, avg(reserved::int) AS cr FROM j WHERE first_mgr IS NOT NULL GROUP BY 1)
        SELECT coalesce(c.mgr, f.mgr) AS manager_id, h.manager_name, c.n::text AS deals_cur, f.n::text AS deals_first,
               round(100 * c.cr, 1)::text AS cr_cur_pct, round(100 * f.cr, 1)::text AS cr_first_pct, round(100 * (c.cr - f.cr), 1)::text AS diff_pp
          FROM by_cur c FULL JOIN by_first f ON f.mgr = c.mgr
          LEFT JOIN sa.org_resolved_hierarchy h ON h.manager_bitrix_user_id = coalesce(c.mgr, f.mgr)
         WHERE coalesce(c.n, 0) + coalesce(f.n, 0) >= 30
         ORDER BY abs(coalesce(c.cr, 0) - coalesce(f.cr, 0)) DESC`);
      const big = rows.filter(r => Math.abs(Number(r.diff_pp)) > 5).length;
      return { status: big > rows.length * 0.2 ? 'warn' : 'ok', note: `Менеджеров с расхождением > 5 п.п.: ${big} из ${rows.length}. ${big > rows.length * 0.2 ? 'Заметная доля — правка stageConversions.ts согласуется отдельно.' : 'Расхождение локальное.'}`, rows };
    },
  },
  {
    key: 'plans', title: 'Доп.: менеджеры без плана в manager_plans на текущий месяц',
    async run() {
      const active = await sa<Record<string, string>>(`SELECT short_login, manager_name, branch FROM sa.org_resolved_hierarchy WHERE is_active = true`);
      const plans = (await systemDb().query<{ manager_login: string }>(`SELECT manager_login FROM manager_plans WHERE month = date_trunc('month', now())::date`)).rows;
      const set = new Set(plans.map(p => p.manager_login));
      const without = active.filter(a => !set.has(String(a.short_login)));
      return { status: 'ok', note: `Активных в оргструктуре: ${active.length}, с планом на месяц: ${plans.length}, без плана: ${without.length}. По ТЗ у них корень не считается (no_plan), тиковые листья работают.`, rows: without.slice(0, 200) };
    },
  },
  {
    key: 'closed_volume', title: 'Доп.: сколько закрытых сделок в месяц у менеджера (для окна «100 закрытых»)',
    async run() {
      const rows = await sa<Record<string, string>>(`
        WITH c AS (
          SELECT current_manager_id::text AS mgr, count(*) / 3.0 AS closed_per_month
            FROM sa.deals WHERE coalesce(sold_at, lost_at) >= now() - interval '3 months' AND (sold_at IS NOT NULL OR lost_at IS NOT NULL)
           GROUP BY 1
        )
        SELECT CASE WHEN closed_per_month < 10 THEN '< 10' WHEN closed_per_month < 30 THEN '10–30' WHEN closed_per_month < 60 THEN '30–60' WHEN closed_per_month < 100 THEN '60–100' ELSE '100+' END AS closed_per_month_bucket,
               count(*)::text AS managers
          FROM c JOIN sa.org_resolved_hierarchy h ON h.manager_bitrix_user_id = c.mgr AND h.is_active
         GROUP BY 1 ORDER BY min(closed_per_month)`);
      return { status: 'ok', note: 'Окно «100 закрытых» набирается за месяц у корзин 100+, за ~2 мес у 60–100, за 3–10 мес у остальных.', rows };
    },
  },
];

export async function runChecks(only?: string[], ranBy?: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const c of CHECKS) {
    if (only && !only.includes(c.key)) continue;
    const t0 = Date.now();
    try {
      const r = await c.run();
      out.push({ key: c.key, title: c.title, ...r, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ key: c.key, title: c.title, status: 'error', note: e instanceof Error ? e.message : String(e), rows: [], ms: Date.now() - t0 });
    }
    const r = out[out.length - 1];
    await systemDb().query(
      `INSERT INTO diag_check_runs (key, status, note, rows, ms, ran_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.key, r.status, r.note, JSON.stringify(r.rows.slice(0, 2000)), r.ms, ranBy ?? null],
    ).catch(err => console.warn('[diag-checks] не записан в diag_check_runs:', err instanceof Error ? err.message : err));
  }
  return out;
}

/** Последний результат каждой проверки — для экрана при повторном открытии. */
export async function lastCheckResults(): Promise<CheckResult[]> {
  const r = await systemDb().query<{ key: string; status: CheckResult['status']; note: string; rows: Record<string, unknown>[]; ms: number; ran_at: string | Date }>(
    `SELECT DISTINCT ON (key) key, status, note, rows, ms, ran_at FROM diag_check_runs ORDER BY key, ran_at DESC`);
  const titles = new Map(CHECKS.map(c => [c.key, c.title]));
  return r.rows.map(x => ({ key: x.key, title: titles.get(x.key) ?? x.key, status: x.status, note: `${x.note} (прогон ${new Date(x.ran_at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })})`, rows: x.rows, ms: x.ms }));
}

export const CHECK_KEYS = CHECKS.map(c => ({ key: c.key, title: c.title }));
