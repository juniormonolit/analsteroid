import Link from 'next/link';
import { systemDb } from '@/lib/db/clients';
import { SECTION_SQL } from '@/lib/activity/section';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';

// «Большой брат» → «Обзор»: что происходит в Монолитике за период (сегодня / 7 / 30 дней, МСК) — люди, активное
// время, разделы, откуда заходят, действия в сервисах и блок «Отчёты» (доработка 26.11, владелец: «кто какие отчёты
// смотрит и насколько активно»): по отчёту — просмотры, люди, минуты, смены параметров, расшифровки, экспорт; по клику —
// кто смотрит; обратный разрез — по человеку. Источник — activity_events / activity_minutes (миграция 296).
// До 26.11 отчёты писались разделом 'sales' (путь в payload.path) — SECTION_SQL достаёт отчёт оттуда; их минуты
// по отчётам не разбить — они идут строкой «Отчёты (без уточнения)». Гейт — в layout.tsx.
export const dynamic = 'force-dynamic';

const PERIODS = [
  { key: 'today', label: 'Сегодня', days: 1 },
  { key: '7', label: '7 дней', days: 7 },
  { key: '30', label: '30 дней', days: 30 },
] as const;

const SECTION_LABELS: Record<string, string> = {
  home: 'Главная (стартовая)', profile: 'Личный кабинет', manager: 'Карточка менеджера', tasker: 'Задачник',
  'repeat-kanban': 'Канбан повторных', 'big-deals-kanban': 'Канбан больших чеков', 'logist-kanban': 'Канбан логиста',
  'logist-requests': 'Запросы логистам', 'rop-kanban': 'Канбан РОПа', sales: 'Отчёты (без уточнения)', today: 'Сегодня',
  rating: 'Рейтинг', summary: 'Сводная', plans: 'Планы', decomposition: 'Декомпозиция', 'ssp-test': 'ССП: план и факт',
  'dashboard-test': 'Дашборд', 'big-brother': 'Большой брат', settings: 'Настройки', 'metric-map': 'Карта показателей',
  metrics: 'Метрики', charts: 'Графики', chats: 'Чаты', 'cross-sell': 'Что предложить', dismissal: 'Увольнятор',
  employees: 'Сотрудники', map: 'Карта объектов', marketing: 'Маркетинг', 'marketing-sources': 'Источники',
  modules: 'Модули', offload: 'Разгрузка отделов', presentation: 'Презентация', screens: 'Телевизоры',
  'widget-constructor': 'Виджеты', 'year-weekly': 'Данные по годам', realizations: 'Реализация',
  'ai-analysis': 'ИИ-анализ', diagnostics: 'Диагностика', login: 'Вход',
  'bx/manager': 'Битрикс: личный кабинет', 'bx/deal-requests': 'Битрикс: запросы логисту',
};
const REPORT_LABELS: Record<string, string> = {
  'sales/by-managers': 'По менеджерам', 'sales/by-product-groups': 'По товарным группам', 'sales/by-periods': 'По периодам',
  'sales/by-clients': 'По клиентам', 'sales/client-tail': 'Вход и хвост', 'sales/product-matrix': 'Товарная матрица',
  'sales/transition-matrix': 'Матрица переходов', 'sales/repeat': 'Повторные', 'sales/unsell-deal': 'Снять с продажи',
  'realizations/responses': 'Реализация: ответы на запросы', 'realizations/requests': 'Реализация: заявки',
  'realizations/logists': 'Реализация: сводка по логистам', 'realizations/regions': 'Реализация: регионы',
};
const SURFACE_LABELS: Record<string, string> = {
  web: 'Браузер (десктоп)', mobile: 'Браузер (телефон)', pwa: 'Приложение (PWA)', bx_iframe: 'Внутри Битрикса', server: 'Сервер',
};
const SERVICE_LABELS: Record<string, string> = { tasker: 'Задачник', big_deals: 'Канбан больших', logist: 'Канбан логиста' };

const REPORT_RE = `'^(sales/|marketing/|realizations/)'`;

type Agg = { views: number; days: number; loads: number; drills: number; exports: number; minutes: number; last: string | null };
type Cell = Agg & { sec: string; who: string };
type Overview = {
  events: number; views: number; actions: number; logins: number; users: number; minutes: number;
  sections: { section: string; views: number; minutes: number; users: number }[];
  surfaces: { surface: string; users: number; minutes: number }[];
  services: { section: string; actions: number; users: number }[];
  cells: Cell[];
  savedNames: Map<string, string>;
  people: Map<string, string>;
};

async function load(days: number): Promise<Overview> {
  const db = systemDb();
  const since = `(date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow') - make_interval(days => ${days - 1})`;
  const [tot, sec, surf, svc, rep] = await Promise.all([
    db.query<{ events: string; views: string; actions: string; logins: string; users: string; minutes: string }>(
      `WITH e AS (SELECT kind, action, COALESCE(bitrix_user_id, 'u:' || user_id) AS who FROM activity_events WHERE ts >= ${since}),
            m AS (SELECT bitrix_user_id AS who, bucket FROM activity_minutes WHERE bucket >= ${since} AND source = 'mono')
       SELECT (SELECT count(*) FROM e) AS events,
              (SELECT count(*) FROM e WHERE kind = 'mono_view') AS views,
              (SELECT count(*) FROM e WHERE kind = 'mono_action') AS actions,
              (SELECT count(*) FROM e WHERE kind = 'session' AND action = 'login') AS logins,
              (SELECT count(*) FROM (SELECT who FROM e UNION SELECT who FROM m) x) AS users,
              (SELECT count(*) FROM (SELECT DISTINCT who, bucket FROM m) x) * 5 AS minutes`),
    db.query<{ section: string; views: string; minutes: string; users: string }>(
      `WITH v AS (SELECT ${SECTION_SQL} AS section, count(*) AS views, count(DISTINCT COALESCE(bitrix_user_id, user_id::text)) AS users
                    FROM activity_events WHERE ts >= ${since} AND kind = 'mono_view' GROUP BY 1),
            m AS (SELECT section, count(*) * 5 AS minutes FROM activity_minutes
                   WHERE bucket >= ${since} AND source = 'mono' GROUP BY section)
       SELECT COALESCE(v.section, m.section) AS section, COALESCE(v.views, 0) AS views,
              COALESCE(m.minutes, 0) AS minutes, COALESCE(v.users, 0) AS users
         FROM v FULL JOIN m ON m.section = v.section
        ORDER BY COALESCE(m.minutes, 0) DESC, COALESCE(v.views, 0) DESC LIMIT 15`),
    db.query<{ surface: string; users: string; minutes: string }>(
      `SELECT surface, count(DISTINCT bitrix_user_id) AS users, count(*) * 5 AS minutes
         FROM activity_minutes WHERE bucket >= ${since} AND source = 'mono' GROUP BY surface ORDER BY 3 DESC`),
    db.query<{ section: string; actions: string; users: string }>(
      `SELECT section, count(*) AS actions, count(DISTINCT COALESCE(bitrix_user_id, user_id::text)) AS users
         FROM activity_events WHERE ts >= ${since} AND kind = 'mono_action' AND section IN ('tasker', 'big_deals', 'logist')
        GROUP BY section ORDER BY 2 DESC`),
    // Отчёты: ячейка (отчёт × человек). Ключ человека — как в activity_minutes (Битрикс-id или 'u:<users.id>').
    db.query<{ sec: string; who: string; views: string; days: string; loads: string; drills: string; exports: string; minutes: string; last: Date | null }>(
      `WITH e AS (
         SELECT ${SECTION_SQL} AS sec, COALESCE(bitrix_user_id, 'u:' || user_id) AS who, kind, action, ts
           FROM activity_events
          WHERE ts >= ${since} AND kind IN ('mono_view', 'mono_action') AND section ~ '^(sales|marketing|realizations)'),
       ea AS (
         SELECT sec, who,
                count(*) FILTER (WHERE kind = 'mono_view') AS views,
                count(DISTINCT (ts AT TIME ZONE 'Europe/Moscow')::date) AS days,
                count(*) FILTER (WHERE action = 'report_load') AS loads,
                count(*) FILTER (WHERE action = 'report_drill') AS drills,
                count(*) FILTER (WHERE action = 'report_export') AS exports,
                max(ts) AS last
           FROM e WHERE sec ~ ${REPORT_RE} OR sec = 'sales' GROUP BY 1, 2),
       ma AS (
         SELECT section AS sec, bitrix_user_id AS who, count(*) * 5 AS minutes, max(bucket) AS last
           FROM activity_minutes
          WHERE bucket >= ${since} AND source = 'mono' AND (section ~ ${REPORT_RE} OR section = 'sales') GROUP BY 1, 2)
       SELECT COALESCE(ea.sec, ma.sec) AS sec, COALESCE(ea.who, ma.who) AS who,
              COALESCE(ea.views, 0) AS views, COALESCE(ea.days, 0) AS days, COALESCE(ea.loads, 0) AS loads,
              COALESCE(ea.drills, 0) AS drills, COALESCE(ea.exports, 0) AS exports, COALESCE(ma.minutes, 0) AS minutes,
              GREATEST(ea.last, ma.last) AS last
         FROM ea FULL JOIN ma ON ma.sec = ea.sec AND ma.who = ea.who
        WHERE COALESCE(ea.sec, ma.sec) <> 'sales/unsell-deal'`),
  ]);
  const t = tot.rows[0];
  const cells: Cell[] = rep.rows.map(r => ({
    sec: r.sec, who: r.who, views: +r.views, days: +r.days, loads: +r.loads, drills: +r.drills, exports: +r.exports,
    minutes: +r.minutes, last: r.last ? new Date(r.last).toISOString() : null,
  }));

  // Имена: сохранённые отчёты и люди.
  const savedIds = [...new Set(cells.map(c => c.sec.match(/^sales\/saved\/(.+)$/)?.[1]).filter((x): x is string => !!x && /^[0-9a-f-]{36}$/i.test(x)))];
  const bxIds = [...new Set(cells.map(c => c.who).filter(w => !w.startsWith('u:')))];
  const userIds = [...new Set(cells.map(c => c.who).filter(w => w.startsWith('u:')).map(w => w.slice(2)))];
  const [saved, ppl] = await Promise.all([
    savedIds.length
      ? db.query<{ id: string; name: string }>(`SELECT id::text, name FROM saved_reports WHERE id::text = ANY($1)`, [savedIds])
      : Promise.resolve({ rows: [] as { id: string; name: string }[] }),
    bxIds.length || userIds.length
      ? db.query<{ bx: string | null; id: string; name: string }>(
        `SELECT bitrix_user_id AS bx, id::text, COALESCE(NULLIF(display_name, ''), login) AS name FROM users
          WHERE bitrix_user_id = ANY($1) OR id::text = ANY($2)`, [bxIds, userIds])
      : Promise.resolve({ rows: [] as { bx: string | null; id: string; name: string }[] }),
  ]);
  const people = new Map<string, string>();
  for (const p of ppl.rows) { if (p.bx) people.set(p.bx, p.name); people.set(`u:${p.id}`, p.name); }

  return {
    events: +t.events, views: +t.views, actions: +t.actions, logins: +t.logins, users: +t.users, minutes: +t.minutes,
    sections: sec.rows.map(r => ({ section: r.section, views: +r.views, minutes: +r.minutes, users: +r.users })),
    surfaces: surf.rows.map(r => ({ surface: r.surface, users: +r.users, minutes: +r.minutes })),
    services: svc.rows.map(r => ({ section: r.section, actions: +r.actions, users: +r.users })),
    cells,
    savedNames: new Map(saved.rows.map(r => [`sales/saved/${r.id}`, r.name])),
    people,
  };
}

function reportLabel(sec: string, saved: Map<string, string>): string {
  if (saved.has(sec)) return saved.get(sec)!;
  if (sec.startsWith('sales/saved/')) return 'Сохранённый отчёт (удалён)';
  if (REPORT_LABELS[sec]) return REPORT_LABELS[sec];
  if (sec.startsWith('marketing/')) { const p = MARKETING_PRESETS[sec.slice(10)]; return `Маркетинг: ${p?.title ?? sec.slice(10)}`; }
  return SECTION_LABELS[sec] ?? sec;
}
function sectionLabel(sec: string, saved: Map<string, string>): string {
  return sec.includes('/') && !sec.startsWith('bx/') ? reportLabel(sec, saved) : SECTION_LABELS[sec] ?? sec;
}

const sum = (xs: Agg[]): Agg => xs.reduce<Agg>((a, x) => ({
  views: a.views + x.views, days: Math.max(a.days, x.days), loads: a.loads + x.loads, drills: a.drills + x.drills,
  exports: a.exports + x.exports, minutes: a.minutes + x.minutes, last: !a.last || (x.last && x.last > a.last) ? x.last : a.last,
}), { views: 0, days: 0, loads: 0, drills: 0, exports: 0, minutes: 0, last: null });

function group<K>(cells: Cell[], key: (c: Cell) => K): Map<K, Cell[]> {
  const m = new Map<K, Cell[]>();
  for (const c of cells) { const k = key(c); m.set(k, [...(m.get(k) ?? []), c]); }
  return m;
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim() : `${m} мин`);
const fmtWhen = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');
const CARD = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]';
const TH = 'px-3 py-2 text-left font-medium text-[var(--color-text-secondary)] whitespace-nowrap';
const TD = 'px-3 py-2 text-[var(--color-text)]';
const NUM = `${TD} text-right tabular-nums whitespace-nowrap`;
const MUTED = 'text-xs text-[var(--color-text-secondary)]';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${CARD} min-w-0 p-3`}>
      <div className={MUTED}>{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
      {hint && <div className={MUTED}>{hint}</div>}
    </div>
  );
}

/** Строка-сводка раскрывающегося блока: название + цифры, на телефоне цифры переносятся под название. */
function Stats({ a, people }: { a: Agg; people?: number }) {
  const items: [string, string][] = [
    ['просм.', String(a.views)], ...(people != null ? [['чел.', String(people)] as [string, string]] : []),
    ['время', fmtMin(a.minutes)], ['загрузок', String(a.loads)], ['расшифр.', String(a.drills)], ['экспорт', String(a.exports)],
  ];
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--color-text-secondary)]">
      {items.map(([l, v]) => <span key={l} className="whitespace-nowrap"><b className="font-semibold tabular-nums text-[var(--color-text)]">{v}</b> {l}</span>)}
    </span>
  );
}

function DetailTable({ head, rows }: { head: string; rows: { key: string; name: string; a: Agg }[] }) {
  return (
    <div className="scroll-x">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr>
            <th className={TH}>{head}</th><th className={`${TH} text-right`}>Просмотры</th><th className={`${TH} text-right`}>Дней</th>
            <th className={`${TH} text-right`}>Время</th><th className={`${TH} text-right`}>Загрузки</th>
            <th className={`${TH} text-right`}>Экспорт</th><th className={`${TH} text-right`}>Последний заход</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className="border-t border-[var(--color-border)]">
              <td className={TD}>{r.name}</td>
              <td className={NUM}>{r.a.views}</td><td className={NUM}>{r.a.days}</td><td className={NUM}>{fmtMin(r.a.minutes)}</td>
              <td className={NUM}>{r.a.loads + r.a.drills}</td><td className={NUM}>{r.a.exports}</td><td className={NUM}>{fmtWhen(r.a.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const byWeight = (a: Agg, b: Agg) => b.minutes - a.minutes || b.views - a.views || b.loads - a.loads;

export default async function BigBrotherOverview({ searchParams }: { searchParams: Promise<{ d?: string }> }) {
  const { d: dRaw } = await searchParams;
  const period = PERIODS.find(p => p.key === dRaw) ?? PERIODS[0];
  let d: Overview;
  try {
    d = await load(period.days);
  } catch (err) {
    console.error('[big-brother] обзор:', err instanceof Error ? err.message : err);
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">
        Журнал активности ещё не подключён (нет таблиц миграции 296) или база недоступна.
      </p>
    );
  }

  const name = (who: string) => d.people.get(who) ?? (who.startsWith('u:') ? 'Без Битрикс-id' : `Битрикс #${who}`);
  const reports = [...group(d.cells, c => c.sec)].map(([sec, cs]) => ({
    sec, label: reportLabel(sec, d.savedNames), a: sum(cs), people: new Set(cs.map(c => c.who)).size,
    rows: cs.map(c => ({ key: c.who, name: name(c.who), a: c as Agg })).sort((x, y) => byWeight(x.a, y.a)),
  })).sort((x, y) => byWeight(x.a, y.a)).slice(0, 50);
  const persons = [...group(d.cells, c => c.who)].map(([who, cs]) => ({
    who, label: name(who), a: sum(cs), reports: new Set(cs.map(c => c.sec)).size,
    rows: cs.map(c => ({ key: c.sec, name: reportLabel(c.sec, d.savedNames), a: c as Agg })).sort((x, y) => byWeight(x.a, y.a)),
  })).sort((x, y) => byWeight(x.a, y.a)).slice(0, 80);
  const sinceText = period.days === 1 ? 'сегодня (с 00:00 МСК)' : `за ${period.days} дней, включая сегодня (МСК)`;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {PERIODS.map(p => (
          <Link
            key={p.key}
            href={p.key === 'today' ? '/big-brother' : `/big-brother?d=${p.key}`}
            aria-current={p === period ? 'page' : undefined}
            className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${p === period
              ? 'bg-[var(--color-accent)] text-white'
              : 'border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}
          >{p.label}</Link>
        ))}
      </div>
      <p className="text-sm text-[var(--color-text-secondary)]">
        Монолитика {sinceText}. Активное время — 5-минутные отрезки, когда вкладка была открыта и человек
        что-то делал в последние 2 минуты.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Активных людей" value={String(d.users)} />
        <Tile label="Активное время" value={fmtMin(d.minutes)} hint={d.users ? `≈ ${fmtMin(Math.round(d.minutes / d.users))} на человека` : undefined} />
        <Tile label="Открытий разделов" value={String(d.views)} />
        <Tile label="Действий" value={String(d.actions)} hint="в сервисах и отчётах" />
        <Tile label="Входов" value={String(d.logins)} />
      </div>

      <section className={`${CARD} min-w-0`}>
        <div className="px-3 pt-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Отчёты</h2>
          <p className={MUTED}>
            Загрузки — открытия отчёта и смены параметров (одинаковые параметры за 2 мин считаются один раз); расшифровки —
            клики в ячейки. Нажмите на отчёт — кто его смотрит.
          </p>
        </div>
        {reports.length ? (
          <ul className="mt-2">
            {reports.map(r => (
              <li key={r.sec} className="border-t border-[var(--color-border)]">
                <details>
                  <summary className="flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 px-3 py-2 hover:bg-[var(--color-bg-hover)]">
                    <span className="min-w-0 truncate text-sm text-[var(--color-text)]">{r.label}</span>
                    <Stats a={r.a} people={r.people} />
                  </summary>
                  <div className="pb-2"><DetailTable head="Человек" rows={r.rows} /></div>
                </details>
              </li>
            ))}
          </ul>
        ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">Отчёты за период не открывали.</p>}
      </section>

      <section className={`${CARD} min-w-0`}>
        <div className="px-3 pt-3">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Отчёты по людям</h2>
          <p className={MUTED}>Кто какие отчёты смотрит. Нажмите на человека — список его отчётов.</p>
        </div>
        {persons.length ? (
          <ul className="mt-2">
            {persons.map(p => (
              <li key={p.who} className="border-t border-[var(--color-border)]">
                <details>
                  <summary className="flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 px-3 py-2 hover:bg-[var(--color-bg-hover)]">
                    <span className="min-w-0 truncate text-sm text-[var(--color-text)]">
                      {p.label} <span className={MUTED}>· отчётов: {p.reports} · последний заход {fmtWhen(p.a.last)}</span>
                    </span>
                    <Stats a={p.a} />
                  </summary>
                  <div className="pb-2"><DetailTable head="Отчёт" rows={p.rows} /></div>
                </details>
              </li>
            ))}
          </ul>
        ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">Нет данных.</p>}
      </section>

      <section className={`${CARD} min-w-0`}>
        <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Топ разделов</h2>
        {d.sections.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr><th className={TH}>Раздел</th><th className={`${TH} text-right`}>Время</th><th className={`${TH} text-right`}>Открытий</th><th className={`${TH} text-right`}>Людей</th></tr></thead>
              <tbody>
                {d.sections.map(s => (
                  <tr key={s.section} className="border-t border-[var(--color-border)]">
                    <td className={TD}>{sectionLabel(s.section, d.savedNames)}</td>
                    <td className={NUM}>{fmtMin(s.minutes)}</td>
                    <td className={NUM}>{s.views}</td>
                    <td className={NUM}>{s.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">За период никого не было.</p>}
      </section>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <section className={`${CARD} min-w-0`}>
          <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Откуда заходят</h2>
          {d.surfaces.length ? (
            <div className="scroll-x">
              <table className="w-full text-sm">
                <thead><tr><th className={TH}>Режим</th><th className={`${TH} text-right`}>Людей</th><th className={`${TH} text-right`}>Время</th></tr></thead>
                <tbody>
                  {d.surfaces.map(s => (
                    <tr key={s.surface} className="border-t border-[var(--color-border)]">
                      <td className={TD}>{SURFACE_LABELS[s.surface] ?? s.surface}</td>
                      <td className={NUM}>{s.users}</td>
                      <td className={NUM}>{fmtMin(s.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">Нет данных.</p>}
        </section>
        <section className={`${CARD} min-w-0`}>
          <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Действия в сервисах</h2>
          {d.services.length ? (
            <div className="scroll-x">
              <table className="w-full text-sm">
                <thead><tr><th className={TH}>Сервис</th><th className={`${TH} text-right`}>Действий</th><th className={`${TH} text-right`}>Людей</th></tr></thead>
                <tbody>
                  {d.services.map(s => (
                    <tr key={s.section} className="border-t border-[var(--color-border)]">
                      <td className={TD}>{SERVICE_LABELS[s.section] ?? s.section}</td>
                      <td className={NUM}>{s.actions}</td>
                      <td className={NUM}>{s.users}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">За период изменений в Задачнике, канбанах больших и логистов не было.</p>}
        </section>
      </div>
    </div>
  );
}
