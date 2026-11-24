'use client';

import { useMemo, useState } from 'react';
import { Check, MoreHorizontal, RotateCcw } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { DISMISSAL_KIND_LABELS, type DismissalAction, type DismissalItem, type DismissalKind } from '../../types';
import { fmtNum, plural, ruleOf } from '../planMath';
import { TitleText } from '../ItemRow';
import { PanelCard, Segment } from '../RecipientPanel';
import { StepLayout, WizardFooter } from '../StepLayout';
import { WarnBox, btnSecondary, card } from '../shared';
import type { WizardCtx } from '../wizardCtx';

// Шаг 5 «Задачи без сделок»: задачи и дела вне его сделок — РОПу; постановщик — РОП; участник — убрать.
// Справа — карточка РОПа и сообщений. Внизу — сводка задач по сделкам (уходят за сделкой).

const PANEL = 'w-[400px] max-w-[calc(100vw-16px)]';
const KINDS: { kind: DismissalKind; hint: string; opts: { value: string; label: string }[] }[] = [
  { kind: 'task_other', hint: 'Задачи, не привязанные к его открытым сделкам (УПД, внутренние).', opts: [{ value: 'transfer', label: 'РОПу' }, { value: 'close', label: 'Завершить' }, { value: 'skip', label: 'Не трогать' }] },
  { kind: 'activity_other', hint: 'Звонки, встречи и дела вне его открытых сделок.', opts: [{ value: 'transfer', label: 'РОПу' }, { value: 'close', label: 'Завершить' }, { value: 'skip', label: 'Не трогать' }] },
  { kind: 'task_creator', hint: 'Задачи, которые он поставил другим. Постановщиком станет РОП — чтобы результат было кому принять.', opts: [{ value: 'transfer', label: 'РОПу' }, { value: 'skip', label: 'Не трогать' }] },
  { kind: 'task_participant', hint: 'Где он соисполнитель или наблюдатель. По умолчанию просто убираем его из задачи.', opts: [{ value: 'remove', label: 'Убрать' }, { value: 'transfer', label: 'Заменить' }, { value: 'skip', label: 'Не трогать' }] },
];

function deadlineOf(it: DismissalItem): { text: string; overdue: boolean } | null {
  if (!it.info?.deadline) return null;
  const d = new Date(it.info.deadline);
  if (Number.isNaN(d.getTime())) return null;
  return { text: d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }), overdue: d.getTime() < Date.now() };
}

export function StepTasks({ ctx }: { ctx: WizardCtx }) {
  const ropId = ctx.plan.ropBitrixId ?? null;
  const present = KINDS.filter(k => ctx.items.some(i => i.kind === k.kind));
  const follow = useMemo(() => ctx.items.filter(i => i.kind === 'task_deal' || i.kind === 'activity_deal'), [ctx.items]);
  const [followOpen, setFollowOpen] = useState(false);
  const fT = ctx.totals.follow;

  const ropCard = (
    <PanelCard title="РОП и сообщения">
      <div className="flex flex-col gap-1">
        <SearchSelect options={ctx.recipients} value={ropId ? String(ropId) : ''} onChange={v => ctx.update(p => ({ ...p, ropBitrixId: v ? Number(v) : null }))}
          searchable placeholder={ctx.usersReady ? 'Выберите РОПа' : 'Загружаю сотрудников…'} disabled={!ctx.usersReady} searchPlaceholder="Имя, должность, отдел…"
          ariaLabel="РОП уволенного" className={`w-full ${!ropId ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />
        {ctx.run.rop && ropId === ctx.run.rop.bitrixId && <span className="text-xs text-[var(--color-text-muted)]">Определён автоматически: {ctx.run.rop.name}</span>}
        {ctx.run.rop && ropId && ropId !== ctx.run.rop.bitrixId && <span className="text-xs text-[var(--color-text-muted)]">Автоматически был: {ctx.run.rop.name}</span>}
        {!ropId && <WarnBox>РОП не определился — выберите его: на него уйдут задачи без сделок, ему придёт сообщение.</WarnBox>}
      </div>
      <div className="flex flex-col">
        <Checkbox checked={!!ctx.plan.notifyRop} onChange={v => ctx.update(p => ({ ...p, notifyRop: v }))} label="Написать РОПу со ссылками на задачи" />
        <Checkbox checked={!!ctx.plan.passwordReset} onChange={v => ctx.update(p => ({ ...p, passwordReset: v }))} label={`Задача: ${ctx.kuznetsova} — сменить пароль на аккаунте`} />
      </div>
    </PanelCard>
  );

  return (
    <StepLayout title="5. Задачи без сделок" subtitle="Задачи и дела, не привязанные к его сделкам, уйдут РОПу. Проверьте, кто это."
      footer={plaque => <WizardFooter ctx={ctx} plaque={plaque} />}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,960px)_360px]">
        <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-1">
          {present.length === 0 && (
            <div className={`${card} px-4 py-8 text-center text-sm text-[var(--color-text-muted)]`}>Задач и дел без сделок нет.</div>
          )}
          {present.map(k => <KindBlock key={k.kind} ctx={ctx} kind={k.kind} hint={k.hint} opts={k.opts} />)}
          {follow.length > 0 && (
            <div className="rounded-lg bg-[var(--color-bg-hover)] p-3 text-sm text-[var(--color-text)]">
              Задачи по сделкам — <b>{fmtNum(follow.length)}</b>. Уйдут за сделкой: <b>{fmtNum(fT.transfer)}</b> новому ответственному
              {fT.close > 0 && <>, <b>{fmtNum(fT.close)}</b> закроются с автобраком</>}{fT.skip > 0 && <>, <b>{fmtNum(fT.skip)}</b> останутся вместе со сделкой</>}.{' '}
              <button type="button" onClick={() => setFollowOpen(true)} className="min-h-11 font-medium text-[var(--color-accent)] hover:underline sm:min-h-0">Показать список</button>
            </div>
          )}
        </div>
        <div className="order-1 min-w-0 self-start lg:sticky lg:top-3 lg:order-2">{ropCard}</div>
      </div>
      {followOpen && (
        <Modal open onOpenChange={setFollowOpen} title="Задачи и дела по сделкам" desktopWidth="sm:max-w-2xl">
          <FollowList ctx={ctx} items={follow} />
        </Modal>
      )}
    </StepLayout>
  );
}

function KindBlock({ ctx, kind, hint, opts }: { ctx: WizardCtx; kind: DismissalKind; hint: string; opts: { value: string; label: string }[] }) {
  const items = useMemo(() => ctx.items.filter(i => i.kind === kind), [ctx.items, kind]);
  const [limit, setLimit] = useState(30);
  const rule = ruleOf(ctx.plan, kind);
  const ropKind = kind !== 'task_participant';
  return (
    <section className={card}>
      <div className="flex flex-col gap-2 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{DISMISSAL_KIND_LABELS[kind]}</h3>
          <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{fmtNum(items.length)}</span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="sm:w-[360px]">
            <Segment label={`${DISMISSAL_KIND_LABELS[kind]}: что делать`} value={rule.action} options={opts}
              onChange={v => ctx.setRule(kind, { action: v as DismissalAction, ...(v === 'transfer' && ropKind ? { targets: [], departmentId: null } : {}) })} />
          </div>
          {rule.action === 'transfer' && (ropKind
            ? <span className="text-sm text-[var(--color-text-muted)]">→ {rule.targets[0] ? ctx.nameOf(rule.targets[0]) : ctx.ropName ?? <span className="text-[var(--color-negative)]">РОП не выбран</span>}</span>
            : <SearchSelect options={ctx.recipients} value={rule.targets[0] ? String(rule.targets[0]) : ''} onChange={v => ctx.setRule(kind, { targets: v ? [Number(v)] : [] })}
                searchable placeholder="На кого заменить?" searchPlaceholder="Имя, должность, отдел…" ariaLabel="На кого заменить"
                className={`w-full sm:w-[260px] ${!rule.targets.length ? 'border-[var(--color-negative)]' : ''}`} panelClassName={PANEL} />)}
        </div>
      </div>
      <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
        {items.slice(0, limit).map(it => <TaskRow key={it.key} ctx={ctx} it={it} kind={kind} opts={opts} />)}
      </ul>
      {items.length > limit && (
        <button type="button" onClick={() => setLimit(l => l + 50)}
          className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё (осталось {fmtNum(items.length - limit)})
        </button>
      )}
    </section>
  );
}

function TaskRow({ ctx, it, kind, opts }: { ctx: WizardCtx; it: DismissalItem; kind: DismissalKind; opts: { value: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const ov = ctx.plan.overrides[it.key];
  const r = ctx.resolved.get(it.key);
  const dl = deadlineOf(it);
  const outcome = r?.action === 'transfer' ? `→ ${r.target != null ? ctx.nameOf(r.target) : 'не выбрано'}` : opts.find(o => o.value === r?.action)?.label ?? '';
  return (
    <li className={`flex items-start gap-3 px-3 py-2 sm:px-4 ${ov ? 'bg-[var(--color-accent-soft)]/40' : ''}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm"><TitleText item={it} /></div>
        <div className="flex flex-wrap gap-x-2 text-xs text-[var(--color-text-muted)]">
          {dl && <span className={dl.overdue ? 'text-[var(--color-negative)]' : ''}>срок {dl.text}{dl.overdue && ' · просрочена'}</span>}
          {it.info?.role && <span>{it.info.role}</span>}
          <span className={r?.action === 'transfer' && r.target == null ? 'text-[var(--color-negative)]' : ''}>{outcome}{ov && ' · вручную'}</span>
        </div>
      </div>
      {ov && (
        <button type="button" onClick={() => ctx.setOverrides({ [it.key]: null })} aria-label="Как у всех" title="Как у всех"
          className="tap-target shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><RotateCcw size={14} /></button>
      )}
      <Popover open={open} onOpenChange={setOpen} align="end" className="w-[300px] max-w-[calc(100vw-16px)] p-2"
        trigger={<button type="button" aria-label="Исключение для строки" className="tap-target shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><MoreHorizontal size={16} /></button>}>
        <div className="flex flex-col gap-1">
          <p className="px-1 text-xs text-[var(--color-text-muted)]">Только для этой строки</p>
          {opts.filter(o => !(o.value === 'transfer' && kind === 'task_participant')).map(o => (
            <button key={o.value} type="button" onClick={() => { ctx.setOverrides({ [it.key]: { action: o.value as DismissalAction } }); setOpen(false); }}
              className="flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
              <span className="w-4">{ov?.action === o.value && !ov.target && <Check size={14} />}</span>{o.label}
            </button>
          ))}
          <SearchSelect options={ctx.recipients} value={ov?.target ? String(ov.target) : ''} searchable placeholder={kind === 'task_participant' ? 'Заменить на…' : 'Передать другому…'}
            onChange={v => { if (v) { ctx.setOverrides({ [it.key]: { action: 'transfer', target: Number(v) } }); setOpen(false); } }}
            searchPlaceholder="Имя, должность, отдел…" ariaLabel="Передать другому" className="w-full" panelClassName={PANEL} />
          {ov && <button type="button" onClick={() => { ctx.setOverrides({ [it.key]: null }); setOpen(false); }} className={`${btnSecondary} mt-1`}>Как у всех</button>}
        </div>
      </Popover>
    </li>
  );
}

function FollowList({ ctx, items }: { ctx: WizardCtx; items: DismissalItem[] }) {
  const [limit, setLimit] = useState(100);
  const titleOf = useMemo(() => new Map(ctx.items.map(i => [i.key, i])), [ctx.items]);
  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)]">
        {items.slice(0, limit).map(it => {
          const r = ctx.resolved.get(it.key);
          const deal = it.info?.dealKey ? titleOf.get(it.info.dealKey) : undefined;
          const text = r?.action === 'transfer' ? `→ ${r.target != null ? ctx.nameOf(r.target) : 'получатель сделки не выбран'}` : r?.action === 'close' ? 'закроется (сделка в автобраке)' : 'останется (сделку не трогаем)';
          return (
            <li key={it.key} className="py-2">
              <div className="text-sm"><TitleText item={it} /></div>
              <div className="text-xs text-[var(--color-text-muted)] break-words">
                {DISMISSAL_KIND_LABELS[it.kind]}{deal && <> · сделка «{deal.title}»</>} · <span className={r?.action === 'transfer' && r.target == null ? 'text-[var(--color-negative)]' : ''}>{text}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {items.length > limit && <button type="button" onClick={() => setLimit(l => l + 200)} className={`${btnSecondary} mt-2 w-full`}>Показать ещё ({fmtNum(items.length - limit)} {plural(items.length - limit, ['строка', 'строки', 'строк'])})</button>}
    </div>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-text)]">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span aria-hidden className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)] ${checked ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border-strong)]'}`}>
        {checked && <Check size={14} />}
      </span>
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}
