'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, Bot, Plus, Send, Trash2, X } from 'lucide-react';

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

export function AnalitikSettingsPage() {
  return (
    <div className="p-3 sm:p-6 max-w-4xl flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Бот «Аналитик»</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Что бот отправляет и кому. Каждая функция включается отдельно; выключенная — считается,
          пишется в журнал исходящих, но в Битрикс не уходит. Включение задним числом не рассылает
          пропущенное — только то, что случится дальше.
        </p>
      </div>
      <FunctionsBlock />
      <SchedulesBlock />
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
        <h2 className="text-base font-bold text-[var(--color-text)]">Функции</h2>
        <span className="text-xs text-[var(--color-text-muted)]">включено {on} из {data.functions.length}</span>
      </div>
      {data.error && <div className="mb-3 text-xs text-[var(--color-text-muted)]">{data.error}</div>}
      {data.envOverride && (
        <div className="mb-3 rounded-lg border border-[var(--color-negative)] p-2 text-xs text-[var(--color-negative)]">
          На сервере поднят аварийный тумблер <code>BOT_SEND_ENABLED=1</code> — шлётся ВСЁ, рубильники ниже сейчас ничего не решают.
        </div>
      )}
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
          <h2 className="text-base font-bold text-[var(--color-text)]">Расписания рассылки отчётов</h2>
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
