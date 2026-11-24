'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Shuffle, ChevronRight, ExternalLink, Info, RefreshCw, Search, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import {
  DISMISSAL_ACTION_LABELS, DISMISSAL_ALLOWED_ACTIONS, DISMISSAL_KINDS, DISMISSAL_KIND_LABELS,
  type DismissalAction, type DismissalItem, type DismissalKind, type DismissalOverride, type DismissalPlan,
  type DismissalRule, type DismissalRunDetail,
} from '../types';
import { runKey, savePlan, useDismissalDepartments, useDismissalUsers, useRunCommand } from './api';
import { fmtNum, planTotals, plural, resolveItems, ruleOf, ruleTargets, type DeptManagers, type ResolvedItem } from './planMath';
import { ErrorBox, btnPrimary, btnSecondary, card, recipientOptions } from './shared';

// Главный экран «Увольнятора» — черновик плана: правило на вид + исключения по строкам.
// План живёт локально и сохраняется PATCH-ем с дебаунсом; сервер — источник правды только
// при монтировании (иначе ответ на старый PATCH затирал бы свежие правки).

const SAVE_DEBOUNCE_MS = 700;
const PAGE = 50;

/** Пояснение действия в контексте вида (transfer у участников задач — «заменить на…»). */
function actionLabel(kind: DismissalKind, a: DismissalAction): string {
  if (a === 'transfer' && kind === 'task_participant') return 'Заменить на получателя';
  if (a === 'close' && kind === 'task_responsible') return 'Завершить задачу';
  if (a === 'close' && kind === 'activity') return 'Отметить выполненным';
  return DISMISSAL_ACTION_LABELS[a];
}

type SaveState = { s: 'idle' | 'saving' | 'saved' } | { s: 'error'; msg: string };

export function DraftEditor({ run }: { run: DismissalRunDetail }) {
  const qc = useQueryClient();
  const users = useDismissalUsers();
  const departments = useDismissalDepartments();
  const cmd = useRunCommand(run.id);
  const [plan, setPlan] = useState<DismissalPlan>(() => ({
    rules: run.plan?.rules ?? {}, overrides: run.plan?.overrides ?? {}, note: run.plan?.note ?? '',
  }));
  const [save, setSave] = useState<SaveState>({ s: 'idle' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const planRef = useRef(plan);

  const doSave = useCallback(async (p: DismissalPlan) => {
    setSave({ s: 'saving' });
    try {
      const detail = await savePlan(run.id, p);
      dirty.current = false;
      // Кэш обновляем (счётчики/строки), но локальный план не трогаем.
      qc.setQueryData(runKey(run.id), detail);
      setSave({ s: 'saved' });
      return true;
    } catch (e) {
      setSave({ s: 'error', msg: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }, [qc, run.id]);

  const update = (fn: (p: DismissalPlan) => DismissalPlan) => {
    const next = fn(planRef.current);
    planRef.current = next;
    setPlan(next);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void doSave(planRef.current); }, SAVE_DEBOUNCE_MS);
  };

  /** Досохранить отложенное перед командой (start/rescan). */
  const flush = async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (dirty.current) return doSave(planRef.current);
    return true;
  };

  // Уход со страницы с несохранённым — досохраняем «в фоне».
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); void savePlan(run.id, planRef.current).catch(() => {}); }
  }, [run.id]);

  const recipients = useMemo(() => recipientOptions(users.data, run.source.bitrixId), [users.data, run.source.bitrixId]);
  // «Раскидать по отделу»: активные менеджеры отдела без уволенного. Отдел уволенного — первым.
  const deptManagers: DeptManagers = useCallback(id => (departments.data?.find(d => d.id === id)?.managers ?? [])
    .filter(m => m.active && m.bitrixId !== run.source.bitrixId).map(m => m.bitrixId), [departments.data, run.source.bitrixId]);
  const deptOptions = useMemo<SearchSelectOption[]>(() => {
    const own = run.source.departmentId;
    return (departments.data ?? [])
      .map(d => ({ d, n: d.managers.filter(m => m.active && m.bitrixId !== run.source.bitrixId).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => Number(b.d.id === own) - Number(a.d.id === own) || a.d.name.localeCompare(b.d.name, 'ru'))
      .map(({ d, n }) => ({
        value: d.id, label: d.name, hint: `${n} ${plural(n, ['менеджер', 'менеджера', 'менеджеров'])}`,
        group: d.id === own ? 'Отдел уволенного' : 'Отделы',
      }));
  }, [departments.data, run.source.departmentId, run.source.bitrixId]);
  const ownDeptId = run.source.departmentId && deptOptions.some(o => o.value === run.source.departmentId) ? run.source.departmentId : null;
  const deptName = useCallback((id: string) => departments.data?.find(d => d.id === id)?.name ?? 'отдел', [departments.data]);
  // «Всем передать»: и сотрудники, и отделы в одном списке (u:123 / d:abc).
  const allOptions = useMemo<SearchSelectOption[]>(() => [
    ...deptOptions.map(o => ({ ...o, value: `d:${o.value}`, label: `Отдел: ${o.label}`, group: o.group === 'Отдел уволенного' ? 'Отдел уволенного — поровну' : 'Отделы — поровну' })),
    ...recipients.map(o => ({ ...o, value: `u:${o.value}`, group: 'Сотрудники' })),
  ], [deptOptions, recipients]);
  const nameOf = useCallback((id: number | null | undefined) => {
    if (id == null) return '—';
    return run.userNames?.[id] ?? users.data?.find(u => u.bitrixId === id)?.name ?? `#${id}`;
  }, [run.userNames, users.data]);

  const byKind = useMemo(() => {
    const m = new Map<DismissalKind, DismissalItem[]>();
    for (const it of run.items) { const a = m.get(it.kind) ?? []; a.push(it); m.set(it.kind, a); }
    return m;
  }, [run.items]);
  const kinds = DISMISSAL_KINDS.filter(k => (byKind.get(k)?.length ?? 0) > 0);

  const resolved = useMemo(() => resolveItems(plan, run.items, deptManagers), [plan, run.items, deptManagers]);
  const resolvedByKind = useMemo(() => {
    const m = new Map<DismissalKind, ResolvedItem[]>();
    for (const r of resolved) { const a = m.get(r.item.kind) ?? []; a.push(r); m.set(r.item.kind, a); }
    return m;
  }, [resolved]);
  const totals = useMemo(() => planTotals(resolved), [resolved]);
  // Правила «по отделу» — для сводки в подтверждении: «по отделу X, поровну на N (~K каждому)».
  const deptRules = useMemo(() => kinds.flatMap(k => {
    const r = ruleOf(plan, k);
    if (r.action !== 'transfer' || !r.departmentId) return [];
    const n = deptManagers(r.departmentId).length;
    const count = (resolvedByKind.get(k) ?? []).filter(x => x.action === 'transfer' && !x.overridden).length;
    return [{ kind: k, deptId: r.departmentId, n, count }];
  }), [kinds, plan, deptManagers, resolvedByKind]);

  const setRule = (kind: DismissalKind, patch: Partial<DismissalRule>) =>
    update(p => ({ ...p, rules: { ...p.rules, [kind]: { ...ruleOf(p, kind), ...patch } } }));
  const setOverride = (key: string, ov: DismissalOverride | null) =>
    update(p => {
      const overrides = { ...p.overrides };
      if (ov) overrides[key] = ov; else delete overrides[key];
      return { ...p, overrides };
    });

  // «Всем передать»: получатель во все виды, где передача возможна; действие вида не меняем
  // (закрытые сделки остаются «не трогать», но получатель уже подставлен на случай переключения).
  const [allTarget, setAllTarget] = useState('');
  const applyAll = (v: string) => {
    setAllTarget(v);
    const [type, raw] = [v.slice(0, 2), v.slice(2)];
    if (!raw) return;
    const patch: Partial<DismissalRule> = type === 'd:' ? { departmentId: raw } : { targets: [Number(raw)], departmentId: null };
    update(p => {
      const rules = { ...p.rules };
      for (const k of kinds) if (DISMISSAL_ALLOWED_ACTIONS[k].includes('transfer')) rules[k] = { ...ruleOf(p, k), ...patch };
      return { ...p, rules };
    });
  };

  const rescan = async () => {
    if (!(await flush())) return;
    cmd.mutate('rescan');
  };
  const start = async () => {
    if (!(await flush())) return;
    cmd.mutate('start', { onSuccess: () => setConfirmOpen(false) });
  };

  const canStart = totals.missingTarget === 0 && totals.transfer + totals.close + totals.remove > 0;

  return (
    <>
      <div className={`${card} mb-3 flex flex-col gap-3 p-3 sm:p-4`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <span className="shrink-0 text-sm font-medium text-[var(--color-text)]">Всем передать:</span>
          <SearchSelect
            options={allOptions} value={allTarget} onChange={applyAll} searchable
            placeholder={users.isLoading ? 'Загружаю сотрудников…' : 'Выберите получателя'}
            searchPlaceholder="Имя, должность, отдел…" ariaLabel="Всем передать"
            className="w-full sm:w-[320px]" panelClassName="w-[400px] max-w-[calc(100vw-16px)]"
          />
          <span className="text-xs text-[var(--color-text-muted)]">быстро заполнить получателя во всех видах — дальше можно поправить по каждому</span>
        </div>
        {users.isError && <ErrorBox>Не удалось загрузить сотрудников: {users.error.message}</ErrorBox>}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Комментарий для истории (необязательно)</span>
          <input
            value={plan.note ?? ''} onChange={e => { const note = e.target.value; update(p => ({ ...p, note })); }}
            placeholder="Например: уходит 30.11, клиентов забирает отдел Иванова"
            className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnSecondary} onClick={rescan} disabled={cmd.isPending}>
            <RefreshCw size={14} className={cmd.isPending && cmd.variables === 'rescan' ? 'animate-spin' : ''} /> Пересобрать
          </button>
          <span className="text-xs text-[var(--color-text-muted)]">
            {save.s === 'saving' ? 'Сохраняю…' : save.s === 'saved' ? 'Изменения сохранены' : save.s === 'idle' ? 'Изменения сохраняются сами' : null}
          </span>
        </div>
        {save.s === 'error' && (
          <ErrorBox>
            Не сохранилось: {save.msg}{' '}
            <button type="button" className="font-medium text-[var(--color-accent)] underline" onClick={() => void doSave(planRef.current)}>Повторить</button>
          </ErrorBox>
        )}
        {cmd.isError && !confirmOpen && <ErrorBox>{cmd.error.message}</ErrorBox>}
      </div>

      {kinds.length === 0 && (
        <div className={`${card} px-4 py-10 text-center text-sm text-[var(--color-text-muted)]`}>
          На аккаунте ничего не нашлось — передавать нечего. Если это неожиданно, нажмите «Пересобрать».
        </div>
      )}

      <div className="flex flex-col gap-3">
        {kinds.map(k => (
          <KindCard
            key={k} kind={k}
            items={resolvedByKind.get(k) ?? []}
            rule={ruleOf(plan, k)}
            overrides={plan.overrides}
            recipients={recipients}
            deptOptions={deptOptions}
            deptManagers={deptManagers}
            deptName={deptName}
            ownDeptId={ownDeptId}
            nameOf={nameOf}
            onRule={patch => setRule(k, patch)}
            onOverride={setOverride}
          />
        ))}
      </div>

      {kinds.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-3 mt-4 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] sm:-mx-6 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                <span>передать <b>{fmtNum(totals.transfer)}</b></span>
                <span>закрыть <b>{fmtNum(totals.close)}</b></span>
                {totals.remove > 0 && <span>убрать из участников <b>{fmtNum(totals.remove)}</b></span>}
                <span className="text-[var(--color-text-muted)]">не трогать <b>{fmtNum(totals.skip)}</b></span>
              </div>
              {totals.missingTarget > 0 && (
                <div className="mt-0.5 text-xs text-[var(--color-negative)]">
                  <span className="sm:hidden">Не выбран получатель: {totals.kindsMissingTarget.length} {plural(totals.kindsMissingTarget.length, ['вид', 'вида', 'видов'])} (выделены красным)</span>
                  <span className="hidden sm:inline">Укажите, кому передать: {totals.kindsMissingTarget.map(k => DISMISSAL_KIND_LABELS[k]).join(', ')}</span>
                </div>
              )}
            </div>
            <button type="button" className={`${btnPrimary} w-full sm:w-auto`} disabled={!canStart || cmd.isPending} onClick={() => { cmd.reset(); setConfirmOpen(true); }}>
              Готово
            </button>
          </div>
        </div>
      )}

      <ConfirmStartModal
        open={confirmOpen} onOpenChange={o => { if (!cmd.isPending) setConfirmOpen(o); }}
        sourceName={run.source.name} totals={totals} nameOf={nameOf}
        deptRules={deptRules} deptName={deptName}
        pending={cmd.isPending && cmd.variables === 'start'}
        error={cmd.isError && cmd.variables === 'start' ? cmd.error.message : null}
        onConfirm={start}
      />
    </>
  );
}

function KindCard({ kind, items, rule, overrides, recipients, deptOptions, deptManagers, deptName, ownDeptId, nameOf, onRule, onOverride }: {
  ownDeptId: string | null;
  kind: DismissalKind;
  items: ResolvedItem[];
  rule: DismissalRule;
  overrides: Record<string, DismissalOverride>;
  recipients: SearchSelectOption[];
  deptOptions: SearchSelectOption[];
  deptManagers: DeptManagers;
  deptName: (id: string) => string;
  nameOf: (id: number | null | undefined) => string;
  onRule: (patch: Partial<DismissalRule>) => void;
  onOverride: (key: string, ov: DismissalOverride | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const allowed = DISMISSAL_ALLOWED_ACTIONS[kind];
  const actionOptions = allowed.map(a => ({ value: a, label: actionLabel(kind, a) }));
  const overriddenCount = items.filter(r => overrides[r.item.key]).length;
  const byDept = rule.departmentId != null;
  const targets = ruleTargets(rule, deptManagers);
  const missing = rule.action === 'transfer' && targets.length === 0;
  const ruleCount = items.filter(r => r.action === 'transfer' && !r.overridden).length;
  const spreadOn = rule.action === 'transfer' && !!ownDeptId && rule.departmentId === ownDeptId;

  return (
    <section className={`${card} ${missing ? 'border-[var(--color-negative)]/60' : ''}`}>
      <div className="flex flex-col gap-3 p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">{DISMISSAL_KIND_LABELS[kind]}</h2>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{fmtNum(items.length)}</span>
          {overriddenCount > 0 && <span className="text-xs text-[var(--color-accent)]">исключений: {fmtNum(overriddenCount)}</span>}
          {kind === 'deal_open' && ownDeptId && (
            <button type="button" disabled={spreadOn}
              onClick={() => onRule({ action: 'transfer', departmentId: ownDeptId })}
              className={`${spreadOn ? btnSecondary : btnPrimary} ml-auto w-full sm:w-auto`}>
              <Shuffle size={14} /> {spreadOn ? `Раскидано по отделу ${deptName(ownDeptId)}` : 'Раскидать по отделу'}
            </button>
          )}
        </div>

        {kind === 'deal_open' && (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
            <Info size={14} className="mt-px shrink-0" />
            <span>Смена ответственного — бизнес-процессом Битрикса «Сменить ответственного»: он сам перепривяжет контакт, компанию и почту сделки.</span>
          </p>
        )}
        {kind === 'deal_closed' && (
          <p className="flex items-start gap-1.5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-text)]">
            <AlertTriangle size={14} className="mt-px shrink-0 text-[var(--color-warning)]" />
            <span>Закрытые сделки — история продаж уволенного: по ним считаются его выручка и планы. По умолчанию не трогаем; передавайте, только если точно нужно.</span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Что сделать</span>
            <SearchSelect options={actionOptions} value={rule.action} onChange={v => onRule({ action: v as DismissalAction })}
              ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: что сделать`} className="w-full" />
          </label>
          {rule.action === 'transfer' && (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-xs text-[var(--color-text-muted)]">
                {kind === 'task_participant' ? 'На кого заменить' : 'Кому'} · несколько — по кругу, поровну
              </span>
              <div className="flex min-w-0 flex-col gap-2">
                <div role="radiogroup" aria-label="Кому передать" className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--color-border)] p-0.5">
                  {([['people', 'Конкретным людям'], ['dept', 'Раскидать по отделу']] as const).map(([m, label]) => {
                    const on = (m === 'dept') === byDept;
                    return (
                      <button key={m} type="button" role="radio" aria-checked={on}
                        onClick={() => onRule(m === 'dept' ? { departmentId: rule.departmentId ?? ownDeptId ?? deptOptions[0]?.value ?? '' } : { departmentId: null })}
                        className={`min-h-11 rounded-md px-2 text-sm ${on ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                        {label}
                      </button>
                    );
                  })}
                </div>
                {byDept ? (
                  <SearchSelect
                    options={deptOptions} value={rule.departmentId ?? ''} onChange={v => onRule({ departmentId: v })} searchable
                    placeholder="Выберите отдел" searchPlaceholder="Название отдела…"
                    ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: отдел`}
                    className={`w-full ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName="w-[400px] max-w-[calc(100vw-16px)]"
                  />
                ) : (
                  <SearchMultiSelect
                    options={recipients} value={rule.targets.map(String)} onChange={v => onRule({ targets: v.map(Number) })}
                    allLabel="Не выбрано" unitLabel="получателей" searchPlaceholder="Имя, должность, отдел…"
                    ariaLabel={`${DISMISSAL_KIND_LABELS[kind]}: кому`}
                    className={`w-full ${missing ? 'border-[var(--color-negative)]' : ''}`} panelClassName="w-[400px] max-w-[calc(100vw-16px)]"
                  />
                )}
                {byDept && rule.departmentId && (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {targets.length ? (
                      <>
                        Поровну на {targets.length} {plural(targets.length, ['менеджера', 'менеджеров', 'менеджеров'])}
                        {ruleCount > 0 && <> (~{fmtNum(Math.ceil(ruleCount / targets.length))} каждому)</>}:{' '}
                        {targets.slice(0, 6).map(id => nameOf(id)).join(', ')}
                        {targets.length > 6 && <> и ещё {targets.length - 6}</>}.
                        {' '}Состав отдела возьмётся в момент «Готово».
                      </>
                    ) : 'В отделе нет действующих менеджеров — выберите другой.'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex min-h-11 w-full items-center gap-2 border-t border-[var(--color-border)] px-3 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] sm:px-4">
        {open ? <ChevronDown size={16} className="shrink-0" /> : <ChevronRight size={16} className="shrink-0" />}
        {open ? 'Скрыть список' : 'Показать список и исключения'}
      </button>
      {open && <ItemRows kind={kind} items={items} rule={rule} ruleText={ruleSummary(kind, rule, targets, nameOf, deptName)} overrides={overrides} recipients={recipients} nameOf={nameOf} onOverride={onOverride} />}
    </section>
  );
}

function ruleSummary(kind: DismissalKind, rule: DismissalRule, targets: number[], nameOf: (id: number) => string, deptName: (id: string) => string): string {
  if (rule.action !== 'transfer') return actionLabel(kind, rule.action);
  const who = rule.departmentId ? `отдел ${deptName(rule.departmentId)}` : targets.length === 1 ? nameOf(targets[0]) : targets.length ? 'по кругу' : '';
  return who ? `${actionLabel(kind, 'transfer')} → ${who}` : actionLabel(kind, 'transfer');
}

function ItemRows({ kind, items, rule, ruleText, overrides, recipients, nameOf, onOverride }: {
  kind: DismissalKind;
  items: ResolvedItem[];
  rule: DismissalRule;
  ruleText: string;
  overrides: Record<string, DismissalOverride>;
  recipients: SearchSelectOption[];
  nameOf: (id: number | null | undefined) => string;
  onOverride: (key: string, ov: DismissalOverride | null) => void;
}) {
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [onlyOverridden, setOnlyOverridden] = useState(false);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter(r =>
      (!onlyOverridden || overrides[r.item.key]) &&
      (!needle || `${r.item.title} ${r.item.subtitle ?? ''} ${r.item.entityId}`.toLowerCase().includes(needle)));
  }, [items, q, onlyOverridden, overrides]);
  const allowed = DISMISSAL_ALLOWED_ACTIONS[kind];
  const actionOptions = allowed.map(a => ({ value: a, label: actionLabel(kind, a) }));
  const hasOverrides = items.some(r => overrides[r.item.key]);

  return (
    <div className="border-t border-[var(--color-border)]">
      {items.length > 10 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 sm:max-w-[360px]">
            <Search size={14} className="shrink-0 text-[var(--color-text-muted)]" />
            <input value={q} onChange={e => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Поиск по названию или №"
              className="min-w-0 flex-1 bg-transparent text-base text-[var(--color-text)] outline-none sm:text-sm" />
            {q && <button type="button" onClick={() => setQ('')} aria-label="Очистить поиск" className="tap-target text-[var(--color-text-muted)]"><X size={14} /></button>}
          </label>
          {hasOverrides && (
            <button type="button" onClick={() => setOnlyOverridden(v => !v)}
              className={`min-h-11 rounded-lg border px-3 text-sm ${onlyOverridden ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
              Только исключения
            </button>
          )}
        </div>
      )}
      <ul className="divide-y divide-[var(--color-border)]">
        {filtered.slice(0, limit).map(r => {
          const ov = overrides[r.item.key];
          return (
            <li key={r.item.key} className={`flex flex-col gap-2 px-3 py-2 sm:px-4 lg:flex-row lg:items-center ${ov ? 'bg-[var(--color-accent-soft)]/40' : ''}`}>
              <div className="min-w-0 flex-1">
                {r.item.url ? (
                  <a href={r.item.url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1 text-sm text-[var(--color-accent)] hover:underline">
                    <span className="min-w-0 break-words">{r.item.title || `#${r.item.entityId}`}</span>
                    <ExternalLink size={12} className="shrink-0" />
                  </a>
                ) : (
                  <span className="text-sm text-[var(--color-text)] break-words">{r.item.title || `#${r.item.entityId}`}</span>
                )}
                <div className="text-xs text-[var(--color-text-muted)] break-words">
                  {r.item.subtitle && <>{r.item.subtitle} · </>}
                  {r.action === 'transfer'
                    ? <span className={r.target == null ? 'text-[var(--color-negative)]' : ''}>{actionLabel(kind, 'transfer')} → {r.target == null ? 'не выбрано' : nameOf(r.target)}</span>
                    : actionLabel(kind, r.action)}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:w-[460px] lg:shrink-0">
                <SearchSelect
                  options={actionOptions} value={ov?.action ?? ''} allLabel={`Как у всех: ${ruleText}`}
                  onChange={v => onOverride(r.item.key, v ? { action: v as DismissalAction, target: v === 'transfer' ? ov?.target ?? null : null } : null)}
                  ariaLabel={`Действие для «${r.item.title}»`} className="w-full" panelClassName="w-[300px] max-w-[calc(100vw-16px)]"
                />
                {r.action === 'transfer' && (
                  <SearchSelect
                    options={recipients} value={ov?.target ? String(ov.target) : ''} searchable
                    allLabel={rule.action === 'transfer' && (rule.departmentId || rule.targets.length) ? 'Получатель по правилу' : 'Выберите получателя'}
                    onChange={v => {
                      const target = v ? Number(v) : null;
                      if (target) onOverride(r.item.key, { action: 'transfer', target });
                      else if (ov?.action === 'transfer' && rule.action === 'transfer') onOverride(r.item.key, null);
                      else onOverride(r.item.key, { action: 'transfer', target: null });
                    }}
                    searchPlaceholder="Имя, должность, отдел…" ariaLabel={`Кому «${r.item.title}»`}
                    className="w-full" panelClassName="w-[400px] max-w-[calc(100vw-16px)]"
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {filtered.length === 0 && <div className="px-4 py-4 text-center text-xs text-[var(--color-text-muted)]">Ничего не нашлось</div>}
      {filtered.length > limit && (
        <button type="button" onClick={() => setLimit(l => l + PAGE * 2)}
          className="flex min-h-11 w-full items-center justify-center border-t border-[var(--color-border)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё (осталось {fmtNum(filtered.length - limit)})
        </button>
      )}
    </div>
  );
}

function ConfirmStartModal({ open, onOpenChange, sourceName, totals, nameOf, deptRules, deptName, pending, error, onConfirm }: {
  deptRules: { kind: DismissalKind; deptId: string; n: number; count: number }[];
  deptName: (id: string) => string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceName: string;
  totals: ReturnType<typeof planTotals>;
  nameOf: (id: number) => string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const recipients = [...totals.byTarget.entries()]
    .map(([id, kinds]) => ({ id, kinds, total: Object.values(kinds).reduce((s, n) => s + (n ?? 0), 0) }))
    .sort((a, b) => b.total - a.total);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Запустить увольнение?" desktopWidth="sm:max-w-lg">
      <div className="flex flex-col gap-3 text-sm text-[var(--color-text)]">
        <p>
          С аккаунта <b>{sourceName}</b>: передать <b>{fmtNum(totals.transfer)}</b>, закрыть <b>{fmtNum(totals.close)}</b>
          {totals.remove > 0 && <>, убрать из участников <b>{fmtNum(totals.remove)}</b></>}, не трогать <b>{fmtNum(totals.skip)}</b>.
        </p>
        {deptRules.length > 0 && (
          <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
            <ul className="flex flex-col gap-0.5">
              {deptRules.map(r => (
                <li key={r.kind} className="break-words">
                  <b>{DISMISSAL_KIND_LABELS[r.kind]}</b> — по отделу «{deptName(r.deptId)}», поровну на {r.n} {plural(r.n, ['менеджера', 'менеджеров', 'менеджеров'])}
                  {r.n > 0 && r.count > 0 && <> (~{fmtNum(Math.ceil(r.count / r.n))} каждому)</>}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Раскладка выше — по текущему составу отдела; точный состав берётся в момент запуска.</p>
          </div>
        )}
        {recipients.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-[var(--color-text-muted)]">Кому что уйдёт</p>
            <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
              {recipients.map(r => (
                <li key={r.id} className="px-3 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 break-words font-medium">{nameOf(r.id)}</span>
                    <span className="shrink-0 tabular-nums">{fmtNum(r.total)}</span>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">
                    {DISMISSAL_KINDS.filter(k => r.kinds[k]).map(k => `${DISMISSAL_KIND_LABELS[k]} ${fmtNum(r.kinds[k] ?? 0)}`).join(' · ')}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-xs text-[var(--color-text-muted)]">
          Исполнитель пойдёт по одной записи с паузами — на сотни строк уйдёт время. Его можно поставить на паузу или отменить;
          уже сделанное в Битриксе при отмене не откатывается.
        </p>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)} disabled={pending}>Отмена</button>
          <button type="button" className={btnPrimary} onClick={onConfirm} disabled={pending}>
            {pending ? 'Запускаю…' : 'Запустить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
