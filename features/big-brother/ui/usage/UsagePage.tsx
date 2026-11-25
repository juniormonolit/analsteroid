'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DepthSteps, UsageDto, UsageReportRow } from '@/features/big-brother/engine/usage/types';

// «Большой брат» → «Использование Монолитики» (поток E). Данные — GET /api/big-brother/usage.
// Шесть блоков: живые/мёртвые отчёты и сироты, глубина захода, параметры, пустые/медленные загрузки,
// мобильный срез, внедрение фич по changelog. Где поле журнала ещё не пишется — честное «копится с …».

const CARD = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-4';
const MUTED = 'text-xs text-[var(--color-text-secondary)]';
const H2 = 'text-sm font-semibold text-[var(--color-text)]';
const TH = 'px-2 py-1.5 text-left text-xs font-medium text-[var(--color-text-secondary)] whitespace-nowrap';
const TD = 'px-2 py-1.5 align-top';
const NUM = `${TD} text-right tabular-nums whitespace-nowrap`;

const SURFACE_LABEL: Record<string, string> = {
  web: 'Браузер (десктоп)', mobile: 'Браузер (телефон)', pwa: 'Приложение (PWA)', bx_iframe: 'Внутри Битрикса', server: 'Сервер', '—': 'Не указано',
};

function fmtDate(iso: string | null, time = false): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', ...(time ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}
/** Сколько полных дней ведётся журнал (0 — меньше суток). */
function journalDays(d: UsageDto): number {
  return d.since.journal ? Math.floor((Date.parse(d.generatedAt) - Date.parse(d.since.journal)) / 86400_000) : 0;
}
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

/** «копится с 25.11» / «ещё не пишется» — подпись под блоком, чьё поле журнала появилось недавно. */
function Since({ label, at }: { label: string; at: string | null }) {
  return <span className="whitespace-nowrap">{label}: {at ? `с ${fmtDate(at, true)}` : 'ещё не пишется'}</span>;
}

type Filter = 'all' | 'alive' | 'dead' | 'sole';
const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Все' }, { key: 'alive', label: 'Живые' }, { key: 'dead', label: 'Без зрителей' }, { key: 'sole', label: 'Один зритель' },
];

export function UsagePage() {
  const [data, setData] = useState<UsageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/big-brother/usage${fresh ? '?fresh=1' : ''}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error && !data) return <div className={`${CARD} text-sm text-[var(--color-error)]`}>Не загрузилось: {error}</div>;
  if (!data) return <div className={MUTED}>Считаю…</div>;
  const s = data.since;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className={`${CARD} flex min-w-0 flex-col gap-2`}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
            Как пользуются Монолитикой: какие отчёты живы, насколько глубоко в них работают, что тормозит и что
            не прижилось. Журнал пишется {s.journal ? `с ${fmtDate(s.journal, true)}` : '— ещё нет данных'}, окна «30 / 90 дней»
            пока короче заявленных — не делайте выводов «отчёт мёртв» по первым дням.
          </p>
          <button type="button" onClick={() => load(true)} disabled={busy}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-text)] disabled:opacity-50">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Обновить
          </button>
        </div>
        <div className={`${MUTED} flex flex-wrap gap-x-4 gap-y-1`}>
          <Since label="длительность просмотров" at={s.viewDuration} />
          <Since label="время и строки загрузки" at={s.loadTiming ?? s.loadRows} />
          <Since label="метрики в загрузке" at={s.metricIds} />
          <Since label="ошибки отчётов" at={s.errors} />
          <span className="whitespace-nowrap">раздел у записей «Что изменилось?»: {s.changelogSection ? 'есть' : 'ещё нет'}</span>
        </div>
      </div>

      <ReportsBlock data={data} />
      <OrphansBlock data={data} />
      <DepthBlock data={data} />
      <ParamsBlock data={data} />
      <QualityBlock data={data} />
      <SurfacesBlock data={data} />
      <ChangelogBlock data={data} />
    </div>
  );
}

function ReportsBlock({ data }: { data: UsageDto }) {
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => data.reports.filter((r: UsageReportRow) =>
    filter === 'all' ? true : filter === 'alive' ? r.people90 > 0 : filter === 'dead' ? r.people90 === 0 : r.people90 === 1,
  ), [data.reports, filter]);
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-2`}>
      <h2 className={H2}>Отчёты: живые и без зрителей</h2>
      <p className={MUTED}>
        Люди — уникальные за 30 / 90 дней. Отскок — заход короче минуты без смены параметров, проваливания и выгрузки
        (считается только там, где длительность известна). «Без зрителей» — не повод удалять: сначала проверьте сезонность.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
            className={`min-h-11 rounded-md px-3 text-sm sm:min-h-9 ${filter === f.key ? 'bg-[var(--color-accent)] text-white' : 'border border-[var(--color-border)] text-[var(--color-text)]'}`}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[720px] text-sm text-[var(--color-text)]">
          <thead><tr className="border-b border-[var(--color-border)]">
            <th className={TH}>Отчёт</th><th className={`${TH} text-right`}>Люди 30 / 90</th><th className={`${TH} text-right`}>Минуты 30 / 90</th>
            <th className={`${TH} text-right`}>Заходы</th><th className={`${TH} text-right`}>Отскок</th><th className={TH}>Последний заход</th><th className={TH}>Единственный зритель</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.section} className={`border-b border-[var(--color-border)] last:border-0 ${r.people90 === 0 ? 'text-[var(--color-text-secondary)]' : ''}`}>
                <td className={TD}>{r.label}{r.kind === 'saved' && <span className={`${MUTED} ml-1`}>сохр.</span>}</td>
                <td className={NUM}>{r.people30} / {r.people90}</td>
                <td className={NUM}>{r.minutes30} / {r.minutes90}</td>
                <td className={NUM}>{r.visits}</td>
                <td className={NUM}>{r.bounceKnown ? `${pct(r.bounces, r.bounceKnown)} из ${r.bounceKnown}` : '—'}</td>
                <td className={`${TD} whitespace-nowrap`}>{fmtDate(r.lastAt, true)}</td>
                <td className={TD}>{r.soleViewer ?? ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className={`${TD} ${MUTED}`}>Нет отчётов под фильтр.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrphansBlock({ data }: { data: UsageDto }) {
  const [all, setAll] = useState(false);
  const list = all ? data.orphans : data.orphans.slice(0, 10);
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-2`}>
      <h2 className={H2}>Сохранённые отчёты-сироты ({data.orphans.length})</h2>
      <p className={MUTED}>Никто не открывал с начала журнала или владелец ушёл из компании. «Общий» — выложен в раздел для всех.</p>
      {journalDays(data) < 30 && (
        <p className="text-xs text-[var(--color-warning)]">
          Журнал ведётся {journalDays(data)} дн. — «никто не открывал» станет значимым через месяц; сейчас здесь почти все сохранённые отчёты.
        </p>
      )}
      {data.orphans.length === 0 ? <p className={MUTED}>Сирот нет.</p> : (
        <div className="scroll-x">
          <table className="w-full min-w-[560px] text-sm text-[var(--color-text)]">
            <thead><tr className="border-b border-[var(--color-border)]">
              <th className={TH}>Отчёт</th><th className={TH}>Владелец</th><th className={TH}>Создан</th><th className={`${TH} text-right`}>Зрителей</th>
            </tr></thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className={TD}>{o.name}{o.shared && <span className={`${MUTED} ml-1`}>общий</span>}</td>
                  <td className={TD}>{o.owner}{o.ownerLeft && <span className="ml-1 text-xs text-[var(--color-negative)]">ушёл</span>}</td>
                  <td className={`${TD} whitespace-nowrap`}>{fmtDate(o.createdAt)}</td>
                  <td className={NUM}>{o.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.orphans.length > 10 && (
        <button type="button" onClick={() => setAll(!all)} className="min-h-11 self-start text-sm text-[var(--color-accent)]">
          {all ? 'Свернуть' : `Показать все ${data.orphans.length}`}
        </button>
      )}
    </section>
  );
}

const STEPS: Array<{ key: keyof DepthSteps; label: string }> = [
  { key: 'visits', label: 'Заходов' },
  { key: 'loaded', label: 'Отчёт построился' },
  { key: 'changedParams', label: 'Меняли параметры' },
  { key: 'changedPeriod', label: 'Меняли период' },
  { key: 'drilled', label: 'Проваливались (drill)' },
  { key: 'exported', label: 'Выгружали' },
  { key: 'toManager', label: 'Перешли в карточку менеджера' },
];

function Bar({ value, max }: { value: number; max: number }) {
  return (
    <div className="h-2 w-full min-w-0 overflow-hidden rounded bg-[var(--color-bg)]">
      <div className="h-full rounded bg-[var(--color-accent)]" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

function DepthBlock({ data }: { data: UsageDto }) {
  const d = data.depth;
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-3`}>
      <h2 className={H2}>Глубина работы с отчётами</h2>
      <p className={MUTED}>Доля заходов, в которых было действие. Заход — подряд идущие просмотры одного отчёта (до 30 мин).</p>
      <div className="flex flex-col gap-2">
        {STEPS.map((st) => (
          <div key={st.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[14rem_minmax(0,1fr)_6rem]">
            <span className="text-sm text-[var(--color-text)]">{st.label}</span>
            <span className="text-right text-sm tabular-nums sm:order-last">{d[st.key]}{st.key !== 'visits' && <span className={`${MUTED} ml-1`}>{pct(d[st.key], d.visits)}</span>}</span>
            <div className="col-span-2 sm:col-span-1"><Bar value={d[st.key]} max={d.visits} /></div>
          </div>
        ))}
      </div>
      {data.depthByReport.length > 0 && (
        <div className="scroll-x">
          <table className="w-full min-w-[640px] text-sm text-[var(--color-text)]">
            <thead><tr className="border-b border-[var(--color-border)]">
              <th className={TH}>Отчёт</th>{STEPS.map((st) => <th key={st.key} className={`${TH} text-right`}>{st.key === 'visits' ? 'Заходов' : st.label}</th>)}
            </tr></thead>
            <tbody>
              {data.depthByReport.map((r) => (
                <tr key={r.section} className="border-b border-[var(--color-border)] last:border-0">
                  <td className={TD}>{r.label}</td>
                  {STEPS.map((st) => <td key={st.key} className={NUM}>{st.key === 'visits' ? r.visits : pct(r[st.key], r.visits)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function TopList({ title, rows, empty }: { title: string; rows: Array<{ key: string; label: string; n: number; hint?: string }>; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.n));
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-[var(--color-text)]">{title}</h3>
      {rows.length === 0 ? <p className={MUTED}>{empty}</p> : rows.map((r) => (
        <div key={r.key} className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 justify-between gap-2 text-sm">
            <span className="min-w-0 truncate" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums">{r.n}{r.hint && <span className={`${MUTED} ml-1`}>{r.hint}</span>}</span>
          </div>
          <Bar value={r.n} max={max} />
        </div>
      ))}
    </div>
  );
}

function ParamsBlock({ data }: { data: UsageDto }) {
  const p = data.params;
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-3`}>
      <h2 className={H2}>Какие параметры выбирают</h2>
      <p className={MUTED}>По загрузкам отчётов за 90 дней ({p.loads}). Метрики — с {data.since.metricIds ? fmtDate(data.since.metricIds, true) : '— поле ещё не пишется'}.</p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <TopList title="Метрики" empty="Данные копятся." rows={p.metrics.slice(0, 15).map((m) => ({ key: m.id, label: m.label, n: m.loads, hint: `${m.people} чел.` }))} />
        <div className="flex min-w-0 flex-col gap-4">
          <TopList title="Группировка" empty="Данные копятся." rows={p.groupings.map((g) => ({ key: g.key, label: g.key, n: g.loads }))} />
          <TopList title="Длина периода" empty="Данные копятся." rows={p.periodLength.map((g) => ({ key: g.bucket, label: g.bucket, n: g.loads }))} />
          <TopList title="Сделки · клиенты" empty="Данные копятся." rows={p.scopes.map((g) => ({ key: g.key, label: g.key, n: g.loads }))} />
        </div>
      </div>
    </section>
  );
}

function QualityBlock({ data }: { data: UsageDto }) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-2`}>
      <h2 className={H2}>Пустые, медленные и с ошибкой</h2>
      <p className={MUTED}>
        Доля от загрузок, где поле известно: время — с {data.since.loadTiming ? fmtDate(data.since.loadTiming, true) : '— ещё не пишется'},
        строки — с {data.since.loadRows ? fmtDate(data.since.loadRows, true) : '— ещё не пишется'}. Медленно — дольше 10 с.
      </p>
      {data.quality.length === 0 ? <p className={MUTED}>Загрузок отчётов пока нет.</p> : (
        <div className="scroll-x">
          <table className="w-full min-w-[600px] text-sm text-[var(--color-text)]">
            <thead><tr className="border-b border-[var(--color-border)]">
              <th className={TH}>Отчёт</th><th className={`${TH} text-right`}>Загрузок</th><th className={`${TH} text-right`}>Пустых</th>
              <th className={`${TH} text-right`}>Дольше 10 с</th><th className={`${TH} text-right`}>Медиана</th><th className={`${TH} text-right`}>Ошибок</th>
            </tr></thead>
            <tbody>
              {data.quality.map((q) => (
                <tr key={q.section} className="border-b border-[var(--color-border)] last:border-0">
                  <td className={TD}>{q.label}</td>
                  <td className={NUM}>{q.loads}</td>
                  <td className={NUM}>{q.withRows ? pct(q.empty, q.withRows) : '—'}</td>
                  <td className={NUM}>{q.withTiming ? pct(q.slow, q.withTiming) : '—'}</td>
                  <td className={NUM}>{q.p50ms != null ? `${(q.p50ms / 1000).toFixed(1)} с` : '—'}</td>
                  <td className={`${NUM} ${q.errors ? 'text-[var(--color-negative)]' : ''}`}>{q.errors ? `${q.errors} (${pct(q.errors, q.errors + q.loads)})` : '0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SurfacesBlock({ data }: { data: UsageDto }) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-2`}>
      <h2 className={H2}>С каких устройств и где отскок выше</h2>
      <p className={MUTED}>Минуты — присутствие во всей Монолитике; заходы и отскок — по отчётам. «Хуже всего» — отчёты с ≥ 3 заходами известной длины.</p>
      {data.surfaces.length === 0 ? <p className={MUTED}>Данных пока нет.</p> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {data.surfaces.map((s) => (
            <div key={s.surface} className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--color-border)] p-3">
              <div className="text-sm font-medium text-[var(--color-text)]">{SURFACE_LABEL[s.surface] ?? s.surface}</div>
              <div className={`${MUTED} flex flex-wrap gap-x-3`}>
                <span>минут: {s.minutes}</span><span>заходов в отчёты: {s.visits}</span><span>людей: {s.people}</span>
                <span>отскок: {s.bounceKnown ? `${pct(s.bounces, s.bounceKnown)} из ${s.bounceKnown}` : '—'}</span>
              </div>
              {s.worst.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 text-sm text-[var(--color-text)]">
                  {s.worst.map((w) => <li key={w.section} className="flex justify-between gap-2"><span className="min-w-0 truncate">{w.label}</span><span className="shrink-0 tabular-nums">{pct(w.bounces, w.bounceKnown)}</span></li>)}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ChangelogBlock({ data }: { data: UsageDto }) {
  return (
    <section className={`${CARD} flex min-w-0 flex-col gap-2`}>
      <h2 className={H2}>Внедрение фич из «Что изменилось?»</h2>
      <p className={MUTED}>
        Увидели — открыли ленту после публикации; открыли раздел — из увидевших зашли в раздел фичи за 7 дней; вернулись —
        из открывших зашли снова на 8–14 день. Нужен раздел у записи: {data.since.changelogSection ? 'поле есть' : 'поле ещё не появилось — воронка только «увидели»'}.
      </p>
      {data.changelog.length === 0 ? <p className={MUTED}>Записей за 90 дней нет.</p> : (
        <div className="scroll-x">
          <table className="w-full min-w-[620px] text-sm text-[var(--color-text)]">
            <thead><tr className="border-b border-[var(--color-border)]">
              <th className={TH}>Запись</th><th className={TH}>Дата</th><th className={TH}>Раздел</th>
              <th className={`${TH} text-right`}>Увидели</th><th className={`${TH} text-right`}>Открыли за 7 дн.</th><th className={`${TH} text-right`}>Вернулись на 2-й неделе</th>
            </tr></thead>
            <tbody>
              {data.changelog.map((c) => (
                <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className={TD}>{c.title}</td>
                  <td className={`${TD} whitespace-nowrap`}>{fmtDate(c.publishedAt)}</td>
                  <td className={`${TD} ${MUTED}`}>{c.section ?? '—'}</td>
                  <td className={NUM}>{c.seen}</td>
                  <td className={NUM}>{c.section ? `${c.opened7} (${pct(c.opened7, c.seen)})` : '—'}</td>
                  <td className={NUM}>{!c.section ? '—' : c.weekTwoDone ? `${c.returnedW2} (${pct(c.returnedW2, c.opened7)})` : 'ещё идёт'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={MUTED}>
        Журнал начался {data.since.journal ? fmtDate(data.since.journal) : '—'}: для записей раньше этой даты «открыли раздел» занижено.
      </p>
    </section>
  );
}
