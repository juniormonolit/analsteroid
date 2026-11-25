import { systemDb } from '@/lib/db/clients';

// «Большой брат» → «Обзор» (фаза 0): что происходит в Монолитике сегодня (МСК) — события, активные
// люди, активное время, топ разделов и откуда заходят. Источник — activity_events / activity_minutes
// (миграция 296). Гейт — в layout.tsx. Подробная аналитика — вкладки «РОПы», «Задачи», «Люди», «Сторож».
export const dynamic = 'force-dynamic';

const TODAY = `(date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')`;

const SECTION_LABELS: Record<string, string> = {
  home: 'Главная', profile: 'Личный кабинет', tasker: 'Задачник', 'repeat-kanban': 'Канбан повторных',
  'big-deals-kanban': 'Канбан больших чеков', 'logist-kanban': 'Канбан логиста', reports: 'Отчёты',
  sales: 'Продажи', today: 'Сегодня', rating: 'Рейтинг', summary: 'Сводная', plans: 'Планы',
  'big-brother': 'Большой брат', settings: 'Настройки', 'metric-map': 'Карта показателей',
  'bx/manager': 'Битрикс: ЛК', 'bx/deal-requests': 'Битрикс: запросы логисту',
};
const SURFACE_LABELS: Record<string, string> = {
  web: 'Браузер (десктоп)', mobile: 'Браузер (телефон)', pwa: 'Приложение (PWA)', bx_iframe: 'Внутри Битрикса', server: 'Сервер',
};
const ACTION_LABELS: Record<string, string> = {
  tasker: 'Задачник', big_deals: 'Канбан больших', logist: 'Канбан логиста',
};

type Overview = {
  events: number; views: number; actions: number; logins: number; users: number; minutes: number;
  sections: { section: string; views: number; minutes: number; users: number }[];
  surfaces: { surface: string; users: number; minutes: number }[];
  services: { section: string; actions: number; users: number }[];
};

async function load(): Promise<Overview> {
  const db = systemDb();
  const [tot, sec, surf, svc] = await Promise.all([
    db.query<{ events: string; views: string; actions: string; logins: string; users: string; minutes: string }>(
      `WITH e AS (SELECT kind, action, COALESCE(bitrix_user_id, 'u:' || user_id) AS who FROM activity_events WHERE ts >= ${TODAY}),
            m AS (SELECT bitrix_user_id AS who, bucket FROM activity_minutes WHERE bucket >= ${TODAY} AND source = 'mono')
       SELECT (SELECT count(*) FROM e) AS events,
              (SELECT count(*) FROM e WHERE kind = 'mono_view') AS views,
              (SELECT count(*) FROM e WHERE kind = 'mono_action') AS actions,
              (SELECT count(*) FROM e WHERE kind = 'session' AND action = 'login') AS logins,
              (SELECT count(*) FROM (SELECT who FROM e UNION SELECT who FROM m) x) AS users,
              (SELECT count(*) FROM (SELECT DISTINCT who, bucket FROM m) x) * 5 AS minutes`),
    db.query<{ section: string; views: string; minutes: string; users: string }>(
      `WITH v AS (SELECT section, count(*) AS views, count(DISTINCT COALESCE(bitrix_user_id, user_id::text)) AS users
                    FROM activity_events WHERE ts >= ${TODAY} AND kind = 'mono_view' GROUP BY section),
            m AS (SELECT section, count(*) * 5 AS minutes FROM activity_minutes
                   WHERE bucket >= ${TODAY} AND source = 'mono' GROUP BY section)
       SELECT COALESCE(v.section, m.section) AS section, COALESCE(v.views, 0) AS views,
              COALESCE(m.minutes, 0) AS minutes, COALESCE(v.users, 0) AS users
         FROM v FULL JOIN m ON m.section = v.section
        ORDER BY COALESCE(m.minutes, 0) DESC, COALESCE(v.views, 0) DESC LIMIT 12`),
    db.query<{ surface: string; users: string; minutes: string }>(
      `SELECT surface, count(DISTINCT bitrix_user_id) AS users, count(*) * 5 AS minutes
         FROM activity_minutes WHERE bucket >= ${TODAY} AND source = 'mono' GROUP BY surface ORDER BY 3 DESC`),
    db.query<{ section: string; actions: string; users: string }>(
      `SELECT section, count(*) AS actions, count(DISTINCT COALESCE(bitrix_user_id, user_id::text)) AS users
         FROM activity_events WHERE ts >= ${TODAY} AND kind = 'mono_action' GROUP BY section ORDER BY 2 DESC`),
  ]);
  const t = tot.rows[0];
  return {
    events: +t.events, views: +t.views, actions: +t.actions, logins: +t.logins, users: +t.users, minutes: +t.minutes,
    sections: sec.rows.map(r => ({ section: r.section, views: +r.views, minutes: +r.minutes, users: +r.users })),
    surfaces: surf.rows.map(r => ({ surface: r.surface, users: +r.users, minutes: +r.minutes })),
    services: svc.rows.map(r => ({ section: r.section, actions: +r.actions, users: +r.users })),
  };
}

const fmtMin = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60 ? `${m % 60} мин` : ''}`.trim() : `${m} мин`);
const CARD = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]';
const TH = 'px-3 py-2 text-left font-medium text-[var(--color-text-secondary)]';
const TD = 'px-3 py-2 text-[var(--color-text)]';

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${CARD} min-w-0 p-3`}>
      <div className="text-xs text-[var(--color-text-secondary)]">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
      {hint && <div className="text-xs text-[var(--color-text-secondary)]">{hint}</div>}
    </div>
  );
}

export default async function BigBrotherOverview() {
  let d: Overview;
  try {
    d = await load();
  } catch (err) {
    console.error('[big-brother] обзор:', err instanceof Error ? err.message : err);
    return (
      <p className="text-sm text-[var(--color-text-secondary)]">
        Журнал активности ещё не подключён (нет таблиц миграции 296) или база недоступна.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Монолитика сегодня (с 00:00 МСК). Активное время — 5-минутные отрезки, когда вкладка была открыта и человек
        что-то делал в последние 2 минуты.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Активных людей" value={String(d.users)} />
        <Tile label="Активное время" value={fmtMin(d.minutes)} hint={d.users ? `≈ ${fmtMin(Math.round(d.minutes / d.users))} на человека` : undefined} />
        <Tile label="Открытий разделов" value={String(d.views)} />
        <Tile label="Действий в сервисах" value={String(d.actions)} />
        <Tile label="Входов" value={String(d.logins)} />
      </div>

      <section className={`${CARD} min-w-0`}>
        <h2 className="px-3 pt-3 text-sm font-semibold text-[var(--color-text)]">Топ разделов</h2>
        {d.sections.length ? (
          <div className="scroll-x">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr><th className={TH}>Раздел</th><th className={`${TH} text-right`}>Время</th><th className={`${TH} text-right`}>Открытий</th><th className={`${TH} text-right`}>Людей</th></tr></thead>
              <tbody>
                {d.sections.map(s => (
                  <tr key={s.section} className="border-t border-[var(--color-border)]">
                    <td className={TD}>{SECTION_LABELS[s.section] ?? s.section}</td>
                    <td className={`${TD} text-right tabular-nums`}>{fmtMin(s.minutes)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{s.views}</td>
                    <td className={`${TD} text-right tabular-nums`}>{s.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">Сегодня ещё никого не было.</p>}
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
                      <td className={`${TD} text-right tabular-nums`}>{s.users}</td>
                      <td className={`${TD} text-right tabular-nums`}>{fmtMin(s.minutes)}</td>
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
                      <td className={TD}>{ACTION_LABELS[s.section] ?? s.section}</td>
                      <td className={`${TD} text-right tabular-nums`}>{s.actions}</td>
                      <td className={`${TD} text-right tabular-nums`}>{s.users}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="p-3 text-sm text-[var(--color-text-secondary)]">Сегодня изменений в Задачнике, канбанах больших и логистов не было.</p>}
        </section>
      </div>
    </div>
  );
}
