'use client';
// Мониторинг сервера Битрикса по диагностическим логам (/logs по SFTP, 16.09.2026):
// статус синка, график нагрузки, сводка по дням, снимки с раскрытием (что грузило: HTTP-запросы
// в работе с длительностью, долгие SQL с отпечатками, блокировки), пороги и оповещение.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { RefreshCw, ChevronDown, ChevronRight, AlertTriangle, KeyRound, Bell, Settings2 } from 'lucide-react';

interface Snap {
  id: string; file: string; taken_at: string; load1: string | null; load5: string | null; load15: string | null; mysql_cpu_pct: string | null; mysql_rss_mb: number | null;
  apache_busy: number | null; apache_idle: number | null; apache_slots: number | null; req_per_sec: string | null; dur_per_req_ms: string | null;
  http_active: number | null; http_own: number | null; http_working: number | null; http_working_max_sec: number | null;
  mysql_active: number | null; mysql_long: number | null; mysql_max_sec: number | null; innodb_history: number | null; lock_waits: number | null; deadlock_at: string | null;
  severity: number; flags: { key: string; label: string; value: number; level: number }[]; alerted_at: string | null;
}
interface Day { day: string; snapshots: number; max_load1: number | null; max_busy: number | null; long_total: number; max_sql_sec: number; lock_waits: number; http_own: number; http_active: number; crit: number; warn: number }
interface Setting { key: string; value: unknown; title: string; description: string; group_name: string }
interface Overview { snapshots: Snap[]; byDay: Day[]; settings: Setting[]; status: { total: number; lastTaken: string | null; lastSynced: string | null; firstTaken: string | null; keyPresent: boolean; keyPath: string } }
interface Detail { snapshot: { id: string; file: string; taken_at: string; severity: number; flags: Snap['flags']; detail: {
  topCpu: { cmd: string; cpu: number; user: string }[]; working: { seconds: number; client: string | null; method: string; path: string; category: string; own: boolean }[];
  active: { total: number; own: number; byCategory: Record<string, number>; topPaths: { path: string; n: number; own: boolean }[] };
  mysql: { states: Record<string, number>; rows: { id: number; user: string; seconds: number; state: string; info: string; rowsExamined: number }[]; topFingerprints: { fingerprint: string; n: number; maxSeconds: number }[] };
  innodb: { historyListLength: number | null; lockWaits: number; deadlockAt: string | null; deadlockText: string | null; freeBuffers: number | null; bufferPoolPages: number | null };
  apache: { restartTime: string | null; totalAccesses: number | null; uptimeSec: number | null };
} } }

const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const SEV = {
  0: { label: 'норма', cls: 'bg-[color-mix(in_srgb,var(--color-positive)_16%,transparent)] text-[var(--color-positive)]', dot: 'var(--color-positive)' },
  1: { label: 'высокая', cls: 'bg-[color-mix(in_srgb,var(--color-warning)_20%,transparent)] text-[var(--color-warning)]', dot: 'var(--color-warning)' },
  2: { label: 'критично', cls: 'bg-[color-mix(in_srgb,var(--color-negative)_16%,transparent)] text-[var(--color-negative)]', dot: 'var(--color-negative)' },
} as const;
const CATEGORY_LABEL: Record<string, string> = { rest_mlt: 'REST mlt.* (наши)', rest: 'REST API', rest_im: 'REST мессенджер', crm_mlt: 'CRM /crm/mlt* (наши)', crm: 'CRM', ajax: 'AJAX Битрикса', im: 'Мессенджер', monitoring: 'Мониторинг', other: 'Прочее' };
const n = (v: string | number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: d }));
const msk = (s: string | null, withDate = true) => (s ? new Date(s).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', ...(withDate ? { dateStyle: 'short' as const } : {}), timeStyle: 'short' }) : '—');
const sevOf = (v: number): 0 | 1 | 2 => (v >= 2 ? 2 : v >= 1 ? 1 : 0);

export function BitrixDiagPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(14);
  const { data, isLoading } = useQuery<Overview>({ queryKey: ['b24diag', days], queryFn: () => fetch(`/api/settings/bitrix-diag?days=${days}`).then(r => r.json()), refetchInterval: 60_000 });
  const sync = useMutation({
    mutationFn: async () => { const r = await fetch('/api/settings/bitrix-diag/sync', { method: 'POST' }); const b = await r.json(); if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`); return b as { listed: number; downloaded: number; inserted: number; errors: string[]; alert: string | null; ms: number }; },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['b24diag'] }),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [onlyBad, setOnlyBad] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const snaps = useMemo(() => (data?.snapshots ?? []).filter(s => !onlyBad || s.severity > 0), [data, onlyBad]);
  const st = data?.status;
  const lastAgeMin = st?.lastTaken ? Math.round((Date.now() - new Date(st.lastTaken).getTime()) / 60000) : null;

  return (
    <div className="p-3 sm:p-6 max-w-7xl flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-[var(--color-text)]">Логи сервера Битрикса</h1>
          <p className="text-[12px] text-[var(--color-text-muted)] max-w-3xl">
            Диагностические снимки с td.monolit-crm.ru (SFTP /logs): load average, воркеры Apache, активные HTTP-запросы, процессы MySQL, InnoDB.
            Снимок появляется не по расписанию, а сериями по 3 минуты — сам факт серии уже означает, что серверу было тяжело. Синхронизация каждые 5 минут.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btnCls} onClick={() => setShowSettings(v => !v)}><Settings2 size={14} /> Пороги и оповещения</button>
          <button className={btnPrimaryCls} onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} /> Забрать новые логи</button>
        </div>
      </div>

      {/* Статус */}
      <div className="flex flex-wrap gap-1.5 text-[12px]">
        <Chip>снимков всего {st?.total ?? '…'}</Chip>
        <Chip>первый {msk(st?.firstTaken ?? null)}</Chip>
        <Chip>последний {msk(st?.lastTaken ?? null)}{lastAgeMin !== null ? ` (${lastAgeMin < 60 ? `${lastAgeMin} мин` : `${Math.round(lastAgeMin / 60)} ч`} назад)` : ''}</Chip>
        <Chip>синк {msk(st?.lastSynced ?? null)}</Chip>
        {st && !st.keyPresent && <span className="inline-flex items-center gap-1 rounded-md bg-[color-mix(in_srgb,var(--color-negative)_16%,transparent)] px-2 py-0.5 text-[var(--color-negative)]"><KeyRound size={12} /> нет SSH-ключа на сервере: {st.keyPath}</span>}
        <Link href="/settings/bots/analitik?tab=functions" className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-0.5 text-[var(--color-accent)] hover:underline"><Bell size={12} /> оповещения: функция «Мониторинг Битрикса»</Link>
      </div>
      {sync.isError && <div className={`${cardCls} text-sm text-[var(--color-negative)]`}><AlertTriangle size={14} className="inline mr-1" /> {(sync.error as Error).message}</div>}
      {sync.isSuccess && (
        <div className={`${cardCls} text-[12px] text-[var(--color-text)]`}>
          Забрано: на сервере {sync.data.listed} файлов, скачано {sync.data.downloaded}, новых снимков {sync.data.inserted}, {(sync.data.ms / 1000).toFixed(1)} с.
          {sync.data.alert && <> Оповещение: {sync.data.alert}.</>}
          {sync.data.errors.length > 0 && <div className="mt-1 text-[var(--color-negative)]">{sync.data.errors.slice(0, 5).join(' · ')}</div>}
        </div>
      )}

      {showSettings && data && <SettingsBlock settings={data.settings} />}

      {/* График load1 по снимкам */}
      {data && data.snapshots.length > 0 && <LoadChart snaps={data.snapshots} days={days} />}

      {/* По дням */}
      {data && data.byDay.length > 0 && (
        <section className={cardCls}>
          <h2 className="mb-2 text-base font-bold text-[var(--color-text)]">По дням (60 дней)</h2>
          <div className="scroll-x rounded-xl border border-[var(--color-border)] max-h-[360px] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
                <tr><th className="px-2 py-2 text-left">День</th><th className="px-2 py-2 text-right">Снимков</th><th className="px-2 py-2 text-right">Критичных</th><th className="px-2 py-2 text-right">Высоких</th><th className="px-2 py-2 text-right">Макс load</th><th className="px-2 py-2 text-right">Макс воркеров</th><th className="px-2 py-2 text-right">Долгих SQL</th><th className="px-2 py-2 text-right">Макс SQL, с</th><th className="px-2 py-2 text-right">Блокировок</th><th className="px-2 py-2 text-right">Наших запросов</th></tr>
              </thead>
              <tbody>
                {data.byDay.map(d => (
                  <tr key={d.day} className="border-t border-[var(--color-border)]">
                    <td className="px-2 py-1.5 whitespace-nowrap text-[var(--color-text)]">{d.day.split('-').reverse().join('.')}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.snapshots}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${d.crit ? 'text-[var(--color-negative)] font-semibold' : 'text-[var(--color-text-muted)]'}`}>{d.crit}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${d.warn ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`}>{d.warn}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(d.max_load1)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(d.max_busy, 0)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.long_total}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.max_sql_sec}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.lock_waits}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{d.http_active ? `${Math.round((d.http_own / d.http_active) * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Снимки */}
      <section className={cardCls}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">Снимки</h2>
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <select value={days} onChange={e => setDays(Number(e.target.value))} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[var(--color-text)]">
              {[3, 7, 14, 30, 60].map(d => <option key={d} value={d}>{d} дней</option>)}
            </select>
            <label className="inline-flex items-center gap-1.5 min-h-8 text-[var(--color-text)]"><input type="checkbox" checked={onlyBad} onChange={e => setOnlyBad(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" /> только с нагрузкой</label>
            <span className="text-[var(--color-text-muted)]">{snaps.length} шт.</span>
          </div>
        </div>
        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
        {data && snaps.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Снимков за период нет. Нажми «Забрать новые логи».</div>}
        {snaps.length > 0 && (
          <div className="scroll-x rounded-xl border border-[var(--color-border)]">
            <table className="w-full text-[12px]">
              <thead className="bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
                <tr>
                  <th className="px-2 py-2 text-left">Время (МСК)</th><th className="px-2 py-2 text-left">Уровень</th>
                  <th className="px-2 py-2 text-right" title="load average 1 / 5 / 15 мин">Load 1/5/15</th>
                  <th className="px-2 py-2 text-right" title="Занятых воркеров Apache из всех слотов">Воркеры</th>
                  <th className="px-2 py-2 text-right" title="HTTP-запросов в работе прямо сейчас / самый долгий, с">В работе / макс с</th>
                  <th className="px-2 py-2 text-right" title="Доля запросов Монолитики среди активных">Наши</th>
                  <th className="px-2 py-2 text-right" title="Активных SQL / дольше 5 с / самый долгий, с">SQL акт / долгих / макс с</th>
                  <th className="px-2 py-2 text-right">Блок.</th>
                  <th className="px-2 py-2 text-right" title="CPU процесса mysqld, % одного ядра">MySQL CPU</th>
                  <th className="px-2 py-2 text-right" title="Средняя длительность ответа за всё время работы Apache">Ср. ответ, мс</th>
                </tr>
              </thead>
              <tbody>
                {snaps.map(s => {
                  const isOpen = open === s.id; const sev = SEV[sevOf(s.severity)];
                  return (
                    <Frag key={s.id}>
                      <tr className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-hover)] cursor-pointer" onClick={() => setOpen(isOpen ? null : s.id)}>
                        <td className="px-2 py-1.5 whitespace-nowrap text-[var(--color-text)]"><span className="inline-flex items-center gap-1">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}{msk(s.taken_at)}</span></td>
                        <td className="px-2 py-1.5 whitespace-nowrap"><span className={`rounded px-1.5 py-0.5 ${sev.cls}`}>{sev.label}</span>{s.alerted_at && <Bell size={11} className="inline ml-1 text-[var(--color-text-muted)]" />}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums"><b>{n(s.load1)}</b> / {n(s.load5)} / {n(s.load15)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.apache_busy ?? '—'} / {s.apache_slots ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.http_working ?? 0} / {s.http_working_max_sec ?? 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.http_active ? `${Math.round(((s.http_own ?? 0) / s.http_active) * 100)}%` : '—'}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.mysql_active ?? 0} / <b>{s.mysql_long ?? 0}</b> / {s.mysql_max_sec ?? 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{s.lock_waits ?? 0}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{n(s.mysql_cpu_pct, 0)}%</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{n(s.dur_per_req_ms, 0)}</td>
                      </tr>
                      {isOpen && <tr className="bg-[var(--color-bg)] border-t border-dashed border-[var(--color-border)]"><td colSpan={10} className="px-3 py-3"><SnapshotDetail id={s.id} /></td></tr>}
                    </Frag>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
function Frag({ children }: { children: React.ReactNode }) { return <>{children}</>; }
function Chip({ children }: { children: React.ReactNode }) { return <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-0.5 text-[var(--color-text)]">{children}</span>; }

// ── График load1: точка на снимок, цвет по уровню, линия порогов ──────────────
function LoadChart({ snaps, days }: { snaps: Snap[]; days: number }) {
  const W = 1000, H = 160, padL = 36, padB = 22;
  const to = Date.now(), from = to - days * 86400000;
  const pts = snaps.filter(s => s.load1 !== null).map(s => ({ t: new Date(s.taken_at).getTime(), v: Number(s.load1), sev: sevOf(s.severity), busy: s.apache_busy ?? 0 }));
  const maxV = Math.max(20, ...pts.map(p => p.v)) * 1.1;
  const x = (t: number) => padL + ((t - from) / (to - from)) * (W - padL - 8);
  const y = (v: number) => H - padB - (v / maxV) * (H - padB - 8);
  const dayTicks: number[] = []; for (let d = new Date(from); d.getTime() <= to; d = new Date(d.getTime() + 86400000)) dayTicks.push(new Date(d.toISOString().slice(0, 10) + 'T00:00:00+03:00').getTime());
  return (
    <section className={cardCls}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-bold text-[var(--color-text)]">Load average по снимкам</h2><span className="text-[11px] text-[var(--color-text-muted)]">точка — снимок; цвет — уровень; высота — load1; пусто — снимков не было (сервер не снимал)</span></div>
      <div className="scroll-x"><svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px] h-40" role="img" aria-label="load average">
        {[0.25, 0.5, 0.75, 1].map(f => <g key={f}><line x1={padL} x2={W - 8} y1={y(maxV * f)} y2={y(maxV * f)} stroke="var(--color-border)" strokeDasharray="2 3" /><text x={padL - 4} y={y(maxV * f) + 3} fontSize="9" textAnchor="end" fill="var(--color-text-muted)">{Math.round(maxV * f)}</text></g>)}
        {dayTicks.map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={8} y2={H - padB} stroke="var(--color-border)" strokeOpacity={0.5} /><text x={x(t) + 2} y={H - 8} fontSize="9" fill="var(--color-text-muted)">{new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })}</text></g>)}
        {pts.map((p, i) => <g key={i}><line x1={x(p.t)} x2={x(p.t)} y1={y(0)} y2={y(p.v)} stroke={SEV[p.sev].dot} strokeOpacity={0.35} /><circle cx={x(p.t)} cy={y(p.v)} r={3} fill={SEV[p.sev].dot}><title>{`${msk(new Date(p.t).toISOString())} · load ${p.v} · воркеров ${p.busy}`}</title></circle></g>)}
      </svg></div>
    </section>
  );
}

// ── Детали снимка ──────────────────────────────────────────────────────────────
function SnapshotDetail({ id }: { id: string }) {
  const { data, isLoading } = useQuery<Detail>({ queryKey: ['b24diag-snap', id], queryFn: () => fetch(`/api/settings/bitrix-diag/snapshot?id=${id}`).then(r => r.json()), staleTime: Infinity });
  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>;
  const d = data?.snapshot?.detail; if (!d) return <div className="text-sm text-[var(--color-negative)]">Нет данных</div>;
  const s = data!.snapshot;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 text-[12px] text-[var(--color-text)]">
      <div className="xl:col-span-2 flex flex-wrap gap-1.5">
        {s.flags.map(f => <span key={f.key} className={`rounded px-1.5 py-0.5 ${SEV[sevOf(f.level)].cls}`}>{f.label}: {n(f.value)}</span>)}
        {s.flags.length === 0 && <span className="text-[var(--color-text-muted)]">порогов не превышено</span>}
        <span className="ml-auto text-[var(--color-text-muted)]">{s.file} · Apache перезапущен {d.apache.restartTime ?? '—'}</span>
      </div>
      <Block title={`HTTP-запросы в работе (${d.working.length}) — по длительности`} hint="Что сервер обрабатывал в момент снимка: секунды с начала запроса. [Монолитика] — с нашего сервера.">
        {d.working.length === 0 ? <Muted>Ни одного запроса в работе — Apache свободен.</Muted> : (
          <Table cols={['с', 'Метод', 'Путь', 'Клиент']} rows={d.working.slice(0, 30).map(w => [String(w.seconds), w.method, <span key="p" className={w.own ? 'text-[var(--color-accent)] font-semibold' : ''}>{w.path}{w.own ? ' [Монолитика]' : ''}</span>, w.client ?? '—'])} right={[0]} />
        )}
      </Block>
      <Block title={`Активные HTTP по типам (${d.active.total}, наших ${d.active.own})`} hint="Список активных запросов из снимка, сгруппированный.">
        <div className="flex flex-wrap gap-1.5 mb-2">{Object.entries(d.active.byCategory).sort((a, b) => b[1] - a[1]).map(([k, v]) => <Chip key={k}>{CATEGORY_LABEL[k] ?? k}: {v}</Chip>)}</div>
        <Table cols={['Путь', 'Раз']} rows={d.active.topPaths.slice(0, 15).map(p => [<span key="p" className={p.own ? 'text-[var(--color-accent)] font-semibold' : ''}>{p.path}{p.own ? ' [Монолитика]' : ''}</span>, String(p.n)])} right={[1]} />
      </Block>
      <Block title={`Долгие SQL — по отпечаткам (${d.mysql.topFingerprints.length})`} hint="Одинаковые запросы с разными параметрами схлопнуты. ×N — сколько таких висело одновременно: много одинаковых — очередь на одну строку/таблицу.">
        <div className="flex flex-wrap gap-1.5 mb-2">{Object.entries(d.mysql.states).sort((a, b) => b[1] - a[1]).map(([k, v]) => <Chip key={k}>{k}: {v}</Chip>)}</div>
        {d.mysql.topFingerprints.length === 0 ? <Muted>Активных запросов не было.</Muted> : (
          <Table cols={['×', 'Макс с', 'Запрос']} rows={d.mysql.topFingerprints.map(f => [String(f.n), String(f.maxSeconds), <code key="q" className="break-all text-[11px]">{f.fingerprint}</code>])} right={[0, 1]} />
        )}
      </Block>
      <Block title="InnoDB и процессы" hint="History list length — очередь неочищенных версий строк (норма — тысячи; сотни тысяч — долгие транзакции). LOCK WAIT — кто-то ждёт блокировку.">
        <div className="flex flex-wrap gap-1.5 mb-2">
          <Chip>history list: {n(d.innodb.historyListLength, 0)}</Chip><Chip>lock waits: {d.innodb.lockWaits}</Chip>
          <Chip>buffer pool свободно: {d.innodb.bufferPoolPages ? `${Math.round(((d.innodb.freeBuffers ?? 0) / d.innodb.bufferPoolPages) * 100)}%` : '—'}</Chip>
          {d.innodb.deadlockAt && <Chip>последний deadlock: {d.innodb.deadlockAt}</Chip>}
        </div>
        <Table cols={['CPU %', 'Процесс']} rows={d.topCpu.map(t => [String(t.cpu), `${t.user}: ${t.cmd}`])} right={[0]} />
        {d.innodb.deadlockText && <details className="mt-2"><summary className="cursor-pointer text-[var(--color-text-muted)]">Текст deadlock</summary><pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-[var(--color-bg-surface)] p-2 text-[10.5px]">{d.innodb.deadlockText}</pre></details>}
      </Block>
      {d.mysql.rows.length > 0 && (
        <Block title={`Активные SQL подробно (${d.mysql.rows.length})`} hint="Самые долгие первыми.">
          <Table cols={['с', 'Состояние', 'Запрос']} rows={d.mysql.rows.slice(0, 25).map(r => [String(r.seconds), r.state, <code key="q" className="break-all text-[11px]">{r.info.slice(0, 300)}</code>])} right={[0]} />
        </Block>
      )}
    </div>
  );
}
function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 min-w-0"><div className="font-semibold text-[var(--color-text)]">{title}</div>{hint && <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}{children}</div>;
}
function Muted({ children }: { children: React.ReactNode }) { return <div className="text-[var(--color-text-muted)]">{children}</div>; }
function Table({ cols, rows, right = [] }: { cols: string[]; rows: React.ReactNode[][]; right?: number[] }) {
  return (
    <div className="scroll-x max-h-[320px] overflow-y-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-[11.5px]">
        <thead className="sticky top-0 bg-[var(--color-bg-hover)] text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"><tr>{cols.map((c, i) => <th key={c} className={`px-2 py-1 ${right.includes(i) ? 'text-right' : 'text-left'}`}>{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-[var(--color-border)] align-top">{r.map((c, j) => <td key={j} className={`px-2 py-1 ${right.includes(j) ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ── Настройки: пороги и оповещения с описаниями ───────────────────────────────
function SettingsBlock({ settings }: { settings: Setting[] }) {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (v: { key: string; value: unknown }) => fetch('/api/settings/bitrix-diag', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) }).then(r => r.json()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['b24diag'] }),
  });
  const groups = [...new Set(settings.map(s => s.group_name))];
  return (
    <section className={cardCls}>
      <h2 className="mb-1 text-base font-bold text-[var(--color-text)]">Пороги и оповещения</h2>
      <p className="mb-3 text-[11px] text-[var(--color-text-muted)]">Уровень снимка — максимум по всем порогам. Сохраняется при потере фокуса поля. Получатели оповещений и рубильник — в функции «Мониторинг Битрикса» бота «Аналитик».</p>
      {groups.map(g => (
        <div key={g} className="mb-3">
          <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-[var(--color-text-muted)]">{g}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {settings.filter(s => s.group_name === g).map(s => (
              <div key={s.key} className="rounded-xl border border-[var(--color-border)] p-3 flex items-start gap-3">
                <div className="min-w-0 flex-1"><div className="text-sm font-semibold text-[var(--color-text)]">{s.title}</div>{s.description && <div className="text-[11px] leading-snug text-[var(--color-text-muted)]">{s.description}</div>}</div>
                {typeof s.value === 'boolean'
                  ? <input type="checkbox" defaultChecked={s.value} onChange={e => patch.mutate({ key: s.key, value: e.target.checked })} className="mt-1 h-5 w-5 accent-[var(--color-accent)]" />
                  : <input type="number" inputMode="decimal" defaultValue={String(s.value)} onBlur={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v !== Number(s.value)) patch.mutate({ key: s.key, value: v }); }}
                      className="w-24 h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-right text-base tabular-nums text-[var(--color-text)]" />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
