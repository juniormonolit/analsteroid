'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Info, Pencil, Search, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import {
  DISMISSAL_ACTION_LABELS, DISMISSAL_ALLOWED_ACTIONS, DISMISSAL_KIND_LABELS, PRIMARY_MIN_AMOUNT,
  type DismissalAction, type DismissalItem, type DismissalKind, type DismissalOverride, type DismissalPlan, type DismissalRule,
} from '../types';
import {
  actionAllowed, defaultAction, fmtNum, fmtRub, plural, repeatClients, ruleOf, ruleTargets, topCountOf,
  type DeptManagers, type PlanTotals, type RepeatClient, type ResolvedItem,
} from './planMath';
import { Skeleton, btnSecondary, card } from './shared';

// Секции черновика «Увольнятора» v2:
// 1. Повторные сделки (топ клиентов + остальные змейкой), 2. Первичные (передаём / автобрак),
// 3. Задачи и дела (по сделкам — вслед за сделкой; без сделок — РОПу), 4. В конце (РОП, сообщения).

export interface DraftCtx {
  plan: DismissalPlan;
  items: DismissalItem[];
  resolved: Map<string, ResolvedItem>;
  totals: PlanTotals;
  recipients: SearchSelectOption[];
  deptOptions: SearchSelectOption[];
  deptManagers: DeptManagers;
  deptName: (id: string) => string;
  /** справочники отделов/сотрудников загружены — до этого не делаем выводов «в отделе никого» */
  deptsReady: boolean;
  usersReady: boolean;
  ownDeptId: string | null;
  nameOf: (id: number | null | undefined) => string;
  ropName: string | null;
  setRule: (kind: DismissalKind, patch: Partial<DismissalRule>) => void;
  setOverrides: (patch: Record<string, DismissalOverride | null>) => void;
  setTopCount: (n: number) => void;
}

export const SECTION_IDS = { repeat: 'dm-repeat', primary: 'dm-primary', tasks: 'dm-tasks', final: 'dm-final' } as const;
export const scrollToSection = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const PAGE = 50;
const PANEL = 'w-[400px] max-w-[calc(100vw-16px)]';
const PANEL_SM = 'w-[300px] max-w-[calc(100vw-16px)]';
const muted = 'text-[var(--color-text-muted)]';
const MIN_AMOUNT_TEXT = `${fmtNum(PRIMARY_MIN_AMOUNT)} ₽`;

function actionLabel(kind: DismissalKind, a: DismissalAction): string {
  if (a === 'transfer' && kind === 'task_participant') return 'Заменить на получателя';
  if (a === 'transfer' && kind === 'task_creator') return 'Сменить постановщика';
  if (a === 'close' && (kind === 'activity_other' || kind === 'activity_deal')) return 'Отметить выполненным';
  if (a === 'close') return 'Завершить';
  return DISMISSAL_ACTION_LABELS[a];
}

/** Что произойдёт со строкой — короткой подписью. */
function outcomeText(r: ResolvedItem | undefined, ctx: DraftCtx): { text: string; bad?: boolean } {
  if (!r) return { text: '' };
  const k = r.item.kind;
  if (r.viaFollow) {
    if (r.action === 'transfer') return r.target == null ? { text: 'вслед за сделкой → получатель не выбран', bad: true } : { text: `вслед за сделкой → ${ctx.nameOf(r.target)}` };
    if (r.action === 'close') return { text: 'сделка в автобраке — закроется' };
    return { text: 'сделка остаётся — задача тоже' };
  }
  if (r.action === 'transfer') {
    if (r.target == null) return { text: `${actionLabel(k, 'transfer')} → ${r.toRop ? 'РОП не выбран' : 'не выбрано'}`, bad: true };
    return { text: `${actionLabel(k, 'transfer')} → ${ctx.nameOf(r.target)}${r.toRop ? ' (РОП)' : ''}` };
  }
  return { text: actionLabel(k, r.action) };
}

/** Подпись строки из info (без дублей subtitle). */
function infoLine(it: DismissalItem): string {
  const i = it.info ?? {};
  const parts: string[] = [];
  if (i.stageName) parts.push(i.stageName);
  if (i.amount != null) parts.push(fmtRub(i.amount));
  if (i.deadline) {
    const d = new Date(i.deadline);
    if (!Number.isNaN(d.getTime())) parts.push(`срок ${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`);
  }
  if (i.role) parts.push(i.role);
  return parts.join(' · ');
}

// ── Общие кирпичи ─────────────────────────────────────────────────────────────────────────────

export function Section({ id, num, title, count, aside, children }: {
  id: string; num: number; title: string; count?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className={`${card} scroll-mt-3`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-3 pt-3 sm:px-4 sm:pt-4">
        <h2 className="text-base font-semibold text-[var(--color-text)]"><span className={muted}>{num}.</span> {title}</h2>
        {count != null && <span className={`text-sm tabular-nums ${muted}`}>{count}</span>}
        {aside}
      </div>
      {children}
    </section>
  );
}

function ItemTitle({ item }: { item: DismissalItem }) {
  const t = item.title || `#${item.entityId}`;
  return item.url ? (
    <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 text-sm text-[var(--color-accent)] hover:underline">
      <span className="min-w-0 break-words">{t}</span>
      <ExternalLink size={12} className="shrink-0" />
    </a>
  ) : <span className="text-sm text-[var(--color-text)] break-words">{t}</span>;
}

function Collapse({ open, onToggle, children, tone }: { open: boolean; onToggle: () => void; children: React.ReactNode; tone?: 'warn' }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      className={`flex min-h-11 w-full items-center gap-2 border-t border-[var(--color-border)] px-3 text-left text-sm hover:bg-[var(--color-bg-hover)] sm:px-4 ${tone === 'warn' ? 'text-[var(--color-warning)]' : muted}`}>
      {open ? <ChevronDown size={16} className="shrink-0" /> : <ChevronRight size={16} className="shrink-0" />}
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}

function SearchBox({ value, onChange, placeholder = 'Поиск по названию или №' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 sm:max-w-[360px]">
      <Search size={14} className={`shrink-0 ${muted}`} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
      {value && <button type="button" onClick={() => onChange('')} aria-label="Очистить поиск" className={`tap-target ${muted}`}><X size={14} /></button>}
    </label>
  );
}

function MoreButton({ left, onClick }: { left: number; onClick: () => void }) {
  if (left <= 0) return null;
  return (
    <button type="button" onClick={onClick}
      className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
      Показать ещё (осталось {fmtNum(left)})
    </button>
  );
}

const Empty = () => <div className={`px-4 py-4 text-center text-xs ${muted}`}>Ничего не нашлось</div>;

/** Сегмент-кнопки (aria-pressed) — вместо радио без клавиатуры. */
function Segment<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--color-border)] p-0.5 sm:max-w-[420px]">
      {options.map(o => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" aria-pressed={on} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}
            className={`min-h-11 rounded-md px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${on ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : `${muted} hover:bg-[var(--color-bg-hover)]`}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Правка строки: на sm+ — селекты в строке; на телефоне — итог чипом и «Изменить» → Modal с селектами. */
function RowEditor({ summary, bad, title, children }: { summary: string; bad?: boolean; title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="hidden gap-2 sm:grid sm:grid-cols-2 lg:w-[460px] lg:shrink-0">{children}</div>
      <div className="flex items-center gap-2 sm:hidden">
        <span className={`min-w-0 flex-1 truncate rounded-full px-2.5 py-1 text-xs ${bad ? 'bg-[var(--color-negative)]/10 text-[var(--color-negative)]' : 'bg-[var(--color-bg-hover)] text-[var(--color-text)]'}`}>{summary}</span>
        <button type="button" onClick={() => setOpen(true)} className={`${btnSecondary} shrink-0`}><Pencil size={14} /> Изменить</button>
      </div>
      {open && (
        <Modal open onOpenChange={setOpen} title={title}>
          <div className="flex flex-col gap-3">
            {children}
            <button type="button" onClick={() => setOpen(false)} className={btnSecondary}>Готово</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Таблица «кому сколько». */
function Distribution({ rows, withClients, valueLabel }: {
  rows: { id: number; name: string; clients?: number; deals: number; value: number }[];
  withClients?: boolean; valueLabel: string;
}) {
  if (!rows.length) return null;
  const tot = rows.reduce((a, r) => ({ clients: a.clients + (r.clients ?? 0), deals: a.deals + r.deals, value: a.value + r.value }), { clients: 0, deals: 0, value: 0 });
  const th = `px-2 py-1.5 text-xs font-medium ${muted}`;
  return (
    <div className="scroll-x rounded-lg border border-[var(--color-border)]">
      <table className="w-full min-w-[420px] text-sm tabular-nums">
        <thead className="bg-[var(--color-table-header)]">
          <tr>
            <th className={`${th} text-left`}>Получатель</th>
            {withClients && <th className={`${th} text-right`}>заказчиков</th>}
            <th className={`${th} text-right`}>сделок</th>
            <th className={`${th} text-right`}>{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-[var(--color-table-row-border)]">
              <td className="px-2 py-1.5 text-left">{r.name}</td>
              {withClients && <td className="px-2 py-1.5 text-right">{fmtNum(r.clients ?? 0)}</td>}
              <td className="px-2 py-1.5 text-right">{fmtNum(r.deals)}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right">{fmtRub(r.value)}</td>
            </tr>
          ))}
          <tr className="border-t border-[var(--color-border)] bg-[var(--color-totals-bg)] font-semibold">
            <td className="px-2 py-1.5 text-left">Итого</td>
            {withClients && <td className="px-2 py-1.5 text-right">{fmtNum(tot.clients)}</td>}
            <td className="px-2 py-1.5 text-right">{fmtNum(tot.deals)}</td>
            <td className="whitespace-nowrap px-2 py-1.5 text-right">{fmtRub(tot.value)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Получатели правила: «Конкретным людям» (мультивыбор) / «Раскидать по отделу». */
function RecipientRule({ ctx, kind, freeCount, hint }: { ctx: DraftCtx; kind: DismissalKind; freeCount: number; hint: React.ReactNode }) {
  const rule = ruleOf(ctx.plan, kind);
  const byDept = rule.departmentId != null;
  const targets = ruleTargets(rule, ctx.deptManagers);
  const ready = byDept ? ctx.deptsReady : true;
  const missing = ready && targets.length === 0;
  const noDepts = ctx.deptsReady && ctx.deptOptions.length === 0;
  const isOwn = byDept && rule.departmentId === ctx.ownDeptId;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Segment<'people' | 'dept'> label="Кому передать" value={byDept ? 'dept' : 'people'}
        onChange={m => ctx.setRule(kind, m === 'dept' ? { departmentId: rule.departmentId ?? ctx.ownDeptId ?? ctx.deptOptions[0]?.value ?? '' } : { departmentId: null })}
        options={[
          { value: 'people', label: 'Конкретным людям' },
          { value: 'dept', label: 'Раскидать по отделу', disabled: noDepts || !ctx.deptsReady, title: noDepts ? 'Нет отделов с действующими менеджерами' : undefined },
        ]} />
      {byDept ? (
        <SearchSelect options={ctx.deptOptions} value={rule.departmentId ?? ''} onChange={v => ctx.setRule(kind, { departmentId: v })} searchable
          placeholder={ctx.deptsReady ? 'Выберите отдел' : 'Загружаю отделы…'} disabled={!ctx.deptsReady} searchPlaceholder="Название отдела…"
          ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: отдел`}
          className={`w-full sm:max-w-[420px] ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
      ) : (
        <SearchMultiSelect options={ctx.recipients} value={rule.targets.map(String)} onChange={v => ctx.setRule(kind, { targets: v.map(Number) })}
          allLabel={ctx.usersReady ? 'Не выбрано' : 'Загружаю сотрудников…'}
          unitLabel={plural(rule.targets.length, ['получатель', 'получателя', 'получателей'])}
          searchPlaceholder="Имя, должность, отдел…" ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: кому`}
          className={`w-full sm:max-w-[420px] ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
      )}
      {!ready ? (
        <span className={`text-xs ${muted}`}>Загружаю состав отдела…</span>
      ) : targets.length > 0 ? (
        <span className={`text-xs ${muted} break-words`}>
          {isOwn && <b className="font-medium text-[var(--color-text)]">Отдел уволенного. </b>}
          Поровну на {targets.length} {plural(targets.length, ['получателя', 'получателей', 'получателей'])}
          {freeCount > 0 && <> (~{fmtNum(Math.ceil(freeCount / targets.length))} каждому)</>}
          {(byDept || targets.length > 1) && <>: {targets.slice(0, 8).map(id => ctx.nameOf(id)).join(', ')}{targets.length > 8 && <> и ещё {targets.length - 8}</>}</>}
          {byDept && <>. Состав отдела возьмётся в момент запуска</>}.
        </span>
      ) : (
        <span className="text-xs text-[var(--color-negative)]">{byDept ? 'В отделе нет действующих менеджеров — выберите другой.' : 'Выберите, кому передать.'}</span>
      )}
      <p className={`text-xs ${muted}`}>{hint}</p>
    </div>
  );
}

// ── 1. Повторные сделки ───────────────────────────────────────────────────────────────────────

export function RepeatSection({ ctx }: { ctx: DraftCtx }) {
  const clients = useMemo(() => repeatClients(ctx.items), [ctx.items]);
  const topN = topCountOf(ctx.plan);
  const top = clients.slice(0, topN);
  const rest = clients.slice(topN);
  const total = clients.reduce((s, c) => s + c.items.length, 0);
  const [topStr, setTopStr] = useState(String(topN));
  const [openRest, setOpenRest] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState('');
  const manualOf = (c: RepeatClient) => c.items.map(it => ctx.plan.overrides[it.key]?.target ?? null);
  const topManual = top.filter(c => manualOf(c).some(Boolean)).length;
  if (!clients.length) return null;

  const freeCount = [...ctx.resolved.values()].filter(r => r.item.kind === 'deal_repeat' && r.action === 'transfer' && !ctx.plan.overrides[r.item.key]?.target).length;
  const applyTop = () => {
    const raw = topStr.trim();
    const n = Math.round(Number(raw));
    // пусто/мусор — откат к прежнему значению, а не «топ выключен»
    if (raw === '' || !Number.isFinite(n) || n < 0) { setTopStr(String(topN)); return; }
    const v = Math.min(500, n);
    ctx.setTopCount(v); setTopStr(String(v));
  };
  const setClientsTarget = (list: RepeatClient[], target: number | null) => {
    const patch: Record<string, DismissalOverride | null> = {};
    for (const c of list) for (const it of c.items) patch[it.key] = target ? { action: 'transfer', target } : null;
    ctx.setOverrides(patch);
  };
  const needle = q.trim().toLowerCase();
  const restFiltered = needle ? rest.filter(c => `${c.name} ${c.items.map(i => i.title).join(' ')}`.toLowerCase().includes(needle)) : rest;
  const dist = [...ctx.totals.repeat.byTarget.entries()]
    .map(([id, e]) => ({ id, name: ctx.nameOf(id), clients: e.clients.size, deals: e.deals, value: e.ltv }))
    .sort((a, b) => b.value - a.value);

  return (
    <Section id={SECTION_IDS.repeat} num={1} title="Повторные сделки" count={`${fmtNum(total)} · ${fmtNum(clients.length)} ${plural(clients.length, ['заказчик', 'заказчика', 'заказчиков'])}`}>
      <p className={`flex items-start gap-1.5 px-3 pt-2 text-xs sm:px-4 ${muted}`}>
        <Info size={14} className="mt-px shrink-0" />
        <span>Ответственного сменит бизнес-процесс Битрикса «Сменить ответственного» — вместе со сделкой переедут контакт, компания и дела.</span>
      </p>

      {/* Топ клиентов */}
      <div className="p-3 sm:p-4">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">Топ клиентов</h3>
          <label className={`flex items-center gap-1.5 text-xs ${muted}`}>
            первые
            <input value={topStr} onChange={e => setTopStr(e.target.value)} onBlur={applyTop} onKeyDown={e => { if (e.key === 'Enter') applyTop(); }}
              inputMode="numeric" aria-label="Сколько заказчиков в топе"
              className="min-h-11 w-16 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 text-center text-base tabular-nums text-[var(--color-text)] outline-none sm:text-sm" />
            по LTV
          </label>
          {top.length > 0 && <span className={`text-xs ${muted}`}>вручную <b className="text-[var(--color-text)]">{topManual}</b> из {top.length}</span>}
        </div>
        <p className={`mb-2 text-xs ${muted}`}>
          Крупным клиентам получателя лучше выбрать руками. Кому не выбрали — распределится вместе с остальными по правилу ниже.
        </p>
        {top.length > 0 && (
          <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchSelect options={ctx.recipients} value="" onChange={v => v && setClientsTarget(top, Number(v))} searchable
              placeholder="Весь топ → …" searchPlaceholder="Имя, должность, отдел…" ariaLabel="Отдать весь топ одному получателю"
              className="w-full sm:w-[280px]" panelClassName={PANEL} />
            {topManual > 0 && <button type="button" className={btnSecondary} onClick={() => setClientsTarget(top, null)}>Сбросить ручные</button>}
          </div>
        )}
        {top.length === 0 ? (
          <div className={`py-2 text-xs ${muted}`}>Топ выключен (0 заказчиков) — все уходят по правилу.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {top.map((c, i) => <TopClientRow key={c.key} ctx={ctx} client={c} pos={i + 1} onSet={t => setClientsTarget([c], t)} />)}
          </ul>
        )}
      </div>

      {/* Правило для остальных */}
      <div className="border-t border-[var(--color-border)] p-3 sm:p-4">
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Остальные и топ без получателя · {fmtNum(freeCount)} {plural(freeCount, ['сделка', 'сделки', 'сделок'])}</h3>
        <RecipientRule ctx={ctx} kind="deal_repeat" freeCount={freeCount}
          hint="Раздаём по очереди туда-обратно: 1-й клиент — первому, 2-й — второму… затем в обратном порядке. Так крупные клиенты не достаются одному, LTV выходит примерно поровну." />
        {dist.length > 0 && (
          <div className="mt-3">
            <p className={`mb-1 text-xs font-medium uppercase ${muted}`}>Кому сколько (с ручными)</p>
            <Distribution rows={dist} withClients valueLabel="LTV" />
          </div>
        )}
      </div>

      {rest.length > 0 && (
        <>
          <Collapse open={openRest} onToggle={() => setOpenRest(o => !o)}>
            {openRest ? 'Скрыть остальных заказчиков' : `Остальные заказчики по рангу · ${fmtNum(rest.length)}`}
          </Collapse>
          {openRest && (
            <div className="border-t border-[var(--color-border)]">
              {rest.length > 10 && <div className="px-3 py-2 sm:px-4"><SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE); }} placeholder="Заказчик или сделка" /></div>}
              <div className={`hidden grid-cols-[3rem_minmax(0,1fr)_9rem_6rem] gap-2 border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-4 py-1.5 text-xs font-medium sm:grid ${muted}`}>
                <span>№</span><span>Заказчик</span><span className="text-right">LTV</span><span className="text-right">отгрузок</span>
              </div>
              <ul className="divide-y divide-[var(--color-border)]">
                {restFiltered.slice(0, limit).map(c => (
                  <RestClientRow key={c.key} ctx={ctx} client={c} pos={topN + rest.indexOf(c) + 1} onReset={() => setClientsTarget([c], null)} />
                ))}
              </ul>
              {restFiltered.length === 0 && <Empty />}
              <MoreButton left={restFiltered.length - limit} onClick={() => setLimit(l => l + PAGE * 2)} />
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ClientHead({ client, pos }: { client: RepeatClient; pos: number }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span className="min-w-0 break-words text-sm font-medium text-[var(--color-text)]"><span className={muted}>{pos}. </span>{client.name}</span>
      <span className={`text-xs tabular-nums ${muted}`}>LTV <b className="text-[var(--color-text)]">{fmtRub(client.ltv)}</b></span>
      <span className={`text-xs tabular-nums ${muted}`}>отгрузок <b className="text-[var(--color-text)]">{fmtNum(client.shipments)}</b></span>
    </div>
  );
}

function DealLines({ ctx, items, showOutcome }: { ctx: DraftCtx; items: DismissalItem[]; showOutcome?: boolean }) {
  return (
    <div className="mt-0.5 flex flex-col gap-0.5">
      {items.map(it => {
        const o = showOutcome ? outcomeText(ctx.resolved.get(it.key), ctx) : null;
        const line = infoLine(it);
        return (
          <span key={it.key} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <ItemTitle item={it} />
            {line && <span className={`text-xs ${muted}`}>{line}</span>}
            {o && <span className={`text-xs ${o.bad ? 'text-[var(--color-negative)]' : muted}`}>{o.text}</span>}
          </span>
        );
      })}
    </div>
  );
}

function TopClientRow({ ctx, client, pos, onSet }: { ctx: DraftCtx; client: RepeatClient; pos: number; onSet: (t: number | null) => void }) {
  const manual = client.items.map(it => ctx.plan.overrides[it.key]?.target ?? null);
  const mixed = manual.some(t => t !== manual[0]);
  const same = mixed ? null : manual[0];
  const auto = ctx.resolved.get(client.items[0].key);
  return (
    <li className="flex flex-col gap-2 px-3 py-2 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <ClientHead client={client} pos={pos} />
        <DealLines ctx={ctx} items={client.items} />
      </div>
      <div className="flex flex-col gap-0.5 lg:w-[300px] lg:shrink-0">
        <SearchSelect options={ctx.recipients} value={mixed ? '__mixed' : same ? String(same) : ''} onChange={v => onSet(v ? Number(v) : null)} searchable
          allLabel="Вместе с остальными" placeholder="Разным получателям" searchPlaceholder="Имя, должность, отдел…"
          ariaLabel={`Кому заказчика «${client.name}»`} className="w-full" panelClassName={PANEL} />
        {!same && !mixed && auto?.action === 'transfer' && (
          <span className={`text-[11px] ${muted}`}>по правилу → {auto.target != null ? ctx.nameOf(auto.target) : 'не выбрано'}</span>
        )}
      </div>
    </li>
  );
}

function RestClientRow({ ctx, client, pos, onReset }: { ctx: DraftCtx; client: RepeatClient; pos: number; onReset: () => void }) {
  const manual = client.items.map(it => ctx.plan.overrides[it.key]?.target ?? null).find(Boolean) ?? null;
  return (
    <li className="px-3 py-2 sm:px-4">
      <div className="flex flex-col gap-0.5 sm:grid sm:grid-cols-[3rem_minmax(0,1fr)_9rem_6rem] sm:items-baseline sm:gap-2">
        <span className={`hidden text-xs tabular-nums sm:block ${muted}`}>{pos}</span>
        <span className="min-w-0 break-words text-sm font-medium text-[var(--color-text)]"><span className={`sm:hidden ${muted}`}>{pos}. </span>{client.name}</span>
        <span className="text-xs tabular-nums sm:text-right sm:text-sm"><span className={`sm:hidden ${muted}`}>LTV </span>{fmtRub(client.ltv)}</span>
        <span className="text-xs tabular-nums sm:text-right sm:text-sm"><span className={`sm:hidden ${muted}`}>отгрузок </span>{fmtNum(client.shipments)}</span>
      </div>
      <div className="sm:pl-[3.5rem]">
        {manual && (
          <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] py-0.5 pl-2.5 pr-1 text-xs text-[var(--color-accent)]">
            вручную → {ctx.nameOf(manual)}
            <button type="button" onClick={onReset} aria-label="Сбросить ручного получателя" className="tap-target rounded-full p-0.5 hover:bg-[var(--color-bg-hover)]"><X size={12} /></button>
          </span>
        )}
        <DealLines ctx={ctx} items={client.items} showOutcome />
      </div>
    </li>
  );
}

// ── 2. Первичные сделки ───────────────────────────────────────────────────────────────────────

type PGroup = 'transfer' | 'brak' | 'skip';
const P_GROUPS: { key: PGroup; title: string }[] = [
  { key: 'transfer', title: 'Передаём' },
  { key: 'brak', title: 'В автобрак' },
  { key: 'skip', title: 'Не трогаем' },
];

export function PrimarySection({ ctx }: { ctx: DraftCtx }) {
  const items = useMemo(() => ctx.items.filter(i => i.kind === 'deal_primary'), [ctx.items]);
  const current = (it: DismissalItem) => (ctx.resolved.get(it.key)?.action ?? defaultAction(it)) as PGroup;
  // Снимок групп: строка после смены действия остаётся на месте («→ В автобрак · Вернуть»),
  // переезжает, когда группу сворачивают/разворачивают.
  const [snap, setSnap] = useState<Record<string, PGroup>>(() => Object.fromEntries(items.map(it => [it.key, current(it)])));
  const [open, setOpen] = useState<Record<PGroup, boolean>>({ transfer: items.length <= 60, brak: false, skip: false });
  if (!items.length) return null;
  const groupOf = (it: DismissalItem) => snap[it.key] ?? current(it);
  const toggle = (g: PGroup) => {
    setSnap(Object.fromEntries(items.map(it => [it.key, current(it)])));
    setOpen(o => ({ ...o, [g]: !o[g] }));
  };
  const t = ctx.totals.primary;
  const freeCount = items.filter(it => current(it) === 'transfer' && !ctx.plan.overrides[it.key]?.target).length;
  const dist = [...t.byTarget.entries()].map(([id, e]) => ({ id, name: ctx.nameOf(id), deals: e.deals, value: e.amount })).sort((a, b) => b.deals - a.deals || b.value - a.value);

  return (
    <Section id={SECTION_IDS.primary} num={2} title="Первичные сделки" count={fmtNum(items.length)}>
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <p className={`text-xs ${muted}`}>
          Передаём бронь и дальше или чек от {MIN_AMOUNT_TEXT}. Остальное — в автобрак: сделка уходит в стадию «НЕ ТРОГАТЬ»,
          остаётся на уволенном, задачи по ней закрываются. Любую строку можно перекинуть между группами.
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
          <span>передаём <b>{fmtNum(t.transfer)}</b></span>
          <span className="text-[var(--color-warning)]">в автобрак <b>{fmtNum(t.brak)}</b>{t.brakAmount > 0 && <> · {fmtRub(t.brakAmount)}</>}</span>
          {t.skip > 0 && <span className={muted}>не трогаем <b>{fmtNum(t.skip)}</b></span>}
        </div>
        <RecipientRule ctx={ctx} kind="deal_primary" freeCount={freeCount} hint="Несколько получателей — по кругу, поровну." />
        {dist.length > 0 && (
          <div>
            <p className={`mb-1 text-xs font-medium uppercase ${muted}`}>Кому сколько</p>
            <Distribution rows={dist} valueLabel="сумма" />
          </div>
        )}
      </div>
      {P_GROUPS.map(g => {
        const rows = items.filter(it => groupOf(it) === g.key);
        if (!rows.length) return null;
        const amount = g.key === 'brak' ? rows.reduce((s, it) => s + (it.info?.amount ?? 0), 0) : 0;
        return (
          <PrimaryGroup key={g.key} ctx={ctx} rows={rows} open={open[g.key]} onToggle={() => toggle(g.key)} group={g.key}
            label={<>{g.title} · {fmtNum(rows.length)}{g.key === 'brak' && amount > 0 && <> · {fmtRub(amount)}</>}</>} />
        );
      })}
    </Section>
  );
}

function PrimaryGroup({ ctx, rows, open, onToggle, label, group }: {
  ctx: DraftCtx; rows: DismissalItem[]; open: boolean; onToggle: () => void; label: React.ReactNode; group: PGroup;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const filtered = needle ? rows.filter(it => `${it.title} ${infoLine(it)} ${it.entityId}`.toLowerCase().includes(needle)) : rows;
  return (
    <>
      <Collapse open={open} onToggle={onToggle} tone={group === 'brak' ? 'warn' : undefined}>{label}</Collapse>
      {open && (
        <div className="border-t border-[var(--color-border)]">
          {rows.length > 10 && <div className="px-3 py-2 sm:px-4"><SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE); }} /></div>}
          <ul className="divide-y divide-[var(--color-border)]">
            {filtered.slice(0, limit).map(it => <PrimaryRow key={it.key} ctx={ctx} it={it} group={group} />)}
          </ul>
          {filtered.length === 0 && <Empty />}
          <MoreButton left={filtered.length - limit} onClick={() => setLimit(l => l + PAGE * 2)} />
        </div>
      )}
    </>
  );
}

function PrimaryRow({ ctx, it, group }: { ctx: DraftCtx; it: DismissalItem; group: PGroup }) {
  const r = ctx.resolved.get(it.key);
  const def = defaultAction(it);
  const ov = ctx.plan.overrides[it.key];
  const action = (r?.action ?? def) as PGroup;
  const moved = action !== group;
  const setAction = (a: DismissalAction) =>
    ctx.setOverrides({ [it.key]: a === def && !(a === 'transfer' && ov?.target) ? null : { action: a, target: a === 'transfer' ? ov?.target ?? null : null } });
  const options = (['transfer', 'brak', 'skip'] as DismissalAction[])
    .filter(a => actionAllowed(it, a))
    .map(a => ({ value: a, label: `${DISMISSAL_ACTION_LABELS[a]}${a === def ? ' (по умолчанию)' : ''}` }));
  const o = outcomeText(r, ctx);
  const info = it.info ?? {};
  return (
    <li className={`flex flex-col gap-2 px-3 py-2 sm:px-4 lg:flex-row lg:items-center ${moved ? 'bg-[var(--color-accent-soft)]/40' : ''}`}>
      <div className="min-w-0 flex-1">
        <ItemTitle item={it} />
        {infoLine(it) && <div className={`text-xs ${muted} break-words`}>{infoLine(it)}</div>}
        <div className="flex flex-wrap items-center gap-x-2 text-xs">
          {info.qualified && info.qualifyReason && <span className="text-[var(--color-positive)]">{info.qualifyReason}</span>}
          {!info.qualified && !info.brakAvailable && <span className="text-[var(--color-warning)]">в воронке нет автобрака</span>}
          {moved ? (
            <span className="font-medium text-[var(--color-accent)]">
              → {DISMISSAL_ACTION_LABELS[action]} ·{' '}
              <button type="button" onClick={() => setAction(group)} className="min-h-11 underline sm:min-h-0">Вернуть</button>
            </span>
          ) : action === 'transfer' && <span className={`hidden sm:inline ${o.bad ? 'text-[var(--color-negative)]' : muted}`}>{o.text}</span>}
        </div>
      </div>
      <RowEditor summary={o.text} bad={o.bad} title={it.title || `Сделка #${it.entityId}`}>
        <SearchSelect options={options} value={action} onChange={v => setAction(v as DismissalAction)}
          ariaLabel={`Действие для «${it.title}»`} className="w-full" panelClassName={PANEL_SM} />
        {action === 'transfer' && (
          <SearchSelect options={ctx.recipients} value={ov?.target ? String(ov.target) : ''} searchable allLabel="Получатель по правилу"
            onChange={v => {
              const target = v ? Number(v) : null;
              ctx.setOverrides({ [it.key]: target ? { action: 'transfer', target } : def === 'transfer' ? null : { action: 'transfer', target: null } });
            }}
            searchPlaceholder="Имя, должность, отдел…" ariaLabel={`Кому «${it.title}»`} className="w-full" panelClassName={PANEL} />
        )}
      </RowEditor>
    </li>
  );
}

// ── 3. Задачи и дела ──────────────────────────────────────────────────────────────────────────

const OTHER_KINDS: { kind: DismissalKind; hint: string }[] = [
  { kind: 'task_other', hint: 'Задачи, не привязанные к его открытым сделкам (УПД, внутренние). По умолчанию — на РОПа.' },
  { kind: 'activity_other', hint: 'Звонки, встречи и дела вне его открытых сделок. По умолчанию — на РОПа.' },
  { kind: 'task_creator', hint: 'Задачи, которые он поставил другим. Постановщиком станет РОП — чтобы результат было кому принять.' },
  { kind: 'task_participant', hint: 'Где он соисполнитель или наблюдатель. По умолчанию просто убираем его из задачи.' },
];

export function TasksSection({ ctx }: { ctx: DraftCtx }) {
  const follow = useMemo(() => ctx.items.filter(i => i.kind === 'task_deal' || i.kind === 'activity_deal'), [ctx.items]);
  const others = OTHER_KINDS.filter(o => ctx.items.some(i => i.kind === o.kind));
  if (!follow.length && !others.length) return null;
  const otherCount = ctx.items.filter(i => OTHER_KINDS.some(o => o.kind === i.kind)).length;
  return (
    <Section id={SECTION_IDS.tasks} num={3} title="Задачи и дела" count={fmtNum(follow.length + otherCount)}>
      <div className="pt-2" />
      {follow.length > 0 && <FollowBlock ctx={ctx} items={follow} />}
      {others.map(o => <OtherKindRow key={o.kind} ctx={ctx} kind={o.kind} hint={o.hint} />)}
    </Section>
  );
}

function FollowBlock({ ctx, items }: { ctx: DraftCtx; items: DismissalItem[] }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const tasks = items.filter(i => i.kind === 'task_deal').length;
  const n = { transfer: 0, close: 0, skip: 0 } as Record<string, number>;
  for (const it of items) { const a = ctx.resolved.get(it.key)?.action ?? 'skip'; n[a] = (n[a] ?? 0) + 1; }
  const dealTitle = useMemo(() => new Map(ctx.items.map(i => [i.key, i.title])), [ctx.items]);
  return (
    <div className="border-t border-[var(--color-border)]">
      <div className="flex flex-col gap-1 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">По сделкам</h3>
          <span className={`text-xs ${muted}`}>задач {fmtNum(tasks)} · дел {fmtNum(items.length - tasks)}</span>
        </div>
        <p className={`text-xs ${muted}`}>Уйдут вслед за сделкой тому же получателю. Сделка в автобраке — задачи по ней закроются; сделка остаётся — задача тоже.</p>
        <div className={`flex flex-wrap gap-x-3 text-xs tabular-nums ${muted}`}>
          <span>передать <b className="text-[var(--color-text)]">{fmtNum(n.transfer)}</b></span>
          <span>закрыть <b className="text-[var(--color-text)]">{fmtNum(n.close)}</b></span>
          {n.skip > 0 && <span>остаются <b className="text-[var(--color-text)]">{fmtNum(n.skip)}</b></span>}
        </div>
      </div>
      <Collapse open={open} onToggle={() => setOpen(o => !o)}>{open ? 'Скрыть список' : 'Показать список'}</Collapse>
      {open && (
        <div className="border-t border-[var(--color-border)]">
          <ul className="divide-y divide-[var(--color-border)]">
            {items.slice(0, limit).map(it => {
              const o = outcomeText(ctx.resolved.get(it.key), ctx);
              const deal = it.info?.dealKey ? dealTitle.get(it.info.dealKey) : undefined;
              const line = [deal ? `сделка «${deal}»` : null, infoLine(it) || null].filter(Boolean).join(' · ');
              return (
                <li key={it.key} className="px-3 py-2 sm:px-4">
                  <ItemTitle item={it} />
                  {line && <div className={`text-xs ${muted} break-words`}>{line}</div>}
                  <div className={`text-xs ${o.bad ? 'text-[var(--color-negative)]' : muted}`}>{o.text}</div>
                </li>
              );
            })}
          </ul>
          <MoreButton left={items.length - limit} onClick={() => setLimit(l => l + PAGE * 2)} />
        </div>
      )}
    </div>
  );
}

function OtherKindRow({ ctx, kind, hint }: { ctx: DraftCtx; kind: DismissalKind; hint: string }) {
  const items = useMemo(() => ctx.items.filter(i => i.kind === kind), [ctx.items, kind]);
  const [open, setOpen] = useState(false);
  const rule = ruleOf(ctx.plan, kind);
  const ropKind = kind === 'task_other' || kind === 'activity_other' || kind === 'task_creator';
  const actionOptions = DISMISSAL_ALLOWED_ACTIONS[kind].map(a => ({ value: a, label: actionLabel(kind, a) }));
  const missing = rule.action === 'transfer' && !rule.targets.length && (!ropKind || !ctx.ropName);
  return (
    <div className="border-t border-[var(--color-border)]">
      <div className="flex flex-col gap-2 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{DISMISSAL_KIND_LABELS[kind]}</h3>
          <span className={`text-xs tabular-nums ${muted}`}>{fmtNum(items.length)}</span>
        </div>
        <p className={`text-xs ${muted}`}>{hint}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:max-w-[720px]">
          <SearchSelect options={actionOptions} value={rule.action} onChange={v => ctx.setRule(kind, { action: v as DismissalAction })}
            ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: что сделать`} className="w-full" />
          {rule.action === 'transfer' && (
            <SearchSelect options={ctx.recipients} value={rule.targets[0] ? String(rule.targets[0]) : ''} searchable
              allLabel={ropKind ? (ctx.ropName ? `на РОПа: ${ctx.ropName}` : 'на РОПа (не выбран)') : undefined} placeholder="Выберите получателя"
              onChange={v => ctx.setRule(kind, { targets: v ? [Number(v)] : [], departmentId: null })}
              searchPlaceholder="Имя, должность, отдел…" ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: кому`}
              className={`w-full ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
          )}
        </div>
        {missing && <span className="text-xs text-[var(--color-negative)]">{ropKind ? 'Выберите РОПа в разделе «4. В конце» или получателя здесь.' : 'Выберите, на кого заменить.'}</span>}
      </div>
      <Collapse open={open} onToggle={() => setOpen(o => !o)}>{open ? 'Скрыть список' : 'Список и исключения'}</Collapse>
      {open && <OtherRows ctx={ctx} kind={kind} items={items} />}
    </div>
  );
}

function OtherRows({ ctx, kind, items }: { ctx: DraftCtx; kind: DismissalKind; items: DismissalItem[] }) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const needle = q.trim().toLowerCase();
  const filtered = needle ? items.filter(it => `${it.title} ${infoLine(it)} ${it.entityId}`.toLowerCase().includes(needle)) : items;
  const actionOptions = DISMISSAL_ALLOWED_ACTIONS[kind].map(a => ({ value: a, label: actionLabel(kind, a) }));
  return (
    <div className="border-t border-[var(--color-border)]">
      {items.length > 10 && <div className="px-3 py-2 sm:px-4"><SearchBox value={q} onChange={v => { setQ(v); setLimit(PAGE); }} /></div>}
      <ul className="divide-y divide-[var(--color-border)]">
        {filtered.slice(0, limit).map(it => {
          const r = ctx.resolved.get(it.key);
          const ov = ctx.plan.overrides[it.key];
          const o = outcomeText(r, ctx);
          return (
            <li key={it.key} className={`flex flex-col gap-2 px-3 py-2 sm:px-4 lg:flex-row lg:items-center ${ov ? 'bg-[var(--color-accent-soft)]/40' : ''}`}>
              <div className="min-w-0 flex-1">
                <ItemTitle item={it} />
                <div className={`text-xs ${muted} break-words`}>
                  {infoLine(it)}<span className="hidden sm:inline">{infoLine(it) && ' · '}<span className={o.bad ? 'text-[var(--color-negative)]' : ''}>{o.text}</span></span>
                </div>
              </div>
              <RowEditor summary={o.text} bad={o.bad} title={it.title || `#${it.entityId}`}>
                <SearchSelect options={actionOptions} value={ov?.action ?? ''} allLabel="Как у всех"
                  onChange={v => ctx.setOverrides({ [it.key]: v ? { action: v as DismissalAction, target: v === 'transfer' ? ov?.target ?? null : null } : null })}
                  ariaLabel={`Действие для «${it.title}»`} className="w-full" panelClassName={PANEL_SM} />
                {r?.action === 'transfer' && (
                  <SearchSelect options={ctx.recipients} value={ov?.target ? String(ov.target) : ''} searchable allLabel="Получатель по правилу"
                    onChange={v => {
                      const target = v ? Number(v) : null;
                      ctx.setOverrides({ [it.key]: target ? { action: 'transfer', target } : ov?.action && ov.action !== 'transfer' ? { action: ov.action } : null });
                    }}
                    searchPlaceholder="Имя, должность, отдел…" ariaLabel={`Кому «${it.title}»`} className="w-full" panelClassName={PANEL} />
                )}
              </RowEditor>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && <Empty />}
      <MoreButton left={filtered.length - limit} onClick={() => setLimit(l => l + PAGE * 2)} />
    </div>
  );
}

// ── Скелетон секций, пока грузятся справочники ────────────────────────────────────────────────

export function SectionsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Загружаю сотрудников и отделы">
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
      <Skeleton className="h-32" />
    </div>
  );
}

