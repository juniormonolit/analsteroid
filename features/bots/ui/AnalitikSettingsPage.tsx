'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Bot, Plus, Send, Trash2, X, Power, ShieldAlert, MessageSquareText, Inbox, CalendarClock, ToggleLeft, CloudSun, FlaskConical } from 'lucide-react';
import { useUrlState, enumParam } from '@/lib/hooks/useUrlState';
import { OutboundLogBlock } from '@/features/badges/ui/OutboundLog';
import { DigestSettingsBlock } from '@/features/badges/ui/DigestSettings';
import { FeedbackQueueBlock } from '@/features/badges/ui/FeedbackQueue';
import Link from 'next/link';

// Настройки бота «Аналитик» (задача владельца 09.09): каждая ФУНКЦИЯ бота —
// отдельный рубильник + свои настройки (получатели/час), и блок расписаний
// авторассылки сохранённых отчётов «Мой отчёт». Всё после миграции 181 выключено —
// владелец включает руками, поэтому экран обязан отвечать на вопрос «почему я не
// получаю уведомления» с первого взгляда: выключенное подписано словами.

interface BotFunction {
  key: string; name: string; description: string; bot: string; group: string;
  enabled: boolean; config: { recipients?: string[]; hour?: number };
  updatedAt: string | null; updatedBy: string | null;
}
interface Recipient { bitrixId: string; name: string; login: string }
interface TemplateOpt { id: string; name: string; ownerLogin: string; ownerName: string; summary: string }
interface Schedule {
  id: string; templateId: string; templateName: string | null; ownerLogin: string; ownerName: string | null;
  recipientBitrixId: string; recipientName: string | null; sendTime: string; weekdays: number[];
  enabled: boolean; lastSentAt: string | null; lastError: string | null; createdBy: string | null;
}

const WEEKDAYS: { n: number; label: string }[] = [
  { n: 1, label: 'Пн' }, { n: 2, label: 'Вт' }, { n: 3, label: 'Ср' }, { n: 4, label: 'Чт' },
  { n: 5, label: 'Пт' }, { n: 6, label: 'Сб' }, { n: 7, label: 'Вс' },
];

const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── Панель ───────────────────────────────────────────────────────────────────
// Вкладка — в адресе (правило адресуемости DESIGN_GUIDELINES): ссылку на «Журнал»
// можно прислать, «назад» возвращает на предыдущую вкладку.
const TABS = ['functions', 'digest', 'schedules', 'journal', 'weather'] as const;
type Tab = (typeof TABS)[number];
const TAB_META: Record<Tab, { label: string; Icon: typeof Bot }> = {
  functions: { label: 'Функции', Icon: ToggleLeft },
  digest:    { label: 'Дайджест', Icon: MessageSquareText },
  schedules: { label: 'Расписания', Icon: CalendarClock },
  journal:   { label: 'Журнал', Icon: MessageSquareText },
  weather:   { label: 'Погода', Icon: CloudSun },
};

interface MasterState { killed: boolean; killedAt: string | null; killedBy: string | null; dryRunManagers: boolean; envOverride: boolean }

export function AnalitikSettingsPage() {
  const [tab, setTab] = useUrlState<Tab>('tab', { ...enumParam(TABS, 'functions'), mode: 'push' });
  return (
    <div className="p-3 sm:p-6 max-w-5xl flex flex-col gap-5">
      <MasterPanel />
      <nav className="flex gap-1 border-b border-[var(--color-border)] overflow-x-auto scrollbar-none">
        {TABS.map(t => {
          const { label, Icon } = TAB_META[t];
          const active = tab === t;
          return (
            <button key={t} data-tab-key={t} onClick={() => setTab(t)}
              className={`min-h-11 shrink-0 inline-flex items-center gap-1.5 px-3 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${active
                ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-semibold'
                : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
              <Icon size={15} /> {label}
            </button>
          );
        })}
      </nav>
      {tab === 'functions' && <FunctionsBlock />}
      {tab === 'digest' && (
        <div className="flex flex-col gap-4">
          <div className="text-[12px] text-[var(--color-text-muted)]">
            Глобальные настройки дайджеста менеджерам и скоринг подсказок «кому звонить» (переехали из
            «Геймификации»). Персональные подписки сотрудников — в{' '}
            <Link href="/settings/subscriptions" className="text-[var(--color-accent)] hover:underline">Подписках сотрудников</Link>.
          </div>
          <DigestSettingsBlock />
        </div>
      )}
      {tab === 'schedules' && <SchedulesBlock />}
      {tab === 'journal' && <JournalTab />}
      {tab === 'weather' && <WeatherResponsiblesBlock />}
    </div>
  );
}

// Шапка панели: статус одним взглядом + общий рубильник + тест-режим.
function MasterPanel() {
  const qc = useQueryClient();
  const { data: master } = useQuery<MasterState>({
    queryKey: ['bot-master'],
    queryFn: () => fetch('/api/settings/bots/master').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: fns } = useQuery<{ functions: BotFunction[] }>({
    queryKey: ['bot-functions'],
    queryFn: () => fetch('/api/settings/bots/channels').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const patch = useMutation({
    mutationFn: (body: Partial<Pick<MasterState, 'killed' | 'dryRunManagers'>>) =>
      fetch('/api/settings/bots/master', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(jsonOrThrow),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['bot-master'] }); void qc.invalidateQueries({ queryKey: ['bot-functions'] }); },
  });
  const killed = master?.killed ?? false;
  const on = fns?.functions.filter(f => f.enabled).length ?? 0;
  const total = fns?.functions.length ?? 0;

  return (
    <section className={`rounded-2xl border p-4 sm:p-5 ${killed
      ? 'border-[var(--color-negative)] bg-[color-mix(in_srgb,var(--color-negative)_8%,var(--color-bg-surface))]'
      : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Bot size={20} className={killed ? 'text-[var(--color-negative)]' : 'text-[var(--color-accent)]'} />
            <h1 className="text-lg font-semibold text-[var(--color-text)]">Бот «Аналитик»</h1>
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${killed
              ? 'bg-[var(--color-negative)] text-white'
              : on > 0 ? 'bg-[var(--color-positive)] text-white' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>
              {killed ? 'ВЫРУБЛЕН' : on > 0 ? `работает · ${on} из ${total}` : `молчит · 0 из ${total}`}
            </span>
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">
            {killed
              ? `Все отправки остановлены${master?.killedBy ? ` — ${master.killedBy}` : ''}${master?.killedAt ? `, ${new Date(master.killedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}. Функции и расписания сохранены и заработают, когда бота включат обратно.`
              : 'Что бот отправляет и кому — по функциям. Выключенная функция считается и пишется в журнал, но в Битрикс не уходит; включение задним числом ничего не досылает.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            {master?.envOverride && (
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-negative)] px-2 py-0.5 text-[var(--color-negative)]">
                <ShieldAlert size={12} /> на сервере BOT_SEND_ENABLED=1 — функции не решают, решает только «Вырубить»
              </span>
            )}
            <label className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] cursor-pointer" title="Сообщения менеджерам (дайджесты, награды) считаются и пишутся в журнал исходящих, но не отправляются. Раньше этот флаг был скрыт и включён по умолчанию.">
              <input type="checkbox" checked={master?.dryRunManagers ?? true} onChange={e => patch.mutate({ dryRunManagers: e.target.checked })} className="tap-target h-3.5 w-3.5 accent-[var(--color-accent)]" />
              <FlaskConical size={12} /> тест-режим сообщений менеджерам {master?.dryRunManagers ? '— ВКЛЮЧЁН (в Битрикс не уходит)' : '— выключен'}
            </label>
          </div>
        </div>
        <div className="shrink-0">
          {killed ? (
            <button onClick={() => patch.mutate({ killed: false })} disabled={patch.isPending}
              className="min-h-11 inline-flex items-center gap-2 rounded-xl bg-[var(--color-positive)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              <Power size={16} /> Включить бота
            </button>
          ) : (
            <button onClick={() => { if (confirm('Вырубить бота? Остановятся ВСЕ отправки «Аналитика» — отчёты, дайджесты, приглашения, всё. Функции и расписания сохранятся.')) patch.mutate({ killed: true }); }}
              disabled={patch.isPending}
              className="min-h-11 inline-flex items-center gap-2 rounded-xl bg-[var(--color-negative)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-40">
              <Power size={16} /> Вырубить бота
            </button>
          )}
        </div>
      </div>
      {patch.isError && <div className="mt-2 text-xs text-[var(--color-negative)]">{(patch.error as Error).message}</div>}
    </section>
  );
}

// ── Журнал: входящие (что пишут люди) + исходящие ────────────────────────────
interface InboundItem { id: string; bitrixId: number; name: string | null; event: string; text: string | null; handledBy: string; replyTo: string | null; createdAt: string }
const HANDLED_LABEL: Record<string, string> = {
  deal_chat: 'чат по сделке', weather: 'ответ про погоду', feedback: 'кнопка под сообщением',
  bind_deal: 'кнопка «к сделке»', unhandled: 'без обработчика',
};
function JournalTab() {
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<{ items: InboundItem[] }>({
    queryKey: ['bot-inbound', q],
    queryFn: () => fetch(`/api/settings/bots/inbound?q=${encodeURIComponent(q)}`).then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  return (
    <div className="flex flex-col gap-5">
      <section className={cardCls}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><Inbox size={16} /> Входящие — что пишут боту</h2>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск по тексту или человеку…" className={`${inputCls} sm:w-72`} />
        </div>
        <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
          Каждое сообщение и клик по кнопке в личке бота — с пометкой, какой обработчик его забрал. «Без обработчика» —
          человек написал боту, а бот не понял: это и есть то, что стоит читать глазами.
        </p>
        {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>
          : !data || data.items.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Пока пусто — журнал ведётся с момента выкатки панели.</div>
          : (
            <div className="flex flex-col divide-y divide-[var(--color-border)]">
              {data.items.map(it => (
                <div key={it.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
                  <span className="shrink-0 text-[11px] text-[var(--color-text-muted)] tabular-nums sm:w-28">
                    {new Date(it.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  <span className="shrink-0 text-sm font-semibold text-[var(--color-text)] sm:w-44 truncate" title={`#${it.bitrixId}`}>{it.name ?? `#${it.bitrixId}`}</span>
                  <span className="min-w-0 flex-1 text-sm text-[var(--color-text)] whitespace-pre-wrap break-words">{it.text ?? '—'}</span>
                  <span className={`shrink-0 self-start rounded-md px-2 py-0.5 text-[11px] ${it.handledBy === 'unhandled'
                    ? 'bg-[color-mix(in_srgb,var(--color-warning)_18%,transparent)] text-[var(--color-warning)]'
                    : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'}`}>
                    {HANDLED_LABEL[it.handledBy] ?? it.handledBy}
                  </span>
                </div>
              ))}
            </div>
          )}
      </section>
      {/* Исходящие — готовый журнал из раздела наград (bot_outbound_log): тот же
          компонент, чтобы не было двух разных чтений одной таблицы. */}
      <OutboundLogBlock />
      {/* Очередь «Ошибка»/«Полезно» по сообщениям бота — тоже ответы людей боту. */}
      <FeedbackQueueBlock />
    </div>
  );
}

// ── Функции бота ─────────────────────────────────────────────────────────────
function FunctionsBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<{ functions: BotFunction[]; envOverride: boolean; error?: string }>({
    queryKey: ['bot-functions'],
    queryFn: () => fetch('/api/settings/bots/channels').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: opts } = useQuery<{ recipients: Recipient[] }>({
    queryKey: ['bot-schedule-options'],
    queryFn: () => fetch('/api/settings/bots/report-schedules/options').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const patch = useMutation({
    mutationFn: (body: { key: string; enabled?: boolean; config?: BotFunction['config'] }) =>
      fetch('/api/settings/bots/channels', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(jsonOrThrow),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bot-functions'] }),
  });

  if (!data) return <section className={cardCls}><div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div></section>;
  const groups = [...new Set(data.functions.map(f => f.group))];
  const on = data.functions.filter(f => f.enabled).length;
  const recipientsById = new Map((opts?.recipients ?? []).map(r => [r.bitrixId, r]));

  return (
    <section className={cardCls}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><ToggleLeft size={16} /> Функции</h2>
        <span className="text-xs text-[var(--color-text-muted)]">включено {on} из {data.functions.length}</span>
      </div>
      {data.error && <div className="mb-3 text-xs text-[var(--color-text-muted)]">{data.error}</div>}
      <div className="flex flex-col gap-5">
        {groups.map(g => (
          <div key={g}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{g}</div>
            <div className="flex flex-col gap-2">
              {data.functions.filter(f => f.group === g).map(f => (
                <FunctionRow key={f.key} f={f} recipientsById={recipientsById} allRecipients={opts?.recipients ?? []}
                  onToggle={() => patch.mutate({ key: f.key, enabled: !f.enabled })}
                  onConfig={cfg => patch.mutate({ key: f.key, config: cfg })}
                  busy={patch.isPending} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {patch.isError && <div className="mt-2 text-xs text-[var(--color-negative)]">{(patch.error as Error).message}</div>}
    </section>
  );
}

function FunctionRow({ f, recipientsById, allRecipients, onToggle, onConfig, busy }: {
  f: BotFunction; recipientsById: Map<string, Recipient>; allRecipients: Recipient[];
  onToggle: () => void; onConfig: (cfg: BotFunction['config']) => void; busy: boolean;
}) {
  // Настройки есть только у функций, у которых они заведены в реестре (config не пуст).
  const hasRecipients = Array.isArray(f.config.recipients);
  const hasHour = typeof f.config.hour === 'number';
  const [editing, setEditing] = useState(false);
  const [recipients, setRecipients] = useState<string[]>(f.config.recipients ?? []);
  const [hour, setHour] = useState<string>(f.config.hour != null ? String(f.config.hour) : '');
  const [q, setQ] = useState('');
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allRecipients.filter(r => !recipients.includes(r.bitrixId) && (!needle || r.name.toLowerCase().includes(needle) || r.login.includes(needle))).slice(0, 8);
  }, [allRecipients, recipients, q]);

  return (
    <div className="rounded-xl border border-[var(--color-border)] p-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" checked={f.enabled} onChange={onToggle} disabled={busy}
          className="tap-target mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent)]" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-bold text-[var(--color-text)]">{f.name}</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><Bot size={11} /> {f.bot}</span>
            {!f.enabled && (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-text-muted)]"><BellOff size={11} /> выключено — не уходит в Битрикс</span>
            )}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--color-text-muted)]">{f.description}</span>
          {f.updatedBy && (
            <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
              менял {f.updatedBy}{f.updatedAt ? ` · ${new Date(f.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : ''}
            </span>
          )}
        </span>
      </label>

      {(hasRecipients || hasHour) && (
        <div className="mt-2 pl-7">
          {!editing ? (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              {hasRecipients && (
                <span className="text-[var(--color-text-muted)]">
                  Получатели: {recipients.length
                    ? recipients.map(id => recipientsById.get(id)?.name ?? `#${id}`).join(', ')
                    : <i>из настроек сервера (env)</i>}
                </span>
              )}
              {hasHour && <span className="text-[var(--color-text-muted)]">· {hour}:00 МСК</span>}
              <button onClick={() => setEditing(true)} className="tap-target text-[12px] text-[var(--color-accent)] hover:underline">настроить</button>
            </div>
          ) : (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 flex flex-col gap-3">
              {hasRecipients && (
                <div>
                  <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Получатели (пусто — получатель из настроек сервера)</div>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {recipients.map(id => (
                      <span key={id} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-1 text-[12px] text-[var(--color-text)]">
                        {recipientsById.get(id)?.name ?? `#${id}`}
                        <button onClick={() => setRecipients(r => r.filter(x => x !== id))} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><X size={12} /></button>
                      </span>
                    ))}
                  </div>
                  <input value={q} onChange={e => setQ(e.target.value)} placeholder="Найти сотрудника…" className={inputCls} />
                  {q && candidates.length > 0 && (
                    <div className="mt-1 flex flex-col rounded-lg border border-[var(--color-border)] overflow-hidden">
                      {candidates.map(r => (
                        <button key={r.bitrixId} onClick={() => { setRecipients(v => [...v, r.bitrixId]); setQ(''); }}
                          className="min-h-11 text-left px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                          {r.name} <span className="text-[var(--color-text-muted)] text-xs">@{r.login} · #{r.bitrixId}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {hasHour && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--color-text-muted)]">Час отправки (МСК)</span>
                  <input type="number" min={0} max={23} value={hour} onChange={e => setHour(e.target.value)} className={`${inputCls} w-20`} />
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={btnPrimaryCls} disabled={busy}
                  onClick={() => { onConfig({ ...(hasRecipients ? { recipients } : {}), ...(hasHour && hour !== '' ? { hour: Number(hour) } : {}) }); setEditing(false); }}>
                  Сохранить
                </button>
                <button className={btnCls} onClick={() => { setEditing(false); setRecipients(f.config.recipients ?? []); setHour(f.config.hour != null ? String(f.config.hour) : ''); }}>Отмена</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Опрос по погоде: кого спрашивать по городам ──────────────────────────────
// Раньше — отдельная страница /settings/bots/weather (правка владельца 09.09:
// «раздел „Опрос по погоде" можно засунуть внутрь Аналитика» — это функция того же
// бота, а не отдельный бот). Логика и API прежние (/api/settings/weather-responsibles).
const CITY_LABELS: Record<string, string> = { spb: 'Санкт-Петербург', msk: 'Москва', krd: 'Краснодар' };
interface WeatherResponsible { city: string; bitrixUserId: string; name: string | null }

function WeatherResponsiblesBlock() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ responsibles: WeatherResponsible[] }>({
    queryKey: ['weather-responsibles'],
    queryFn: () => fetch('/api/settings/weather-responsibles').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ city, id }: { city: string; id: string }) =>
      fetch('/api/settings/weather-responsibles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city, bitrixUserId: id }) }).then(jsonOrThrow),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['weather-responsibles'] }),
  });
  const byCity = new Map((data?.responsibles ?? []).map(r => [r.city, r]));
  return (
    <section className={cardCls}>
      <h2 className="text-base font-bold text-[var(--color-text)] mb-1 inline-flex items-center gap-2"><CloudSun size={16} /> Опрос по погоде — кого спрашивать</h2>
      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Каждый понедельник в 09:00 МСК «Аналитик» спрашивает этих людей «Как погодка на той неделе была?» —
        ответ попадает в отчёт «Данные по годам». Сам опрос включается функцией «Опрос погоды по понедельникам»
        выше. Указывается Bitrix ID; автосводка Open-Meteo добавляется независимо.
      </p>
      {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div> : (
        <div className="flex flex-col gap-2">
          {Object.keys(CITY_LABELS).map(city => {
            const cur = byCity.get(city);
            const val = draft[city] ?? cur?.bitrixUserId ?? '';
            return (
              <div key={city} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                <span className="w-40 text-sm font-semibold text-[var(--color-text)]">{CITY_LABELS[city]}</span>
                <input value={val} onChange={e => setDraft(d => ({ ...d, [city]: e.target.value }))} inputMode="numeric" placeholder="Bitrix ID"
                  className="w-28 min-h-11 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-base sm:text-sm text-right tabular-nums" />
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
                  {cur?.name ? `сейчас: ${cur.name} (#${cur.bitrixUserId})` : cur ? `сейчас: #${cur.bitrixUserId}` : 'не назначен — дефолт подберётся по имени при первом опросе'}
                </span>
                <button type="button" disabled={save.isPending || !/^\d{1,10}$/.test(val) || val === cur?.bitrixUserId} onClick={() => save.mutate({ city, id: val })}
                  className={btnPrimaryCls}>Сохранить</button>
              </div>
            );
          })}
          {save.isError && <div className="text-xs text-[var(--color-negative)]">{(save.error as Error).message}</div>}
        </div>
      )}
    </section>
  );
}

// ── Расписания авторассылки отчётов ──────────────────────────────────────────
function SchedulesBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<{ schedules: Schedule[] }>({
    queryKey: ['report-schedules'],
    queryFn: () => fetch('/api/settings/bots/report-schedules').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: opts } = useQuery<{ templates: TemplateOpt[]; recipients: Recipient[] }>({
    queryKey: ['bot-schedule-options'],
    queryFn: () => fetch('/api/settings/bots/report-schedules/options').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['report-schedules'] });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      fetch('/api/settings/bots/report-schedules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(jsonOrThrow),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => fetch(`/api/settings/bots/report-schedules?id=${id}`, { method: 'DELETE' }).then(jsonOrThrow),
    onSuccess: invalidate,
  });
  const sendNow = useMutation({
    mutationFn: (id: string) => fetch(`/api/settings/bots/report-schedules/${id}/send-now`, { method: 'POST' }).then(jsonOrThrow),
    onSuccess: invalidate,
  });
  const [adding, setAdding] = useState(false);

  return (
    <section className={cardCls}>
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><CalendarClock size={16} /> Расписания рассылки отчётов</h2>
          <span className="text-xs text-[var(--color-text-muted)]">{data ? `${data.schedules.length} шт.` : ''}</span>
        </div>
        {!adding && <button className={btnPrimaryCls} onClick={() => setAdding(true)}><Plus size={14} /> Добавить</button>}
      </div>
      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Сохранённый шаблон из «Моего отчёта» уходит получателю в личку в указанное время по отмеченным
        дням. Отчёт собирается от имени владельца шаблона — с его доступом и его «я». Работает только
        при включённой функции «Авторассылка сохранённых отчётов» выше; новое расписание создаётся выключенным.
      </p>

      {adding && opts && (
        <ScheduleForm templates={opts.templates} recipients={opts.recipients}
          onDone={() => { setAdding(false); invalidate(); }} onCancel={() => setAdding(false)} />
      )}

      {data && data.schedules.length === 0 && !adding && (
        <div className="text-sm text-[var(--color-text-muted)]">Расписаний пока нет.</div>
      )}
      <div className="flex flex-col gap-2 mt-2">
        {data?.schedules.map(s => (
          <div key={s.id} className="rounded-xl border border-[var(--color-border)] p-3">
            <div className="flex items-start gap-3">
              <input type="checkbox" checked={s.enabled} onChange={() => patch.mutate({ id: s.id, enabled: !s.enabled })}
                className="tap-target mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-[var(--color-accent)]" title={s.enabled ? 'Выключить' : 'Включить'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-bold text-[var(--color-text)]">{s.templateName ?? 'Шаблон удалён'}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">шаблон {s.ownerName ?? s.ownerLogin}</span>
                  {!s.enabled && <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><BellOff size={11} /> выключено</span>}
                </div>
                <div className="mt-0.5 text-[12px] text-[var(--color-text)]">
                  → {s.recipientName ?? `#${s.recipientBitrixId}`} · <b>{s.sendTime}</b> МСК ·{' '}
                  {WEEKDAYS.filter(w => s.weekdays.includes(w.n)).map(w => w.label).join(' ') || '—'}
                </div>
                <div className="mt-0.5 text-[10.5px] text-[var(--color-text-muted)]">
                  {s.lastSentAt ? `последняя отправка ${new Date(s.lastSentAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : 'ещё не отправлялось'}
                  {s.lastError && <span className="text-[var(--color-negative)]"> · ошибка: {s.lastError}</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => sendNow.mutate(s.id)} disabled={sendNow.isPending} title="Отправить сейчас"
                  className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"><Send size={15} /></button>
                <button onClick={() => { if (confirm('Удалить расписание?')) remove.mutate(s.id); }} title="Удалить"
                  className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><Trash2 size={15} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {(patch.isError || remove.isError || sendNow.isError) && (
        <div className="mt-2 text-xs text-[var(--color-negative)]">
          {((patch.error ?? remove.error ?? sendNow.error) as Error)?.message}
        </div>
      )}
      {sendNow.isSuccess && <div className="mt-2 text-xs text-[var(--color-positive)]">Отправлено.</div>}
    </section>
  );
}

function ScheduleForm({ templates, recipients, onDone, onCancel }: {
  templates: TemplateOpt[]; recipients: Recipient[]; onDone: () => void; onCancel: () => void;
}) {
  const [tq, setTq] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [rq, setRq] = useState('');
  const [recipient, setRecipient] = useState('');
  const [time, setTime] = useState('18:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);

  const tFiltered = useMemo(() => {
    const n = tq.trim().toLowerCase();
    return templates.filter(t => !n || t.name.toLowerCase().includes(n) || t.ownerName.toLowerCase().includes(n)).slice(0, 30);
  }, [templates, tq]);
  const rFiltered = useMemo(() => {
    const n = rq.trim().toLowerCase();
    return recipients.filter(r => !n || r.name.toLowerCase().includes(n) || r.login.includes(n)).slice(0, 30);
  }, [recipients, rq]);

  const create = useMutation({
    mutationFn: () => fetch('/api/settings/bots/report-schedules', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId, recipientBitrixId: recipient, sendTime: time, weekdays: days }),
    }).then(jsonOrThrow),
    onSuccess: onDone,
  });
  const chosenT = templates.find(t => t.id === templateId);
  const chosenR = recipients.find(r => r.bitrixId === recipient);

  return (
    <div className="rounded-xl border border-[var(--color-accent)] bg-[var(--color-bg)] p-3 flex flex-col gap-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Отчёт (из всех сохранённых шаблонов «Мой отчёт»)</div>
          {chosenT ? (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate"><b>{chosenT.name}</b> <span className="text-[var(--color-text-muted)] text-xs">· {chosenT.ownerName}</span></span>
              <button onClick={() => setTemplateId('')} className="tap-target text-[var(--color-text-muted)]"><X size={14} /></button>
            </div>
          ) : (
            <>
              <input value={tq} onChange={e => setTq(e.target.value)} placeholder="Поиск по названию или владельцу…" className={inputCls} autoFocus />
              <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                {tFiltered.length === 0 && <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">Ничего не найдено</div>}
                {tFiltered.map(t => (
                  <button key={t.id} onClick={() => setTemplateId(t.id)}
                    className="w-full min-h-11 text-left px-3 py-2 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)]">
                    <div className="text-sm text-[var(--color-text)]">{t.name}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{t.ownerName} · {t.summary}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div>
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Получатель</div>
          {chosenR ? (
            <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate"><b>{chosenR.name}</b> <span className="text-[var(--color-text-muted)] text-xs">@{chosenR.login}</span></span>
              <button onClick={() => setRecipient('')} className="tap-target text-[var(--color-text-muted)]"><X size={14} /></button>
            </div>
          ) : (
            <>
              <input value={rq} onChange={e => setRq(e.target.value)} placeholder="Поиск сотрудника…" className={inputCls} />
              <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)]">
                {rFiltered.map(r => (
                  <button key={r.bitrixId} onClick={() => setRecipient(r.bitrixId)}
                    className="w-full min-h-11 text-left px-3 py-2 border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--color-bg-hover)]">
                    <span className="text-sm text-[var(--color-text)]">{r.name}</span> <span className="text-[11px] text-[var(--color-text-muted)]">@{r.login}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Время (МСК)</div>
          <input type="time" value={time} onChange={e => setTime(e.target.value)} className={`${inputCls} w-32`} />
        </div>
        <div>
          <div className="text-[11px] text-[var(--color-text-muted)] mb-1">Дни недели</div>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map(w => {
              const on = days.includes(w.n);
              return (
                <button key={w.n} onClick={() => setDays(d => on ? d.filter(x => x !== w.n) : [...d, w.n].sort())}
                  className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm transition-colors ${on
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-text-inverse)]'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                  {w.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={btnPrimaryCls} disabled={!templateId || !recipient || days.length === 0 || create.isPending} onClick={() => create.mutate()}>
          Создать (выключенным)
        </button>
        <button className={btnCls} onClick={onCancel}>Отмена</button>
      </div>
      {create.isError && <div className="text-xs text-[var(--color-negative)]">{(create.error as Error).message}</div>}
    </div>
  );
}
