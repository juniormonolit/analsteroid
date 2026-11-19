'use client';
// Настройки канбана логиста (canManageLogistKanban): очереди (проекты Битрикса «регион × товарная группа»),
// их состав (только из участников проекта — кнопка «обновить», ручных правок нет), SLA очереди и вкл/выкл;
// общие SLA, порог огонька и веса приоритета. API: GET/PUT /queues, POST /queues/seed, POST /queues/sync-members,
// PUT /settings. Боковая панель components/ui/Drawer (телефон — на весь экран).
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RefreshCw, Sprout } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type {
  LogistQueue, LogistSettings, NotifyRecipientsSettings, QueueMember, PriorityWeights, RobotMode, QueueUpsertBody, QueuesResponse, SeedQueuesResponse, SettingsBody, SyncMembersResponse,
} from '../engine/requests/contract';
import { lkFetch, postJson, putJson } from './api';
import { fmtDT } from './format';
import { INPUT } from './Offers';
import { VERDICT_LABEL, isQueueLogist, isRecipient, recipientVerdict } from '../engine/requests/recipients';

const WEIGHT_FIELDS: { key: keyof PriorityWeights; label: string; hint: string }[] = [
  { key: 'slaOverdue', label: 'SLA просрочен — разово', hint: 'очков сразу при просрочке' },
  { key: 'slaOverduePerHour', label: '+ за час просрочки', hint: 'очков за каждый рабочий час' },
  { key: 'slaOverdueCapHours', label: 'Предел часов просрочки', hint: 'дальше не растёт' },
  { key: 'slaHot', label: 'SLA горит — до', hint: 'линейно к дедлайну' },
  { key: 'amountPer100k', label: 'Сумма — за 100 тыс. ₽', hint: 'очков' },
  { key: 'amountMax', label: 'Сумма — не больше', hint: 'очков' },
  { key: 'deliverySoon', label: 'Поставка скоро — до', hint: 'очков' },
  { key: 'deliverySoonDays', label: '«Скоро» — за дней', hint: 'дней до даты поставки' },
  { key: 'waitingPerHour', label: 'Ожидание — за час', hint: 'с последнего события' },
  { key: 'waitingMax', label: 'Ожидание — не больше', hint: 'очков' },
  { key: 'perReturn', label: 'За каждый возврат', hint: 'очков' },
  { key: 'cheaper', label: '«Есть цена дешевле»', hint: 'заказчик с ценой конкурента' },
];

export function SettingsDrawer({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const q = useQuery<QueuesResponse>({ queryKey: ['logist-queues'], queryFn: () => lkFetch<QueuesResponse>('/api/logist-kanban/queues') });
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ text: await fn(), bad: false }); await qc.invalidateQueries({ queryKey: ['logist-queues'] }); onChanged(); }
    catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Не получилось', bad: true }); }
    finally { setBusy(null); }
  };
  const seed = () => run('seed', async () => {
    const r = await postJson<SeedQueuesResponse>('/api/logist-kanban/queues/seed');
    return `Очереди из ${r.source}: новых ${r.inserted}, обновлено ${r.updated}, всего ${r.total}.`;
  });
  const sync = () => run('sync', async () => {
    const r = await postJson<SyncMembersResponse>('/api/logist-kanban/queues/sync-members');
    if (r.skipped) return 'Синхронизация уже идёт — обновите через минуту.';
    return `Состав обновлён: очередей ${r.synced} из ${r.queues}, участников ${r.members}${r.inactiveSkipped ? `, неактивных пропущено ${r.inactiveSkipped}` : ''}${r.failed.length ? `. Не прочитаны: ${r.failed.map(f => f.name).join(', ')}` : ''}.`;
  });

  return (
    <Drawer open onOpenChange={o => { if (!o) onClose(); }} title="Настройки канбана логиста" desktopWidth="sm:max-w-2xl">
      <div className="flex min-w-0 flex-col gap-4 text-[13px] text-[var(--color-text)]">
        {q.error && <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>}
        {q.data && <SettingsForm initial={q.data.settings} onSaved={() => { void qc.invalidateQueries({ queryKey: ['logist-queues'] }); onChanged(); }} />}
        {q.data && <NotifyForm notify={q.data.settings.notify} queues={q.data.queues} onSaved={() => void qc.invalidateQueries({ queryKey: ['logist-queues'] })} />}

        <section className="flex min-w-0 flex-col gap-2">
          <h3 className="text-sm font-semibold">Очереди ({q.data?.queues.length ?? '…'})</h3>
          <p className="text-[12px] text-[var(--color-text-muted)]">
            Очередь — проект Битрикса «регион × товарная группа». Состав — участники проекта (обновляется сам раз в 6 часов);
            чтобы добавить или убрать логиста, поправьте участников проекта в Битриксе и нажмите «Обновить состав».
          </p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <button type="button" onClick={seed} disabled={!!busy}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
              title="Создать/обновить очереди по проектам Панели снабжения">
              <Sprout size={15} aria-hidden /> {busy === 'seed' ? 'Сею…' : 'Посеять очереди'}
            </button>
            <button type="button" onClick={sync} disabled={!!busy}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
              title="Прочитать участников проектов Битрикса">
              <RefreshCw size={15} className={busy === 'sync' ? 'animate-spin' : ''} aria-hidden /> {busy === 'sync' ? 'Обновляю…' : 'Обновить состав из Битрикса'}
            </button>
          </div>
          {msg && <p role={msg.bad ? 'alert' : 'status'} className={`text-[12.5px] ${msg.bad ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{msg.text}</p>}
          {q.isLoading && <p className="text-[var(--color-text-muted)]">Загружаю…</p>}
          {q.data && q.data.queues.length === 0 && <p className="text-[var(--color-text-muted)]">Очередей нет — нажмите «Посеять очереди».</p>}
          <div className="flex min-w-0 flex-col gap-1.5">
            {q.data?.queues.map(queue => <QueueRow key={queue.id} queue={queue} defaultSla={q.data.settings.slaHours} notify={q.data.settings.notify}
              onSaved={() => void qc.invalidateQueries({ queryKey: ['logist-queues'] })} />)}
          </div>
        </section>
      </div>
    </Drawer>
  );
}

const numOr = (v: string, d: number) => { const x = Number(v.replace(',', '.')); return v.trim() !== '' && Number.isFinite(x) && x >= 0 ? x : d; };

function SettingsForm({ initial, onSaved }: { initial: LogistSettings; onSaved: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setDraft({}); }, [initial]);
  const val = (k: string, d: number) => draft[k] ?? String(d);
  const dirty = Object.keys(draft).length > 0;
  const save = async () => {
    const weights: Partial<PriorityWeights> = {};
    for (const f of WEIGHT_FIELDS) if (`w.${f.key}` in draft) weights[f.key] = numOr(draft[`w.${f.key}`], initial.weights[f.key]);
    const body: SettingsBody = {
      ...('slaHours' in draft ? { slaHours: numOr(draft.slaHours, initial.slaHours) } : {}),
      ...('slaHotHours' in draft ? { slaHotHours: numOr(draft.slaHotHours, initial.slaHotHours) } : {}),
      ...('hotScore' in draft ? { hotScore: numOr(draft.hotScore, initial.hotScore) } : {}),
      ...('robotMode' in draft ? { robotMode: draft.robotMode as RobotMode } : {}),
      ...(Object.keys(weights).length ? { weights } : {}),
    };
    setBusy(true); setMsg(null);
    try { await putJson<LogistSettings>('/api/logist-kanban/settings', body); setMsg({ text: 'Сохранено — приоритеты пересчитаются при обновлении доски', bad: false }); onSaved(); }
    catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Не сохранилось', bad: true }); }
    finally { setBusy(false); }
  };
  const field = (k: string, label: string, d: number, hint?: string) => (
    <label key={k} className="flex min-w-0 flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
      <span className="truncate" title={hint}>{label}</span>
      <input value={val(k, d)} onChange={e => setDraft(x => ({ ...x, [k]: e.target.value }))} inputMode="decimal" className={`${INPUT} tabular-nums`} />
    </label>
  );
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold">Робот на стадиях сделки</h3>
      <label className="flex min-w-0 flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
        Сделка ушла на «Сделал запрос снабженцу» / «Есть цена дешевле» — что делать
        <SearchSelect ariaLabel="Режим робота" value={draft.robotMode ?? initial.robotMode ?? 'send'}
          onChange={v => setDraft(x => ({ ...x, robotMode: v }))}
          options={[
            { value: 'send', label: 'Сразу в «Новые» (как бизнес-процесс сейчас)', hint: 'не прошли проверки — черновик менеджеру' },
            { value: 'draft', label: 'Черновик — менеджер дополняет и отправляет', hint: 'ссылка на форму от бота «Аналитик»' },
          ]}
          className="min-h-11 w-full min-w-0 justify-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm text-[var(--color-text)]" />
      </label>
      <h3 className="mt-2 text-sm font-semibold">SLA и огонёк</h3>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        {field('slaHours', 'SLA цикла, раб. ч', initial.slaHours, 'по умолчанию; очередь может переопределить')}
        {field('slaHotHours', '«Горит» за, раб. ч', initial.slaHotHours, 'до дедлайна осталось не больше')}
        {field('hotScore', 'Огонёк от, очков', initial.hotScore, 'карточка с огоньком при приоритете не меньше')}
      </div>
      <details className="group min-w-0 rounded-lg border border-[var(--color-border)] p-2">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-medium">
          <ChevronDown size={15} className="transition-transform group-open:rotate-180" aria-hidden /> Веса приоритета
        </summary>
        <div className="grid min-w-0 grid-cols-1 gap-2 pt-2 sm:grid-cols-2">
          {WEIGHT_FIELDS.map(f => field(`w.${f.key}`, f.label, initial.weights[f.key], f.hint))}
        </div>
      </details>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" disabled={!dirty || busy} onClick={save} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>
        {dirty && <button type="button" onClick={() => setDraft({})} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отменить правки</button>}
        {msg && <span role={msg.bad ? 'alert' : 'status'} className={`text-[12.5px] ${msg.bad ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{msg.text}</span>}
      </div>
    </section>
  );
}

// ── S5: кому слать «новый запрос» / «горит SLA» ─────────────────────────────────────────

const saveNotify = (notify: NotifyRecipientsSettings) => putJson<LogistSettings>('/api/logist-kanban/settings', { notify } satisfies SettingsBody);

/** Участник: включить/исключить из рассылки вручную (видимость и «Взять» не меняются). */
function toggledNotify(n: NotifyRecipientsSettings, m: QueueMember): NotifyRecipientsSettings {
  const on = isRecipient(recipientVerdict(m, n));
  const inc = n.includeBitrixIds.filter(x => x !== m.bitrixId), exc = n.excludeBitrixIds.filter(x => x !== m.bitrixId);
  if (on) return { ...n, includeBitrixIds: inc, excludeBitrixIds: [...exc, m.bitrixId] };
  return { ...n, includeBitrixIds: [...inc, m.bitrixId], excludeBitrixIds: exc };
}

function NotifyForm({ notify, queues, onSaved }: { notify: NotifyRecipientsSettings; queues: LogistQueue[]; onSaved: () => void }) {
  const [text, setText] = useState(notify.positionPatterns.join(', '));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  useEffect(() => { setText(notify.positionPatterns.join(', ')); }, [notify.positionPatterns]);
  const people = useMemo(() => {
    const m = new Map<string, QueueMember>();
    for (const q of queues) if (q.active) for (const x of q.members) m.set(x.bitrixId, x);
    return [...m.values()];
  }, [queues]);
  const on = people.filter(p => isQueueLogist(p, notify)).length;
  const dirty = text !== notify.positionPatterns.join(', ');
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await saveNotify({ ...notify, positionPatterns: text.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) });
      setMsg({ text: 'Сохранено', bad: false }); onSaved();
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : 'Не сохранилось', bad: true }); }
    finally { setBusy(false); }
  };
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-semibold">Кто логист очереди</h3>
      <p className="text-[12px] text-[var(--color-text-muted)]">
        В проектах Битрикса кроме логистов есть руководители, РОПы, разработчики, служебные аккаунты. Логист очереди — участник проекта,
        у которого в должности есть одно из слов ниже (без учёта регистра, ё = е), плюс включённые вручную (кнопка у человека в списке
        участников очереди — для пустой или нестандартной должности). Только логисты видят запросы очереди, берут их и получают от бота
        «новый запрос» и «горит SLA». Сейчас логистов {on} из {people.length} участников активных очередей.
      </p>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 basis-64 flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">
          Слова в должности (через запятую; пусто — логисты все участники, кроме исключённых)
          <input value={text} onChange={e => setText(e.target.value)} placeholder="логист, снабж" className={INPUT} />
        </label>
        {dirty && <button type="button" disabled={busy} onClick={save} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить'}</button>}
      </div>
      {(notify.includeBitrixIds.length > 0 || notify.excludeBitrixIds.length > 0) && (
        <p className="text-[12px] text-[var(--color-text-secondary)]">Вручную: включено {notify.includeBitrixIds.length}, исключено {notify.excludeBitrixIds.length}.</p>
      )}
      {msg && <p role={msg.bad ? 'alert' : 'status'} className={`text-[12.5px] ${msg.bad ? 'text-[var(--color-negative)]' : 'text-[var(--color-positive)]'}`}>{msg.text}</p>}
    </section>
  );
}

function QueueRow({ queue: q, defaultSla, notify, onSaved }: { queue: LogistQueue; defaultSla: number; notify: NotifyRecipientsSettings; onSaved: () => void }) {
  const [toggling, setToggling] = useState<string | null>(null);
  const toggleNotify = async (m: QueueMember) => {
    setToggling(m.bitrixId); setErr(null);
    try { await saveNotify(toggledNotify(notify, m)); onSaved(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Не сохранилось'); }
    finally { setToggling(null); }
  };
  const [open, setOpen] = useState(false);
  const [sla, setSla] = useState(q.slaHours != null ? String(q.slaHours) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setSla(q.slaHours != null ? String(q.slaHours) : ''); }, [q.slaHours]);
  const logists = useMemo(() => q.members.filter(m => isQueueLogist(m, notify)), [q.members, notify]);
  const save = async (patch: Partial<QueueUpsertBody>) => {
    setBusy(true); setErr(null);
    try {
      await putJson('/api/logist-kanban/queues', {
        id: q.id, groupId: q.groupId, name: q.name, region: q.region, dept: q.dept, productGroups: q.productGroups,
        slaHours: q.slaHours, active: q.active, sort: q.sort, ...patch,
      } satisfies QueueUpsertBody);
      onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Не сохранилось'); }
    finally { setBusy(false); }
  };
  const slaDirty = sla !== (q.slaHours != null ? String(q.slaHours) : '');
  return (
    <div className={`min-w-0 rounded-lg border border-[var(--color-border)] ${q.active ? '' : 'opacity-60'}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex min-h-11 w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--color-bg-hover)]">
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{q.name}</span>
          <span className="block truncate text-[11.5px] text-[var(--color-text-muted)]">
            {[q.region, q.dept].filter(Boolean).join(' · ') || 'регион не задан'} · логистов {logists.length} · SLA {q.slaHours ?? defaultSla} ч{q.active ? '' : ' · выключена'}
          </span>
        </span>
        {q.membersSyncError && <span className="shrink-0 text-[11px] text-[var(--color-negative)]" title={q.membersSyncError}>ошибка синка</span>}
      </button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--color-border)] p-2.5">
          {q.productGroups.length > 0 && <p className="text-[12px] text-[var(--color-text-secondary)]">Товарные группы: {q.productGroups.join(', ')}</p>}
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11.5px] text-[var(--color-text-muted)]">
              Состав из проекта Битрикса № {q.groupId}{q.membersSyncedAt ? ` · обновлён ${fmtDT(q.membersSyncedAt)}` : ' · ещё не синхронизирован'}
            </span>
            {q.membersSyncError && <span className="text-[12px] text-[var(--color-negative)]">{q.membersSyncError}</span>}
            {q.members.length === 0 ? <span className="text-[12px] text-[var(--color-text-muted)]">участников нет</span> : (
              <ul className="flex min-w-0 flex-col gap-0.5 text-[12.5px]">
                {q.members.map(m => {
                  const v = recipientVerdict(m, notify);
                  const recv = isRecipient(v);
                  return (
                    <li key={m.bitrixId} className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {m.name ?? `id ${m.bitrixId}`}
                        <span className="text-[var(--color-text-muted)]">{m.workPosition ? ` · ${m.workPosition}` : ' · должность не указана'}{m.role === 'lead' ? ' · руководитель' : ''}</span>
                      </span>
                      <button type="button" disabled={toggling === m.bitrixId} onClick={() => void toggleNotify(m)}
                        title={`${VERDICT_LABEL[v]}. Нажмите, чтобы ${recv ? 'исключить из логистов очереди' : 'сделать логистом очереди'}.`}
                        className={`tap-target min-h-9 shrink-0 rounded-md border px-2 text-[11.5px] disabled:opacity-50 ${recv ? 'border-[var(--color-positive)] text-[var(--color-positive)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
                        {recv ? '✓ логист' : 'не логист'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <label className="flex w-40 min-w-0 flex-col gap-1 text-[12px] text-[var(--color-text-muted)]">SLA очереди, раб. ч
              <input value={sla} onChange={e => setSla(e.target.value)} inputMode="decimal" placeholder={`по умолчанию ${defaultSla}`} className={`${INPUT} tabular-nums`} />
            </label>
            {slaDirty && (
              <button type="button" disabled={busy} onClick={() => void save({ slaHours: sla.trim() ? numOr(sla, defaultSla) : null })}
                className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm text-white disabled:opacity-50">Сохранить SLA</button>
            )}
            <button type="button" disabled={busy} onClick={() => void save({ active: !q.active })}
              className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
              {q.active ? 'Выключить очередь' : 'Включить очередь'}
            </button>
          </div>
          {err && <p role="alert" className="text-[12px] text-[var(--color-negative)]">{err}</p>}
        </div>
      )}
    </div>
  );
}
