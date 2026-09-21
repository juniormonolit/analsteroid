'use client';
// Очереди по окну повторной продажи (задача владельца 17.09) — куски UI для
// «Моих заказчиков»: шапка метрик менеджера, ячейка «Окно», модалки «Связался»
// и «Исключить через РОПа», панель решений РОПа. Логика очередей — в
// features/customers/engine/customers.ts (assignQueue), тут только отображение.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import type { CustomerQueue } from '@/features/customers/engine/customers';
import { CONTACT_CHANNEL_LABELS, type ContactChannel, type ExclusionRequest } from '@/features/customers/engine/contactTypes';
import type { RepeatHeader, RepeatMonth } from '@/features/customers/engine/repeatHeader';
import { type ApiRow, fmtMoney, fmtDate, daysAgo, clientDisplayName } from './shared';

export const QUEUE_META: Record<CustomerQueue, { label: string; hint: string; tone: 'hot' | 'warn' | 'cold' | 'none' }> = {
  window: { label: 'Звонить сейчас', hint: 'Отгрузка была не больше 22 дней назад, и касание ТЕКУЩЕЙ недели ещё не сделано. Правило трёх касаний: по одному контакту на каждой из трёх недель окна — при равном числе звонков разнесение по неделям даёт +5,3 п.п. ППО. Сверху — то, что сгорает раньше, при равном сроке выше ожидаемые деньги (шанс × сумма следующей отгрузки).', tone: 'hot' },
  missed: { label: 'Окно упущено — так и не позвонили', hint: 'С отгрузки прошло больше 22 дней, контакта после неё не было. Порядок — по ожидаемым деньгам: шанс на повтор × ожидаемая сумма следующей отгрузки.', tone: 'warn' },
  faded: { label: 'Постоянники затихли', hint: 'Покупали 2+ раз, активных сделок нет, с последней отгрузки прошло больше их цикла повторки — связь была, а покупок нет. Шанс на следующую покупку у них 39–88 %, поэтому колонка стоит выше упущенных. Почему затихли?', tone: 'cold' },
  rest: { label: 'Остальные', hint: 'Касание этой недели уже сделано (вернутся на следующей), заказ в работе (продано, ждёт отгрузки), в работе по активным сделкам или разовые без сигнала.', tone: 'none' },
};
const TONE: Record<string, { color: string; bg: string }> = {
  hot: { color: 'var(--color-negative, #e03131)', bg: 'color-mix(in srgb, var(--color-negative, #e03131) 6%, transparent)' },
  warn: { color: 'var(--color-warning, #d9840c)', bg: 'color-mix(in srgb, var(--color-warning, #d9840c) 7%, transparent)' },
  cold: { color: 'var(--color-accent)', bg: 'color-mix(in srgb, var(--color-accent) 6%, transparent)' },
  none: { color: 'var(--color-text-muted)', bg: 'transparent' },
};
export function queueRowStyle(q: CustomerQueue): React.CSSProperties | undefined {
  return q === 'rest' ? undefined : { backgroundColor: TONE[QUEUE_META[q].tone].bg };
}

/** Ячейка «Окно»: что с окном повторной продажи и был ли контакт после отгрузки. */
export function WindowCell({ r, windowDays }: { r: ApiRow; windowDays: number }) {
  const q = r.queue;
  if (!r.lastDeliveredAt) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const tone = TONE[QUEUE_META[q.queue].tone];
  const since = Math.floor(q.daysSinceDelivery ?? 0);
  const main = q.queue === 'window'
    ? `🔥 ${q.daysLeft !== null && q.daysLeft < 1 ? 'последний день' : `${Math.ceil(q.daysLeft ?? 0)} дн. до закрытия`}`
    : q.queue === 'missed' ? `упущено · ${since} дн. без звонка`
    : q.queue === 'faded' ? `тихо ${since} дн. · цикл ${Math.round(r.cycleDays)}`
    : q.contactedAfter === 'call' ? `звонок ${daysAgo(r.lastGoodCallAt)}`
    : q.contactedAfter === 'manual' ? `связался ${daysAgo(r.lastContact?.contactedAt ?? null)}`
    : `отгрузка ${since} дн. назад`;
  const title = [
    `Последняя отгрузка ${fmtDate(r.lastDeliveredAt)}${r.lastDeliveredGroup ? ` · ${r.lastDeliveredGroup}` : ''}${r.lastDeliveredAmount ? ` · ${fmtMoney(r.lastDeliveredAmount)}` : ''}`,
    r.lastGoodCallAt ? `Успешный звонок (> 20 с): ${fmtDate(r.lastGoodCallAt)}` : 'Успешных звонков (> 20 с) не было',
    r.lastContact ? `Связался: ${fmtDate(r.lastContact.contactedAt)} · ${CONTACT_CHANNEL_LABELS[r.lastContact.channel]} — «${r.lastContact.note}» (${r.lastContact.createdBy})` : null,
    `Окно повторной продажи — ${windowDays} дня после отгрузки`,
  ].filter(Boolean).join('\n');
  return (
    <div className="flex flex-col gap-0.5 whitespace-nowrap" title={title}>
      <span className="text-[11.5px] font-semibold" style={{ color: q.queue === 'rest' ? 'var(--color-text-muted)' : tone.color }}>{main}</span>
      <span className="text-[10.5px] text-[var(--color-text-muted)] truncate max-w-[220px]">
        {fmtDate(r.lastDeliveredAt)}{r.lastDeliveredGroup ? ` · ${r.lastDeliveredGroup}` : ''}{r.lastDeliveredAmount ? ` · ${fmtMoney(r.lastDeliveredAmount)}` : ''}
      </span>
      {r.autoRepeatLostNoCall && q.queue !== 'rest' && (
        <span className="text-[10.5px] font-semibold" style={{ color: TONE.hot.color }} title="Авто-сделка повторки после этой отгрузки закрыта в отказ, а успешного звонка по ней не было. Сделку закрыть можно — заказчика спрятать нельзя.">
          ⚠ сделку закрыли без звонка
        </span>
      )}
    </div>
  );
}

// ── Модалка «Связался» ────────────────────────────────────────────────────────
const inputCls = 'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[16px] sm:text-sm text-[var(--color-text)]';
const btn = 'min-h-11 sm:min-h-0 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-40';

export function ContactModal({ r, managerId, isSelf, onClose }: { r: ApiRow; managerId: string; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [channel, setChannel] = useState<ContactChannel>('messenger');
  const [note, setNote] = useState('');
  const [when, setWhen] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/customers/contact', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: r.clientKey, channel, note, contactedAt: when || undefined, ...(isSelf ? {} : { managerId }) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['customers'] }); void qc.invalidateQueries({ queryKey: ['customer-card'] }); void qc.invalidateQueries({ queryKey: ['customers-header'] }); onClose(); },
  });
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Связался с ${clientDisplayName(r)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-2.5 text-sm">
        <div className="text-xs text-[var(--color-text-muted)]">
          Честная отметка: звонка в телефонии нет, но контакт был. Она снимает заказчика из очереди так же, как успешный звонок — поэтому «о чём договорились» обязательно.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {(Object.keys(CONTACT_CHANNEL_LABELS) as ContactChannel[]).map(c => (
            <label key={c} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 ${channel === c ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)]'}`}>
              <input type="radio" name="contact-channel" checked={channel === c} onChange={() => setChannel(c)} />
              {CONTACT_CHANNEL_LABELS[c]}
            </label>
          ))}
        </div>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} placeholder="О чём договорились: «просчитать кровлю, перезвонить во вторник»" className={inputCls} />
        <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
          Когда общались
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={`${inputCls} w-auto`} />
          <span>пусто — сейчас</span>
        </label>
        {m.isError && <div className="text-xs text-[var(--color-negative)]">{(m.error as Error).message}</div>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>Отмена</button>
        <button type="button" disabled={m.isPending || note.trim().length < 3} onClick={() => m.mutate()}
          className={`${btn} !border-transparent bg-[var(--color-accent)] text-[var(--color-text-inverse)]`}>✅ Связался</button>
      </div>
    </Modal>
  );
}

// ── Модалка «Исключить через РОПа» ────────────────────────────────────────────
export function ExclusionRequestModal({ r, managerId, isSelf, onClose }: { r: ApiRow; managerId: string; isSelf: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/customers/exclusion', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: r.clientKey, reason, ...(isSelf ? {} : { managerId }) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['customers'] }); void qc.invalidateQueries({ queryKey: ['customers-exclusions'] }); onClose(); },
  });
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Исключить ${clientDisplayName(r)} из канбана`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-2 text-sm">
        <div className="text-xs text-[var(--color-text-muted)]">
          Заказчик уйдёт из всех очередей навсегда — после одобрения РОПа. До решения он остаётся в списке с пометкой «ждёт РОПа». Опишите причину так, чтобы РОП понял без звонка вам.
        </div>
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} placeholder="Например: «Конфликт по рекламации в июле, просил больше не беспокоить»" className={inputCls} />
        {m.isError && <div className="text-xs text-[var(--color-negative)]">{(m.error as Error).message}</div>}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>Отмена</button>
        <button type="button" disabled={m.isPending || reason.trim().length < 3} onClick={() => m.mutate()}
          className={`${btn} !border-transparent`} style={{ color: 'var(--color-text-inverse)', backgroundColor: 'var(--color-negative, #e03131)' }}>
          🚫 Отправить РОПу
        </button>
      </div>
    </Modal>
  );
}

// ── Панель решений РОПа ───────────────────────────────────────────────────────
export function ExclusionRequestsPanel({ managerId, isSelf, names, team }: { managerId: string; isSelf: boolean; names: Map<string, string>; team?: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery<{ items: ExclusionRequest[]; canDecide: boolean }>({
    queryKey: ['customers-exclusions', team ? `team:${managerId}` : managerId],
    queryFn: () => fetch(team ? `/api/customers/exclusion?team=1&for=${managerId}` : `/api/customers/exclusion?managerId=${managerId}`).then(r => r.json()),
    refetchOnWindowFocus: false,
  });
  const decide = useMutation({
    mutationFn: async (v: { id: number; approve: boolean; managerId: string }) => {
      const res = await fetch('/api/customers/exclusion', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['customers-exclusions'] }); void qc.invalidateQueries({ queryKey: ['customers'] }); },
  });
  const items = data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        {isSelf ? 'Ваши запросы на исключение — ждут РОПа' : 'Запросы менеджера на исключение заказчиков'} · {items.length}
      </div>
      <div className="flex flex-col divide-y divide-[var(--color-border)]">
        {items.map(it => (
          <div key={it.id} className="flex flex-col sm:flex-row sm:items-center gap-1.5 py-1.5 text-sm">
            <span className="font-semibold min-w-0 truncate sm:w-56">{names.get(it.clientKey) ?? it.clientKey}</span>
            <span className="min-w-0 flex-1 text-xs text-[var(--color-text)]">«{it.reason}» <span className="text-[var(--color-text-muted)]">— {it.requestedBy}, {fmtDate(it.createdAt)}</span></span>
            {data?.canDecide && (
              <span className="flex gap-1.5 shrink-0">
                <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: it.id, approve: true, managerId: it.managerBitrixId })}
                  className={`${btn} !border-transparent`} style={{ color: 'var(--color-text-inverse)', backgroundColor: 'var(--color-negative, #e03131)' }}>Исключить</button>
                <button type="button" disabled={decide.isPending} onClick={() => decide.mutate({ id: it.id, approve: false, managerId: it.managerBitrixId })} className={btn}>Оставить в работе</button>
              </span>
            )}
          </div>
        ))}
      </div>
      {decide.isError && <div className="mt-1 text-xs text-[var(--color-negative)]">{(decide.error as Error).message}</div>}
    </div>
  );
}

// ── Шапка: метрики менеджера по повторным продажам ───────────────────────────
/** Меньше стольких наблюдений в знаменателе — процент показываем серым и без
 *  тренда (аудит 21.09): «охват окна 100 %» на ОДНОЙ отгрузке выглядел как
 *  достижение, а «конверсия ППО 0 %» на десяти — как провал; и то и другое
 *  в пределах случайности. Цифра остаётся видна, но не притворяется фактом. */
const MIN_DENOM_FOR_PCT = 8;

function Tile({ label, value, sub, delta, betterUp, hint, denom }: { label: string; value: string; sub?: string; delta: number | null; betterUp: boolean; hint: string; denom?: number | null }) {
  const thin = denom !== undefined && denom !== null && denom < MIN_DENOM_FOR_PCT;
  const good = delta === null ? null : betterUp ? delta > 0 : delta < 0;
  const color = delta === null || Math.abs(delta) < 0.05 ? 'var(--color-text-muted)' : good ? 'var(--color-positive, #16a34a)' : 'var(--color-negative, #e03131)';
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2"
      title={thin ? `${hint}\n\nДанных мало (${denom} в знаменателе) — процент показан серым и без тренда: на такой базе он скачет случайно.` : hint}>
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] truncate">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-bold tabular-nums" style={{ color: thin ? 'var(--color-text-muted)' : 'var(--color-text)' }}>{value}</span>
        {thin && <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]" title="Слишком мало наблюдений, чтобы считать это показателем">мало данных</span>}
        {!thin && delta !== null && (
          <span className="text-[11px] font-semibold tabular-nums" style={{ color }}>
            {delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} {Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0).replace('.', ',')}
          </span>
        )}
      </div>
      {sub && <div className="text-[11px] text-[var(--color-text-muted)] truncate">{sub}</div>}
    </div>
  );
}
const pctS = (v: number | null) => v === null ? '—' : `${Math.round(v)} %`;
const d = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

export function RepeatHeaderBlock({ managerId, isSelf, team, mgr, dept }: { managerId: string; isSelf: boolean; team?: boolean; mgr?: string; dept?: string }) {
  const { data, isError } = useQuery<RepeatHeader>({
    queryKey: ['customers-header', team ? `team:${managerId}:${dept ?? ''}:${mgr ?? 'all'}` : isSelf ? 'me' : managerId],
    queryFn: () => fetch(team ? `/api/customers/header?team=1&for=${managerId}${mgr ? `&mgr=${mgr}` : ''}${dept ? `&dept=${encodeURIComponent(dept)}` : ''}` : `/api/customers/header${isSelf ? '' : `?bitrixId=${managerId}`}`).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); }),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  if (isError) return null;
  const c: RepeatMonth | undefined = data?.current; const p = data?.previous;
  const v = (f: (m: RepeatMonth) => number | null) => (c ? f(c) : null);
  const pv = (f: (m: RepeatMonth) => number | null) => (p ? f(p) : null);
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
      <Tile label="Охват окна" value={pctS(v(m => m.coveragePct))} delta={d(v(m => m.coveragePct), pv(m => m.coveragePct))} betterUp denom={c?.windowsClosed ?? null}
        sub={c ? `${c.covered} из ${c.windowsClosed} отгрузок` : 'считаем…'}
        hint="Доля отгрузок месяца, по которым был успешный звонок (> 20 с) или отметка «Связался» в первые 22 дня. Отгрузки с ещё открытым окном и без контакта в знаменатель не входят. Тренд — к прошлому месяцу, п.п." />
      <Tile label="Конверсия ППО" value={pctS(v(m => m.ppoCrPct))} delta={d(v(m => m.ppoCrPct), pv(m => m.ppoCrPct))} betterUp denom={c?.autoDeals ?? null}
        sub={c ? `${c.autoSold} продано из ${c.autoDeals} авто-сделок` : undefined}
        hint="Авто-сделки повторки (создаются процессом в первые минуты после отгрузки), созданные в этом месяце: доля дошедших до продажи." />
      <Tile label="Доля повторных" value={pctS(v(m => m.repeatSharePct))} delta={d(v(m => m.repeatSharePct), pv(m => m.repeatSharePct))} betterUp
        sub={c ? `${fmtMoney(c.repeatSoldSum)} из ${fmtMoney(c.soldSum)}` : undefined}
        hint="Сумма продаж в повторных воронках ÷ все продажи менеджера за месяц." />
      <Tile label="Слито без звонка" value={pctS(v(m => m.dumpedPct))} delta={d(v(m => m.dumpedPct), pv(m => m.dumpedPct))} betterUp={false} denom={c?.autoDeals ?? null}
        sub={c ? `${c.autoLostNoCall} сделок · за 5 мин: ${c.autoLost5min}` : undefined}
        hint="Доля авто-сделок повторки месяца, закрытых в отказ без единого успешного звонка. Ниже — лучше. В подсказке — сколько закрыли в первые 5 минут после создания." />
      <Tile label="Звонок после отгрузки" value={c?.callDayMedian !== null && c?.callDayMedian !== undefined ? `${c.callDayMedian.toFixed(1).replace('.', ',')} дн.` : '—'}
        delta={d(v(m => m.callDayMedian), pv(m => m.callDayMedian))} betterUp={false}
        sub={c ? 'медианный день первого звонка' : undefined}
        hint="Через сколько дней после отгрузки обычно случается первый успешный звонок. Раньше — лучше: у бетона и сыпучих окно закрывается за неделю." />
    </div>
  );
}
