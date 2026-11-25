'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Play } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  IDLE_WATCH_RECIPIENTS, RECIPIENT_LABELS, TEMPLATE_PLACEHOLDERS, formatIdle,
  type IdleWatchDeliveryDto, type IdleWatchRecipient, type IdleWatchRuleDto,
  type IdleWatchSettingsDto, type IdleWatchSimulationDto,
} from './shared';

// «Большой брат» → «Сторож»: настройки сторожа МОПов (вкл/dry-run/окно/зеркало), редактор правил
// эскалации, прогон «что было бы» по дню и журнал последних срабатываний. API — /api/big-brother/watch/*.

const HOUR_OPTIONS = Array.from({ length: 25 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));
const RECIPIENT_OPTIONS = IDLE_WATCH_RECIPIENTS.map((r) => ({ value: r, label: RECIPIENT_LABELS[r] }));

const card = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 sm:p-4';
const input = 'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-base sm:text-sm text-[var(--color-text)] min-h-11 sm:min-h-9';
const btn = 'inline-flex min-h-11 sm:min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50';
const btnPrimary = `${btn} bg-[var(--color-accent)] text-white`;
const btnGhost = `${btn} border border-[var(--color-border)] text-[var(--color-text)]`;

function fmtMsk(iso: string | null, withDate = true): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit',
    ...(withDate ? { day: '2-digit', month: '2-digit' } : {}),
  });
}

function mskToday(): string {
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${r.status}`);
  return j as T;
}

export function IdleWatchSettings() {
  const [settings, setSettings] = useState<IdleWatchSettingsDto | null>(null);
  const [rules, setRules] = useState<IdleWatchRuleDto[]>([]);
  const [log, setLog] = useState<IdleWatchDeliveryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await api<{ settings: IdleWatchSettingsDto; rules: IdleWatchRuleDto[]; deliveries: IdleWatchDeliveryDto[] }>('/api/big-brother/watch');
      setSettings(j.settings); setRules(j.rules); setLog(j.deliveries); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flash = (t: string) => { setSaved(t); setTimeout(() => setSaved(null), 2500); };

  const saveSettings = async (patch: Partial<IdleWatchSettingsDto>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      await api('/api/big-brother/watch', { method: 'PUT', body: JSON.stringify(patch) });
      flash('Сохранено');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); void load(); }
  };

  const addRule = async () => {
    const maxMin = rules.reduce((m, r) => Math.max(m, r.minutesIdle), 60);
    try {
      await api('/api/big-brother/watch/rules', {
        method: 'POST',
        body: JSON.stringify({ name: `${formatIdle(maxMin + 60)} тишины — директору отдела`, minutesIdle: Math.min(720, maxMin + 60),
          recipient: 'department_director', template: '{manager_name} ({department}): за последние {hours} (с {since}) нет звонков, движения сделок и задач.' }),
      });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  if (error && !settings) {
    return <div className={`${card} text-sm text-[var(--color-error)]`}>Не загрузилось: {error}</div>;
  }
  if (!settings) return <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-sm text-[var(--color-text-muted)]">
        Бот «Аналитик» пишет, если менеджер сегодня в работе (была новая сделка, движение сделок, звонок, задача или
        действие в Монолитике), но в рабочем окне долго нет ни одного сигнала. Только рабочие дни по производственному
        календарю. Менеджер без единого сигнала за день — сторож молчит (вероятно, отсутствует).
      </p>
      {error && <div className="text-sm text-[var(--color-error)]">{error}</div>}

      {/* Общие настройки */}
      <section className={`${card} flex flex-col gap-3`}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
            <input type="checkbox" className="h-4 w-4" checked={settings.enabled} onChange={(e) => saveSettings({ enabled: e.target.checked })} />
            Сторож включён
          </label>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
            <input type="checkbox" className="h-4 w-4" checked={settings.dryRun} onChange={(e) => saveSettings({ dryRun: e.target.checked })} />
            Dry-run (получателям не отправлять, только журнал и зеркало)
          </label>
          {saved && <span className="text-xs text-[var(--color-success,#16a34a)]">{saved}</span>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Окно, начало (МСК)</span>
            <SearchSelect ariaLabel="Начало окна" options={HOUR_OPTIONS.slice(0, 24)} value={String(settings.windowStartHour)}
              onChange={(v) => saveSettings({ windowStartHour: Number(v) })} className="w-full" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Окно, конец (МСК)</span>
            <SearchSelect ariaLabel="Конец окна" options={HOUR_OPTIONS.slice(1)} value={String(settings.windowEndHour)}
              onChange={(v) => saveSettings({ windowEndHour: Number(v) })} className="w-full" />
          </div>
          <MirrorField value={settings.mirrorBitrixUserId} onSave={(v) => saveSettings({ mirrorBitrixUserId: v })} />
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          Последний тик: {fmtMsk(settings.lastTickAt)}{settings.lastTickSummary ? ` — ${settings.lastTickSummary}` : ''}.
          Звонки и задачи приходят с задержкой до 5–15 мин — тишину сторож считает только по уже доехавшим данным,
          поэтому сообщение приходит примерно на 15 мин позже порога.
        </p>
      </section>

      {/* Правила */}
      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Правила (эскалация — несколько правил с растущим порогом)</h2>
          <button type="button" onClick={addRule} className={btnGhost}><Plus size={16} /> Правило</button>
        </div>
        {rules.length === 0 && <div className={`${card} text-sm text-[var(--color-text-muted)]`}>Правил нет — сторож молчит.</div>}
        {rules.map((r) => <RuleCard key={r.id} rule={r} onChanged={load} onError={setError} />)}
        <p className="text-xs text-[var(--color-text-muted)]">
          Плейсхолдеры: {TEMPLATE_PLACEHOLDERS.map((p) => (
            <span key={p.key} title={p.hint} className="mr-2 whitespace-nowrap"><code>{`{${p.key}}`}</code></span>
          ))}
        </p>
      </section>

      <Simulation />

      {/* Журнал */}
      <section className="flex min-w-0 flex-col gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Последние срабатывания</h2>
        {log.length === 0 && <div className={`${card} text-sm text-[var(--color-text-muted)]`}>Срабатываний ещё не было.</div>}
        <div className="flex flex-col gap-2">
          {log.map((d) => (
            <div key={d.id} className={`${card} flex min-w-0 flex-col gap-1`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
                <span>{fmtMsk(d.sentAt)}</span>
                <b className="text-[var(--color-text)]">{d.managerName ?? d.managerBitrixUserId}</b>
                <span>тишина с {fmtMsk(d.silenceFrom, false)}, {formatIdle(d.minutesIdle)}</span>
                <span>→ {d.recipientName ?? '—'} ({RECIPIENT_LABELS[d.recipientKind as IdleWatchRecipient] ?? d.recipientKind})</span>
                {d.dryRun && <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5">dry-run</span>}
                {d.mirrored && <span className="rounded bg-[var(--color-bg)] px-1.5 py-0.5">зеркало</span>}
                {d.error && <span className="text-[var(--color-error)]">{d.error}</span>}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm text-[var(--color-text)]">{d.message}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function MirrorField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-[var(--color-text-muted)]">Дубль всех уведомлений (Bitrix ID, пусто — выкл)</span>
      <input className={input} inputMode="numeric" value={v} placeholder="например, 2098"
        onChange={(e) => setV(e.target.value.replace(/\D/g, ''))}
        onBlur={() => { if (v !== value) onSave(v); }} />
    </div>
  );
}

function RuleCard({ rule, onChanged, onError }: { rule: IdleWatchRuleDto; onChanged: () => Promise<void>; onError: (e: string) => void }) {
  const [draft, setDraft] = useState(rule);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  useEffect(() => setDraft(rule), [rule]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rule), [draft, rule]);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/big-brother/watch/rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: draft.name, minutesIdle: draft.minutesIdle, recipient: draft.recipient,
          fixedBitrixUserId: draft.recipient === 'fixed' ? draft.fixedBitrixUserId ?? '' : null,
          template: draft.template, isActive: draft.isActive, sortOrder: draft.sortOrder,
        }),
      });
      await onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    setAskDelete(false);
    try { await api(`/api/big-brother/watch/rules/${rule.id}`, { method: 'DELETE' }); await onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className={`${card} flex min-w-0 flex-col gap-3 ${draft.isActive ? '' : 'opacity-70'}`}>
      <div className="flex items-start gap-2">
        <label className="flex min-h-11 sm:min-h-9 cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} />
          <span className="sr-only">Активно</span>
        </label>
        <input className={`${input} font-medium`} value={draft.name} placeholder="Название" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <button type="button" onClick={() => setAskDelete(true)} aria-label="Удалить правило"
          className="tap-target flex min-h-11 sm:min-h-9 items-center px-2 text-[var(--color-text-muted)] hover:text-[var(--color-error)]">
          <Trash2 size={16} />
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Минут тишины ≥ ({formatIdle(draft.minutesIdle || 0)})</span>
          <input className={input} type="number" min={15} max={720} step={5} value={draft.minutesIdle}
            onChange={(e) => setDraft({ ...draft, minutesIdle: Number(e.target.value) })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Кому</span>
          <SearchSelect ariaLabel="Получатель" options={RECIPIENT_OPTIONS} value={draft.recipient} className="w-full"
            onChange={(v) => setDraft({ ...draft, recipient: v as IdleWatchRecipient })} />
        </div>
        {draft.recipient === 'fixed' && (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Bitrix ID получателя</span>
            <input className={input} inputMode="numeric" value={draft.fixedBitrixUserId ?? ''}
              onChange={(e) => setDraft({ ...draft, fixedBitrixUserId: e.target.value.replace(/\D/g, '') })} />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-xs text-[var(--color-text-muted)]">Текст сообщения</span>
        <textarea className={`${input} min-h-24`} rows={3} value={draft.template}
          onChange={(e) => setDraft({ ...draft, template: e.target.value })} />
      </div>
      <ConfirmDialog open={askDelete} title="Удалить правило?" tone="danger" confirmLabel="Удалить"
        description={`«${rule.name || formatIdle(rule.minutesIdle)}» — уже отправленные сообщения останутся в журнале.`}
        onConfirm={remove} onCancel={() => setAskDelete(false)} />
      {dirty && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={save} className={btnPrimary}>Сохранить</button>
          <button type="button" disabled={busy} onClick={() => setDraft(rule)} className={btnGhost}>Отменить</button>
        </div>
      )}
    </div>
  );
}

function Simulation() {
  const [date, setDate] = useState(mskToday());
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IdleWatchSimulationDto | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api<IdleWatchSimulationDto>(`/api/big-brother/watch/simulate?date=${date}`)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <section className={`${card} flex min-w-0 flex-col gap-3`}>
      <h2 className="text-sm font-semibold text-[var(--color-text)]">Прогон «что было бы» по дню</h2>
      <p className="text-xs text-[var(--color-text-muted)]">
        Текущие правила и окно на реальных сигналах выбранного дня. Ничего не записывает и не отправляет.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <input type="date" className={`${input} w-auto`} value={date} max={mskToday()} onChange={(e) => setDate(e.target.value)} />
        <button type="button" onClick={run} disabled={busy} className={btnPrimary}><Play size={14} /> {busy ? 'Считаю…' : 'Прогнать'}</button>
      </div>
      {err && <div className="text-sm text-[var(--color-error)]">{err}</div>}
      {res && !res.workingDay && <div className="text-sm text-[var(--color-text-muted)]">{res.date} — нерабочий день, сторож молчит.</div>}
      {res && res.workingDay && (
        <div className="flex min-w-0 flex-col gap-2 text-sm text-[var(--color-text)]">
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            <span>МОПов под наблюдением: <b>{res.watched}</b></span>
            <span>в работе: <b>{res.inWork}</b></span>
            <span>окон тишины: <b>{res.cases}</b> у <b>{res.managersWithCases}</b> чел.</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {res.byRule.map((r) => (
              <li key={r.ruleId}>«{r.name}» ({formatIdle(r.minutesIdle)}, {RECIPIENT_LABELS[r.recipient as IdleWatchRecipient] ?? r.recipient}): <b>{r.fired}</b></li>
            ))}
          </ul>
          {res.top.length > 0 && (
            <div className="scroll-x">
              <table className="w-full min-w-[320px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-[var(--color-text-muted)]">
                    <th className="py-1 pr-3 font-medium">Менеджер</th>
                    <th className="py-1 pr-3 font-medium">Окон</th>
                    <th className="py-1 font-medium">Самая долгая тишина</th>
                  </tr>
                </thead>
                <tbody>
                  {res.top.map((t) => (
                    <tr key={t.bitrixId} className="border-t border-[var(--color-border)]">
                      <td className="py-1 pr-3">{t.managerName}</td>
                      <td className="py-1 pr-3">{t.cases}</td>
                      <td className="py-1">{formatIdle(t.maxMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[var(--color-text-muted)]">
            Строк по источникам: {Object.entries(res.sourceRows).map(([k, v]) => `${k} ${v < 0 ? 'нет' : v}`).join(' · ')}
          </p>
        </div>
      )}
    </section>
  );
}
