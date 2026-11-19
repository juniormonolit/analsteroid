'use client';
// S2 — форма менеджера «Запрос логисту» (спека LOGIST_REQUESTS_SPEC.md, «Форма менеджера»). Одна форма на три случая:
//  • новая по сделке (dealId): шапка и товары — GET /api/logist-requests/deal/:id (Битрикс, только чтение), «Отправить» —
//    POST /api/logist-kanban/drafts { send: true } (сразу в «Новые»), «Сохранить черновик» — без send;
//  • черновик (requestId, status=draft — робот в режиме «сначала форма» или не прошли проверки): PATCH + action send;
//  • «дополнить» уже отправленный (new / in_work / answered): шапка только для чтения, новые позиции — action add_items,
//    уточнение — сообщением в чат запроса (шапку после отправки движок не правит).
// Modal (components/ui/Modal): десктоп — окно, телефон — bottom-sheet. Инпуты 16px на телефоне (iOS не зумит).
// Файлы — после S4 (загрузка на Диск Битрикса, POST /api/logist-kanban/files): сейчас — «приложите в чате запроса».
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, Send, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useAppMode } from '@/lib/hooks/useAppMode';
import {
  OPEN_STATUSES, REQUEST_STATUS_LABEL, REQUEST_TYPE_LABEL,
  type CreateDraftResponse, type DealSnapshotResponse, type DraftHeaderInput, type ItemInput, type QueuesResponse,
  type RequestDetails, type RequestType,
} from '../engine/requests/contract';
import { mockApi } from './mock';

const input = 'w-full min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2.5 py-2 text-[16px] sm:text-sm outline-none focus:border-[var(--color-accent)]';
const label = 'mb-1 block text-[12px] font-medium text-[var(--color-text-secondary)]';
const btn = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium disabled:opacity-50';
const PAYMENT_HINTS = ['Безнал с НДС', 'Безнал без НДС', 'Наличные', 'Карта'];

/** Позиция в форме: строка сделки или свободная. key — локальный, id — существующая в запросе. */
interface Row extends ItemInput { key: string; on: boolean; locked?: boolean }

let seq = 0;
const k = () => `r${++seq}`;
const numOrNull = (v: string): number | null => {
  const t = v.replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const money = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n).toLocaleString('ru-RU')} ₽`;

// мок превью (/bx/big-deals-kanban?mock=1) — без сети; ставится один раз на открытие формы
let MOCK = false;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  if (MOCK) return mockApi<T>(url, init);
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Ошибка ${r.status}`);
  return j as T;
}

export interface LogistRequestFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** новая по сделке */
  dealId?: number | null;
  /** существующий запрос (черновик — правка, отправленный — «дополнить») */
  requestId?: number | null;
  /** тип по умолчанию для новой (иначе — по стадии сделки, иначе supply) */
  defaultType?: RequestType;
  onDone?: (request: RequestDetails) => void;
  /** открыта поверх выезжающей панели z-[70] (DealCard) — поднять слой; поповеры (z-[80]) остаются выше */
  overPanel?: boolean;
  /** превью без входа: данные из mock.ts, ничего не отправляется */
  mock?: boolean;
}

export function LogistRequestForm(props: LogistRequestFormProps) {
  const { open, onOpenChange } = props;
  // «уже есть открытый запрос этого типа» → переключаемся на «дополнить» его
  const [switchedTo, setSwitchedTo] = useState<number | null>(null);
  const requestId = switchedTo ?? props.requestId ?? null;
  MOCK = !!props.mock;
  useEffect(() => { if (!open) setSwitchedTo(null); }, [open]);
  return (
    <Modal open={open} onOpenChange={onOpenChange} desktopWidth="sm:max-w-3xl sm:w-[94vw]"
      contentClassName={props.overPanel ? 'z-[75]' : undefined} overlayClassName={props.overPanel ? 'z-[75]' : undefined}
      title={requestId ? `Запрос логисту №${requestId}` : 'Запрос логисту'}>
      {open && (requestId
        ? <ExistingRequest key={requestId} id={requestId} onDone={props.onDone} close={() => onOpenChange(false)} />
        : props.dealId
          ? <NewFromDeal dealId={props.dealId} defaultType={props.defaultType} onDone={props.onDone} close={() => onOpenChange(false)} openExisting={setSwitchedTo} />
          : <p className="text-sm text-[var(--color-text-muted)]">Не указана сделка.</p>)}
    </Modal>
  );
}

// ── загрузка ────────────────────────────────────────────────────────────────────────────

function useQueues(enabled = true) {
  return useQuery<QueuesResponse>({ queryKey: ['logist-queues', MOCK], queryFn: () => api('/api/logist-kanban/queues'), staleTime: 5 * 60_000, enabled });
}

function NewFromDeal({ dealId, defaultType, onDone, close, openExisting }: {
  dealId: number; defaultType?: RequestType; onDone?: (r: RequestDetails) => void; close: () => void; openExisting: (id: number) => void;
}) {
  const snap = useQuery<DealSnapshotResponse>({ queryKey: ['logist-deal-snapshot', dealId, MOCK], queryFn: () => api(`/api/logist-requests/deal/${dealId}`), staleTime: 30_000 });
  const queues = useQueues();
  if (snap.isLoading || queues.isLoading) return <Loading text="Читаю сделку и товары из Битрикса…" />;
  if (snap.error) return <ErrorBox text={(snap.error as Error).message} />;
  const s = snap.data!;
  return (
    <Editor
      mode="create" dealId={dealId} snapshot={s} queues={queues.data ?? null}
      initial={{
        type: defaultType ?? s.stageType ?? 'supply', queueId: s.defaultQueueId,
        header: { address: s.address }, rows: s.items.map(i => ({ ...i, key: k(), on: true })),
      }}
      openExisting={openExisting} onDone={onDone} close={close}
    />
  );
}

function ExistingRequest({ id, onDone, close }: { id: number; onDone?: (r: RequestDetails) => void; close: () => void }) {
  const req = useQuery<RequestDetails>({ queryKey: ['logist-request', id, 'peek'], queryFn: () => api(`/api/logist-kanban/request/${id}?peek=1`), staleTime: 0 });
  const queues = useQueues(req.data?.status === 'draft');
  if (req.isLoading) return <Loading text="Загружаю запрос…" />;
  if (req.error) return <ErrorBox text={(req.error as Error).message} />;
  const r = req.data!;
  if (r.status === 'draft') {
    if (queues.isLoading) return <Loading text="Загружаю очереди…" />;
    return (
      <Editor mode="draft" request={r} dealId={r.deal?.id ?? null} queues={queues.data ?? null}
        initial={{
          type: r.type, queueId: r.queue?.id ?? null,
          header: { address: r.address, purpose: r.purpose, paymentForm: r.paymentForm, deliveryDate: r.deliveryDate, comment: r.comment, competitorName: r.competitorName, competitorTotal: r.competitorTotal },
          rows: r.items.map(i => ({ id: i.id, kind: i.kind, bxRowId: i.bxRowId, bxProductId: i.bxProductId, name: i.name, quantity: i.quantity, measure: i.measure, ourPrice: i.ourPrice, productGroup: i.productGroup, competitorPrice: i.competitorPrice, comment: i.comment, key: k(), on: true })),
        }}
        onDone={onDone} close={close} />
    );
  }
  if ((OPEN_STATUSES as readonly string[]).includes(r.status)) return <Supplement request={r} onDone={onDone} close={close} />;
  return <ReadOnly request={r} />;
}

function Loading({ text }: { text: string }) {
  return <div className="flex flex-col gap-2 py-2">{[0, 1, 2].map(i => <div key={i} className="h-10 animate-pulse rounded bg-[var(--color-border)]" />)}<p className="text-sm text-[var(--color-text-muted)]">{text}</p></div>;
}
function ErrorBox({ text }: { text: string }) {
  return <p className="rounded-md bg-[var(--color-negative-soft)] px-3 py-2 text-sm text-[var(--color-negative)]">{text}</p>;
}

// ── шапка сделки ────────────────────────────────────────────────────────────────────────

function DealLine({ title, dealId, client, amount }: { title: string | null; dealId: number | null; client: string | null; amount: number | null }) {
  const { isBitrixIframe } = useAppMode();
  if (!dealId) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-[var(--color-bg)] px-3 py-2 text-[13px]">
      {/* в iframe Битрикса сделку открываем в самом портале (_top), а не новой вкладкой поверх него */}
      <a href={`https://td.monolit-crm.ru/crm/deal/details/${dealId}/`} target={isBitrixIframe ? '_top' : '_blank'} rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 font-medium hover:text-[var(--color-accent)] hover:underline">
        <span className="min-w-0 break-words">Сделка №{dealId}{title ? ` · ${title}` : ''}</span><ExternalLink size={12} className="shrink-0 opacity-60" />
      </a>
      {client && <span className="min-w-0 break-words text-[var(--color-text-secondary)]">{client}</span>}
      {amount != null && <span className="tabular-nums text-[var(--color-text-secondary)]">{money(amount)}</span>}
    </div>
  );
}

// ── редактор (новая / черновик) ─────────────────────────────────────────────────────────

interface EditorInit { type: RequestType; queueId: number | null; header: DraftHeaderInput; rows: Row[] }

function Editor(p: {
  mode: 'create' | 'draft'; dealId: number | null; snapshot?: DealSnapshotResponse; request?: RequestDetails;
  queues: QueuesResponse | null; initial: EditorInit;
  openExisting?: (id: number) => void; onDone?: (r: RequestDetails) => void; close: () => void;
}) {
  const qc = useQueryClient();
  const [type, setType] = useState<RequestType>(p.initial.type);
  const [queueId, setQueueId] = useState<number | null>(p.initial.queueId);
  const [h, setH] = useState<DraftHeaderInput>(p.initial.header);
  const [rows, setRows] = useState<Row[]>(p.initial.rows);
  const [busy, setBusy] = useState<'send' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<RequestDetails | null>(null);

  const openSame = p.snapshot?.openByType[type];
  const active = rows.filter(r => r.on && r.name.trim());
  const ourTotal = active.reduce((s, r) => s + (r.quantity ?? 0) * (r.ourPrice ?? 0), 0);
  const competitorSum = active.reduce((s, r) => s + (r.competitorPrice != null ? (r.quantity ?? 1) * r.competitorPrice : 0), 0);
  const queueOptions = useMemo(() => (p.queues?.queues ?? []).filter(q => q.active || q.id === queueId)
    .map(q => ({ value: String(q.id), label: q.name, hint: [q.region, q.dept].filter(Boolean).join(' · ') || undefined })), [p.queues, queueId]);

  const problems: string[] = [];
  if (!active.length) problems.push('нужна хотя бы одна позиция');
  if (!queueId) problems.push('выберите очередь');
  if (type === 'cheaper' && h.competitorTotal == null && !active.some(r => r.competitorPrice != null)) problems.push('укажите цену конкурента — по позиции или общую');
  if (type === 'cheaper' && !h.competitorName?.trim()) problems.push('укажите, чья цена');

  const set = (patch: Partial<DraftHeaderInput>) => setH(x => ({ ...x, ...patch }));
  const setRow = (key: string, patch: Partial<Row>) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));

  const payloadItems = (): ItemInput[] => active.map(({ key: _k, on: _o, locked: _l, ...i }) => { void _k; void _o; void _l; return { ...i, name: i.name.trim() }; });
  const payloadHeader = (): DraftHeaderInput => ({ type, queueId, address: h.address ?? null, purpose: h.purpose ?? null, paymentForm: h.paymentForm ?? null, deliveryDate: h.deliveryDate || null, comment: h.comment ?? null, competitorName: type === 'cheaper' ? h.competitorName ?? null : null, competitorTotal: type === 'cheaper' ? h.competitorTotal ?? null : null });

  async function submit(send: boolean) {
    setBusy(send ? 'send' : 'save'); setError(null);
    try {
      let res: RequestDetails;
      if (p.mode === 'create') {
        const r = await api<CreateDraftResponse>('/api/logist-kanban/drafts', { method: 'POST', body: JSON.stringify({ type, dealId: p.dealId, header: payloadHeader(), items: payloadItems(), send }) });
        res = r.request;
      } else {
        res = await api<RequestDetails>(`/api/logist-kanban/request/${p.request!.id}`, { method: 'PATCH', body: JSON.stringify({ version: p.request!.version, header: payloadHeader(), items: payloadItems() }) });
        if (send) res = await api<RequestDetails>(`/api/logist-kanban/request/${res.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'send', version: res.version }) });
      }
      void qc.invalidateQueries({ queryKey: ['logist-request'] });
      void qc.invalidateQueries({ queryKey: ['logist-deal-snapshot'] });
      p.onDone?.(res);
      if (send) setSent(res); else p.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (sent) return <SentBox request={sent} close={p.close} />;

  const dealTitle = p.snapshot?.deal.title ?? p.request?.deal?.title ?? null;
  const client = p.snapshot?.client.name ?? p.request?.client.name ?? null;
  const amount = p.snapshot?.deal.amount ?? p.request?.deal?.amount ?? null;

  return (
    <form className="flex min-w-0 flex-col gap-4 text-sm" onSubmit={e => { e.preventDefault(); if (!problems.length) void submit(true); }}>
      <DealLine title={dealTitle} dealId={p.dealId} client={client} amount={amount} />
      {p.request?.source === 'robot' && <p className="text-[12.5px] text-[var(--color-text-secondary)]">Черновик создал робот при смене стадии сделки — проверьте, дополните и отправьте.</p>}

      {/* тип — две кнопки, не селект */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Тип запроса">
        {(['supply', 'cheaper'] as RequestType[]).map(t => (
          <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
            className={`min-h-11 rounded-md border px-3 text-left text-sm font-medium ${type === t ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
            {REQUEST_TYPE_LABEL[t]}
            <span className="block text-[11.5px] font-normal text-[var(--color-text-muted)]">{t === 'supply' ? 'нет в калькуляторе — найти цену и срок' : 'у заказчика есть цена ниже нашей'}</span>
          </button>
        ))}
      </div>
      {openSame && p.openExisting && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-warning,#f59f00)] px-3 py-2 text-[13px]">
          <span className="min-w-0 flex-1">По этой сделке уже есть открытый запрос «{REQUEST_TYPE_LABEL[type]}» №{openSame}. Новый можно создать, но обычно достаточно дополнить.</span>
          <button type="button" onClick={() => p.openExisting!(openSame)} className={`${btn} border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>Дополнить №{openSame}</button>
        </div>
      )}

      {/* шапка */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Населённый пункт / адрес" className="sm:col-span-2">
          <input className={input} value={h.address ?? ''} onChange={e => set({ address: e.target.value })} placeholder="г. Москва, ул. … или «Самовывоз»" maxLength={500} />
        </Field>
        <Field label="Для каких целей">
          <input className={input} value={h.purpose ?? ''} onChange={e => set({ purpose: e.target.value })} placeholder="фундамент, кладка стен, забор…" maxLength={500} />
        </Field>
        <Field label="Дата поставки">
          <input type="date" className={input} value={h.deliveryDate ?? ''} onChange={e => set({ deliveryDate: e.target.value || null })} />
        </Field>
        <Field label="Форма оплаты" className="sm:col-span-2">
          <input className={input} value={h.paymentForm ?? ''} onChange={e => set({ paymentForm: e.target.value })} placeholder="Безнал с НДС" maxLength={200} />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PAYMENT_HINTS.map(x => (
              <button key={x} type="button" onClick={() => set({ paymentForm: x })}
                className={`min-h-9 rounded-full border px-3 text-[12px] ${h.paymentForm === x ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'}`}>{x}</button>
            ))}
          </div>
        </Field>
      </div>

      {/* позиции */}
      <ItemsEditor rows={rows} type={type} setRow={setRow} setRows={setRows} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-[var(--color-text-secondary)]">
        <span>Позиций: <b className="text-[var(--color-text)]">{active.length}</b></span>
        {ourTotal > 0 && <span>Наша сумма: <b className="text-[var(--color-text)] tabular-nums">{money(ourTotal)}</b></span>}
        {type === 'cheaper' && competitorSum > 0 && <span>У конкурента по позициям: <b className="text-[var(--color-text)] tabular-nums">{money(competitorSum)}</b></span>}
      </div>

      {type === 'cheaper' && (
        <div className="grid min-w-0 grid-cols-1 gap-3 rounded-md border border-[var(--color-border)] p-3 sm:grid-cols-2">
          <Field label="Чья цена (конкурент) *">
            <input className={input} value={h.competitorName ?? ''} onChange={e => set({ competitorName: e.target.value })} placeholder="Петрович, Леруа, местная база…" maxLength={300} />
          </Field>
          <Field label="Цена конкурента общая, ₽">
            <input inputMode="decimal" className={input} value={h.competitorTotal ?? ''} onChange={e => set({ competitorTotal: numOrNull(e.target.value) })} placeholder="если не по позициям" />
          </Field>
          <p className="text-[12px] text-[var(--color-text-muted)] sm:col-span-2">Нужна цена по позициям (в строках выше) или общая — что прислал заказчик.</p>
        </div>
      )}

      <Field label="Комментарий логисту">
        <textarea className={`${input} min-h-20`} value={h.comment ?? ''} onChange={e => set({ comment: e.target.value })} maxLength={4000} placeholder="Что важно: марка, срочность, разгрузка, кто привезёт…" />
      </Field>
      <p className="text-[12px] text-[var(--color-text-muted)]">Фото и файлы (смета, скриншот цены конкурента) — приложите в чате запроса после отправки.</p>

      <Field label="Очередь (проект логистов)">
        <SearchSelect options={queueOptions} value={queueId ? String(queueId) : ''} onChange={v => setQueueId(v ? Number(v) : null)}
          placeholder={queueOptions.length ? 'Выберите очередь' : 'Очереди ещё не заведены'} searchable className="w-full min-h-11" ariaLabel="Очередь" />
        {p.snapshot?.defaultQueueId && queueId === p.snapshot.defaultQueueId && <p className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">Подобрана по вашему региону и товарной группе — можно сменить.</p>}
      </Field>

      {error && <ErrorBox text={error} />}
      {problems.length > 0 && <p className="text-[12.5px] text-[var(--color-text-muted)]">Чтобы отправить: {problems.join('; ')}.</p>}

      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-4 py-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={() => void submit(false)} disabled={!!busy || !active.length}
          className={`${btn} border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>
          {busy === 'save' ? 'Сохраняю…' : 'Сохранить черновик'}
        </button>
        <button type="submit" disabled={!!busy || problems.length > 0}
          className={`${btn} bg-[var(--color-accent)] text-white hover:opacity-90`}>
          <Send size={15} aria-hidden />{busy === 'send' ? 'Отправляю…' : 'Отправить логистам'}
        </button>
      </div>
    </form>
  );
}

function Field({ label: l, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`block min-w-0 ${className ?? ''}`}><span className={label}>{l}</span>{children}</label>;
}

// ── позиции ─────────────────────────────────────────────────────────────────────────────

function ItemsEditor({ rows, type, setRow, setRows, addOnly }: {
  rows: Row[]; type: RequestType; setRow: (key: string, p: Partial<Row>) => void; setRows: (f: (r: Row[]) => Row[]) => void;
  /** «дополнить»: существующие — только чтение, добавлять свободные */
  addOnly?: boolean;
}) {
  const dealRows = rows.filter(r => r.kind === 'deal_row');
  const free = rows.filter(r => r.kind !== 'deal_row');
  const addFree = () => setRows(rs => [...rs, { key: k(), kind: 'free', name: '', quantity: null, measure: 'шт', on: true }]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold">Позиции</span>
        {dealRows.length > 0 && !addOnly && <span className="text-[11.5px] text-[var(--color-text-muted)]">галочка — включить товар сделки в запрос</span>}
      </div>
      {dealRows.length === 0 && !addOnly && <p className="text-[12.5px] text-[var(--color-text-muted)]">В сделке нет товаров — добавьте позиции вручную.</p>}
      {dealRows.map(r => (
        <div key={r.key} className={`min-w-0 rounded-md border border-[var(--color-border)] px-3 py-2 ${r.on ? '' : 'opacity-55'}`}>
          <label className="flex min-w-0 items-start gap-2">
            {!r.locked && <input type="checkbox" checked={r.on} onChange={e => setRow(r.key, { on: e.target.checked })} className="mt-0.5 size-5 shrink-0 accent-[var(--color-accent)]" aria-label="Включить в запрос" />}
            <span className="min-w-0 flex-1 break-words font-medium">{r.name}</span>
          </label>
          {r.locked ? (
            <p className="mt-1 text-[12px] tabular-nums text-[var(--color-text-secondary)]">{[r.quantity != null ? `${r.quantity} ${r.measure ?? ''}` : null, r.ourPrice != null ? `по ${money(r.ourPrice)}` : null, r.competitorPrice != null ? `у конкурента ${money(r.competitorPrice)}` : null].filter(Boolean).join(' · ')}</p>
          ) : r.on && (
            <div className={`mt-2 grid min-w-0 grid-cols-2 gap-2 ${type === 'cheaper' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
              <MiniNum label={`Кол-во${r.measure ? `, ${r.measure}` : ''}`} value={r.quantity ?? null} onChange={v => setRow(r.key, { quantity: v })} />
              <div className="min-w-0"><span className={label}>Наша цена</span><div className="py-2 text-sm tabular-nums">{money(r.ourPrice)}</div></div>
              <div className="min-w-0"><span className={label}>Сумма</span><div className="py-2 text-sm tabular-nums">{money(r.quantity != null && r.ourPrice != null ? r.quantity * r.ourPrice : null)}</div></div>
              {type === 'cheaper' && <MiniNum label="Цена конкурента, ₽/ед." value={r.competitorPrice ?? null} onChange={v => setRow(r.key, { competitorPrice: v })} />}
            </div>
          )}
        </div>
      ))}
      {free.map((r, i) => (
        <div key={r.key} className="min-w-0 rounded-md border border-dashed border-[var(--color-border)] px-3 py-2">
          {r.locked ? (
            <>
              <p className="break-words font-medium">{r.name}</p>
              <p className="text-[12px] text-[var(--color-text-secondary)]">{[r.quantity != null ? `${r.quantity} ${r.measure ?? ''}` : null, r.comment].filter(Boolean).join(' · ') || 'нет в 1С'}</p>
            </>
          ) : (
            <>
              <div className="flex min-w-0 items-start gap-2">
                <Field label={`Позиция, которой нет в 1С${free.length > 1 ? ` · ${i + 1}` : ''}`} className="flex-1">
                  <input className={input} value={r.name} onChange={e => setRow(r.key, { name: e.target.value })} placeholder="Штуцер латунный 1/2″" maxLength={500} />
                </Field>
                <button type="button" onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))} aria-label="Убрать позицию"
                  className="tap-target mt-6 shrink-0 rounded p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]"><Trash2 size={15} /></button>
              </div>
              <div className={`mt-2 grid min-w-0 grid-cols-2 gap-2 ${type === 'cheaper' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
                <MiniNum label="Кол-во" value={r.quantity ?? null} onChange={v => setRow(r.key, { quantity: v })} />
                <Field label="Ед."><input className={input} value={r.measure ?? ''} onChange={e => setRow(r.key, { measure: e.target.value })} maxLength={40} /></Field>
                {type === 'cheaper' && <MiniNum label="Цена конкурента, ₽/ед." value={r.competitorPrice ?? null} onChange={v => setRow(r.key, { competitorPrice: v })} />}
                <Field label="Комментарий" className="col-span-2 sm:col-span-1"><input className={input} value={r.comment ?? ''} onChange={e => setRow(r.key, { comment: e.target.value })} maxLength={2000} placeholder="марка, размер…" /></Field>
              </div>
            </>
          )}
        </div>
      ))}
      <button type="button" onClick={addFree} className={`${btn} self-start border border-dashed border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>
        <Plus size={15} aria-hidden /> Позиция, которой нет в 1С
      </button>
    </div>
  );
}

function MiniNum({ label: l, value, onChange }: { label: string; value: number | null; onChange: (v: number | null) => void }) {
  // строкой, чтобы «1,5» не съедалось при вводе
  const [text, setText] = useState(value == null ? '' : String(value));
  return (
    <Field label={l}>
      <input inputMode="decimal" className={`${input} tabular-nums`} value={text} onChange={e => { setText(e.target.value); onChange(numOrNull(e.target.value)); }} />
    </Field>
  );
}

// ── «дополнить» отправленный ────────────────────────────────────────────────────────────

function Supplement({ request: r, onDone, close }: { request: RequestDetails; onDone?: (r: RequestDetails) => void; close: () => void }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => r.items.map(i => ({ id: i.id, kind: i.kind, name: i.name, quantity: i.quantity, measure: i.measure, ourPrice: i.ourPrice, competitorPrice: i.competitorPrice, comment: i.comment, key: k(), on: true, locked: true })));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const setRow = (key: string, p: Partial<Row>) => setRows(rs => rs.map(x => x.key === key ? { ...x, ...p } : x));
  const fresh = rows.filter(x => !x.locked && x.name.trim());
  const canAdd = r.can.add_items;
  const canMsg = r.can.message;

  async function submit() {
    setBusy(true); setError(null);
    try {
      let res: RequestDetails = r;
      const parts: string[] = [];
      if (fresh.length) {
        res = await api<RequestDetails>(`/api/logist-kanban/request/${r.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'add_items', version: r.version, items: fresh.map(({ key: _k, on: _o, locked: _l, ...i }) => { void _k; void _o; void _l; return { ...i, name: i.name.trim(), kind: 'free' }; }) }) });
        parts.push(`добавлено позиций: ${fresh.length}`);
      }
      if (note.trim()) {
        await api(`/api/logist-kanban/request/${r.id}/messages`, { method: 'POST', body: JSON.stringify({ body: note.trim() }) });
        parts.push('уточнение ушло в чат запроса');
      }
      void qc.invalidateQueries({ queryKey: ['logist-request'] });
      onDone?.(res);
      setDone(parts.join(', '));
      setRows(rs => rs.map(x => ({ ...x, locked: true })).filter(x => x.name.trim()));
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      <DealLine title={r.deal?.title ?? null} dealId={r.deal?.id ?? null} client={r.client.name} amount={r.deal?.amount ?? null} />
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="rounded bg-[var(--color-bg-hover)] px-2 py-0.5 font-medium">{REQUEST_TYPE_LABEL[r.type]}</span>
        <span className="rounded bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2 py-0.5 text-[var(--color-accent)]">{REQUEST_STATUS_LABEL[r.status]}</span>
        {r.queue && <span className="text-[var(--color-text-secondary)]">{r.queue.name}</span>}
        {r.logist && <span className="text-[var(--color-text-secondary)]">логист: {r.logist.name}</span>}
      </div>
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
        {([['Адрес', r.address], ['Цели', r.purpose], ['Оплата', r.paymentForm], ['Поставка', r.deliveryDate], ['Конкурент', r.type === 'cheaper' ? [r.competitorName, r.competitorTotal != null ? money(r.competitorTotal) : null].filter(Boolean).join(', ') : null], ['Комментарий', r.comment]] as [string, string | null][])
          .filter(([, v]) => v).map(([t, v]) => <div key={t} className="min-w-0 break-words"><dt className="inline text-[var(--color-text-muted)]">{t}: </dt><dd className="inline">{v}</dd></div>)}
      </dl>
      <ItemsEditor rows={rows} type={r.type} setRow={setRow} setRows={setRows} addOnly />
      {canMsg && (
        <Field label="Уточнение логисту (уйдёт в чат запроса)">
          <textarea className={`${input} min-h-20`} value={note} onChange={e => setNote(e.target.value)} maxLength={4000} placeholder="Адрес изменился, нужна разгрузка, дата сдвинулась…" />
        </Field>
      )}
      {!canAdd && <p className="text-[12.5px] text-[var(--color-text-muted)]">Добавлять позиции в этот запрос может только его менеджер.</p>}
      {error && <ErrorBox text={error} />}
      {done && <p className="rounded-md bg-[color-mix(in_srgb,var(--color-positive)_12%,transparent)] px-3 py-2 text-[13px] text-[var(--color-positive)]">Готово: {done}.</p>}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-col-reverse gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-4 py-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={close} className={`${btn} border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>Закрыть</button>
        <button type="button" onClick={() => void submit()} disabled={busy || (!(canAdd && fresh.length) && !note.trim())}
          className={`${btn} bg-[var(--color-accent)] text-white hover:opacity-90`}>
          <Send size={15} aria-hidden />{busy ? 'Отправляю…' : 'Дополнить запрос'}
        </button>
      </div>
    </div>
  );
}

function ReadOnly({ request: r }: { request: RequestDetails }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <DealLine title={r.deal?.title ?? null} dealId={r.deal?.id ?? null} client={r.client.name} amount={r.deal?.amount ?? null} />
      <p>Запрос «{REQUEST_TYPE_LABEL[r.type]}» — <b>{REQUEST_STATUS_LABEL[r.status].toLowerCase()}</b>. Дополнять закрытый запрос нельзя; если нужно ещё — создайте новый из сделки.</p>
    </div>
  );
}

function SentBox({ request: r, close }: { request: RequestDetails; close: () => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      <p className="rounded-md bg-[color-mix(in_srgb,var(--color-positive)_12%,transparent)] px-3 py-2 text-[var(--color-positive)]">
        Запрос №{r.id} отправлен{r.queue ? ` в очередь «${r.queue.name}»` : ''}. Логисты ответят вариантами — пришлём уведомление.
      </p>
      <button type="button" onClick={close} className={`${btn} self-end border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]`}>Готово</button>
    </div>
  );
}

/** Кнопка «Запрос логисту» для карточек сделки (DealCard, TaskDrawer больших чеков). */
export function LogistRequestButton({ dealId, className, label: text = 'Запрос логисту', overPanel, mock }: { dealId: number; className?: string; label?: string; overPanel?: boolean; mock?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className={className ?? 'inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 text-[12.5px] font-medium hover:bg-[var(--color-bg-hover)] sm:min-h-8'}>
        <Send size={13} aria-hidden /> {text}
      </button>
      <LogistRequestForm open={open} onOpenChange={setOpen} dealId={dealId} overPanel={overPanel} mock={mock} />
    </>
  );
}
