'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import {
  DISMISSAL_KIND_LABELS, PASSWORD_RESET_BITRIX_ID,
  type DismissalKind, type DismissalOverride, type DismissalPlan, type DismissalRule, type DismissalRunDetail,
} from '../types';
import { ApiError, runKey, savePlan, useDismissalDepartments, useDismissalUsers, useRunCommand } from './api';
import { ROP_FALLBACK_KINDS, fmtDateTime, fmtNum, fmtRub, plural, planTotals, resolveItems, ruleOf, type DeptManagers, type PlanTotals } from './planMath';
import { PrimarySection, RepeatSection, SECTION_IDS, Section, SectionsSkeleton, TasksSection, scrollToSection, type DraftCtx } from './DraftSections';
import { ErrorBox, WarnBox, btnDanger, btnPrimary, btnSecondary, card, recipientOptions } from './shared';

// Главный экран «Увольнятора» v2 — черновик плана. План живёт локально и сохраняется PATCH-ем
// с дебаунсом; сервер — источник правды только при монтировании (иначе ответ на старый PATCH
// затирал бы свежие правки).
//
// Сохранение без гонок: у каждой правки — номер версии; запросы идут цепочкой через один
// inflight-промис; «сохранено» = сервер подтвердил ТЕКУЩУЮ версию. flush() перед запуском
// ждёт текущий запрос и досылает последнюю версию.

const SAVE_DEBOUNCE_MS = 700;

type SaveState = { s: 'idle' | 'saving' | 'saved' } | { s: 'error'; msg: string };

export function DraftEditor({ run, existing }: { run: DismissalRunDetail; existing?: boolean }) {
  const qc = useQueryClient();
  const users = useDismissalUsers();
  const departments = useDismissalDepartments();
  const cmd = useRunCommand(run.id);
  // РОП из сканирования подставляем в план сразу (и досохраняем), чтобы сервер и UI видели одно.
  const initialFilled = !run.plan?.ropBitrixId && !!run.rop;
  const [plan, setPlan] = useState<DismissalPlan>(() => ({
    ...run.plan,
    rules: run.plan?.rules ?? {},
    overrides: run.plan?.overrides ?? {},
    ropBitrixId: run.plan?.ropBitrixId ?? run.rop?.bitrixId ?? null,
    notifyRop: run.plan?.notifyRop ?? true,
    passwordReset: run.plan?.passwordReset ?? true,
    note: run.plan?.note ?? '',
  }));
  const [save, setSave] = useState<SaveState>({ s: 'idle' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const planRef = useRef(plan);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const inflight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Одно сохранение в цепочке: ждёт предыдущее, отправляет актуальную версию. */
  const runSave = useCallback((): Promise<boolean> => {
    const prev = inflight.current ?? Promise.resolve(true);
    const p = prev.then(async () => {
      const v = version.current;
      if (savedVersion.current === v) return true;
      setSave({ s: 'saving' });
      try {
        const detail = await savePlan(run.id, planRef.current);
        savedVersion.current = Math.max(savedVersion.current, v);
        qc.setQueryData(runKey(run.id), detail);
        setSave(version.current === v ? { s: 'saved' } : { s: 'saving' });
        return true;
      } catch (e) {
        // 409 — прогон уже не черновик (запущен/удалён в другой вкладке): перечитываем, экран сменится сам.
        if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: runKey(run.id) });
        setSave({ s: 'error', msg: e instanceof Error ? e.message : String(e) });
        return false;
      }
    });
    inflight.current = p;
    void p.finally(() => { if (inflight.current === p) inflight.current = null; });
    return p;
  }, [qc, run.id]);

  const schedule = useCallback(() => {
    version.current++;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void runSave(); }, SAVE_DEBOUNCE_MS);
  }, [runSave]);

  const update = (fn: (p: DismissalPlan) => DismissalPlan) => {
    const next = fn(planRef.current);
    planRef.current = next;
    setPlan(next);
    schedule();
  };

  useEffect(() => { if (initialFilled) schedule(); }, [initialFilled, schedule]);

  /** Досохранить всё: дождаться текущего запроса и дослать последнюю версию. */
  const flush = async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    let ok = await runSave();
    while (ok && savedVersion.current !== version.current) ok = await runSave();
    return ok;
  };

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (savedVersion.current !== version.current) void savePlan(run.id, planRef.current, { keepalive: true }).catch(() => {});
  }, [run.id]);

  const usersReady = !!users.data;
  const deptsReady = !!departments.data;
  const recipients = useMemo(() => recipientOptions(users.data, run.source.bitrixId), [users.data, run.source.bitrixId]);
  const nameOf = useCallback((id: number | null | undefined) => {
    if (id == null) return '—';
    const n = run.userNames?.[id] ?? users.data?.find(u => u.bitrixId === id)?.name ?? (run.rop?.bitrixId === id ? run.rop.name : null);
    return n ?? (users.isLoading ? '…' : `#${id}`);
  }, [run.userNames, run.rop, users.data, users.isLoading]);

  const deptManagers: DeptManagers = useCallback(id => (departments.data?.find(d => d.id === id)?.managers ?? [])
    .filter(m => m.active && m.bitrixId !== run.source.bitrixId).map(m => m.bitrixId), [departments.data, run.source.bitrixId]);
  const deptOptions = useMemo<SearchSelectOption[]>(() => {
    const own = run.source.departmentId;
    return (departments.data ?? [])
      .map(d => ({ d, n: d.managers.filter(m => m.active && m.bitrixId !== run.source.bitrixId).length }))
      .filter(x => x.n > 0)
      .sort((a, b) => Number(b.d.id === own) - Number(a.d.id === own) || a.d.name.localeCompare(b.d.name, 'ru'))
      .map(({ d, n }) => ({ value: d.id, label: d.name, hint: `${n} ${plural(n, ['менеджер', 'менеджера', 'менеджеров'])}`, group: d.id === own ? 'Отдел уволенного' : 'Отделы' }));
  }, [departments.data, run.source.departmentId, run.source.bitrixId]);
  const deptName = useCallback((id: string) => departments.data?.find(d => d.id === id)?.name ?? 'отдел', [departments.data]);
  const ownDeptId = run.source.departmentId && deptOptions.some(o => o.value === run.source.departmentId) ? run.source.departmentId : null;

  const resolvedList = useMemo(() => resolveItems(plan, run.items, deptManagers), [plan, run.items, deptManagers]);
  const resolved = useMemo(() => new Map(resolvedList.map(r => [r.item.key, r])), [resolvedList]);
  const totals = useMemo(() => planTotals(resolvedList), [resolvedList]);

  const ropId = plan.ropBitrixId ?? null;
  const ropName = ropId ? nameOf(ropId) : null;
  const kuznetsova = run.userNames?.[PASSWORD_RESET_BITRIX_ID] ?? users.data?.find(u => u.bitrixId === PASSWORD_RESET_BITRIX_ID)?.name ?? 'Анна Кузнецова';

  const ctx: DraftCtx = {
    plan, items: run.items, resolved, totals, recipients, deptOptions, deptManagers, deptName, deptsReady, usersReady, ownDeptId, nameOf, ropName,
    setRule: (kind: DismissalKind, patch: Partial<DismissalRule>) =>
      update(p => ({ ...p, rules: { ...p.rules, [kind]: { ...ruleOf(p, kind), ...patch } } })),
    setOverrides: (patch: Record<string, DismissalOverride | null>) =>
      update(p => {
        const overrides = { ...p.overrides };
        for (const [k, v] of Object.entries(patch)) { if (v) overrides[k] = v; else delete overrides[k]; }
        return { ...p, overrides };
      }),
    setTopCount: n => update(p => ({ ...p, topCount: n })),
  };

  const rescan = async () => { if (await flush()) cmd.mutate('rescan'); };
  const start = async () => {
    setStarting(true);
    const ok = await flush();
    if (!ok) { setStarting(false); return; }
    cmd.mutate('start', { onSuccess: () => setConfirmOpen(false), onSettled: () => setStarting(false) });
  };

  // ── Сводка и блокеры ──
  const count = (kinds: DismissalKind[]) => run.items.filter(i => kinds.includes(i.kind)).length;
  const cRepeat = count(['deal_repeat']);
  const cPrimary = count(['deal_primary']);
  const cFollow = count(['task_deal', 'activity_deal']);
  const cOther = count(['task_other', 'activity_other', 'task_creator', 'task_participant']);
  const hasOtherForRop = run.items.some(i => i.kind === 'task_other' || i.kind === 'activity_other');
  const ropNeeded = totals.toRop > 0 || (!!plan.notifyRop && hasOtherForRop);
  const missing = (k: DismissalKind) => (totals.missing[k] ?? 0) > 0;

  const blockers: { label: string; anchor: string }[] = [];
  if (ropNeeded && !ropId) blockers.push({ label: 'выберите РОПа', anchor: SECTION_IDS.final });
  if (missing('deal_repeat')) blockers.push({ label: 'получатели повторки', anchor: SECTION_IDS.repeat });
  if (missing('deal_primary')) blockers.push({ label: 'получатели первички', anchor: SECTION_IDS.primary });
  if ((Object.keys(totals.missing) as DismissalKind[]).some(k => !k.startsWith('deal_') && (totals.missing[k] ?? 0) > 0 && (!ROP_FALLBACK_KINDS.includes(k) || ropId)))
    blockers.push({ label: 'получатели задач', anchor: SECTION_IDS.tasks });
  const blockedAnchors = new Set(blockers.map(b => b.anchor));
  const refsLoading = !usersReady || !deptsReady;
  const refsError = users.isError || departments.isError;
  const hasItems = run.items.length > 0;
  const canOpenConfirm = hasItems && !refsLoading && blockers.length === 0 && save.s !== 'error' && !cmd.isPending;

  const chips = [
    cRepeat > 0 && { id: SECTION_IDS.repeat, label: `1. Повторка · ${fmtNum(cRepeat)}` },
    cPrimary > 0 && { id: SECTION_IDS.primary, label: `2. Первичка · ${fmtNum(cPrimary)}` },
    (cFollow + cOther) > 0 && { id: SECTION_IDS.tasks, label: `3. Задачи и дела · ${fmtNum(cFollow + cOther)}` },
    { id: SECTION_IDS.final, label: '4. В конце' },
  ].filter(Boolean) as { id: string; label: string }[];

  const saveText = save.s === 'saving' ? 'Сохраняю…' : save.s === 'saved' ? 'Сохранено' : save.s === 'error' ? 'Не сохранилось' : 'Сохраняется само';

  return (
    <>
      {/* Шапка черновика: дата сбора, пересобрать, удалить, комментарий */}
      <div className={`${card} mb-3 flex flex-col gap-2 p-3 sm:p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-xs text-[var(--color-text-muted)]">Собрано {fmtDateTime(run.scannedAt ?? run.createdAt)}</span>
          <button type="button" className={btnSecondary} onClick={rescan} disabled={cmd.isPending || starting}>
            <RefreshCw size={14} className={cmd.isPending && cmd.variables === 'rescan' ? 'animate-spin' : ''} /> Пересобрать
          </button>
          <button type="button" className={btnDanger} onClick={() => setDeleteOpen(true)} disabled={cmd.isPending || starting}>
            <Trash2 size={14} /> Удалить черновик
          </button>
        </div>
        <input value={plan.note ?? ''} onChange={e => { const note = e.target.value; update(p => ({ ...p, note })); }}
          placeholder="Комментарий для истории: уходит 30.11, клиентов забирает отдел Иванова…" aria-label="Комментарий для истории"
          className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
        {cmd.isError && !confirmOpen && <ErrorBox>{cmd.error.message}</ErrorBox>}
      </div>

      {existing && (
        <WarnBox className="mb-3">
          Открыт незавершённый черновик от {fmtDateTime(run.createdAt)}. Данные могли устареть —{' '}
          <button type="button" onClick={rescan} className="font-medium text-[var(--color-accent)] underline">Пересобрать</button>
        </WarnBox>
      )}
      {run.source.active && (
        <WarnBox className="mb-3">Сотрудник ещё активен в Битриксе — на него могут упасть новые сделки после сбора. Отключите аккаунт или пересоберите перед запуском.</WarnBox>
      )}
      {ropNeeded && !ropId && (
        <button type="button" onClick={() => scrollToSection(SECTION_IDS.final)}
          className="mb-3 flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 text-left text-sm text-[var(--color-text)]">
          <AlertTriangle size={16} className="shrink-0 text-[var(--color-negative)]" />
          <span className="min-w-0 flex-1">РОП не определился — выберите его в разделе «4. В конце»</span>
        </button>
      )}

      {/* Сводка и якоря */}
      {hasItems && (
        <div className="mb-3">
          <p className="mb-2 text-sm text-[var(--color-text)] break-words">
            <span className="text-[var(--color-text-muted)]">На аккаунте:</span> повторка <b>{fmtNum(cRepeat)}</b> · первичка <b>{fmtNum(cPrimary)}</b> ·
            задачи по сделкам <b>{fmtNum(cFollow)}</b> · без сделок <b>{fmtNum(cOther)}</b>
          </p>
          <nav aria-label="Разделы" className="flex flex-wrap gap-2">
            {chips.map(c => (
              <button key={c.id} type="button" onClick={() => scrollToSection(c.id)}
                className="relative inline-flex min-h-11 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
                {c.label}
                {blockedAnchors.has(c.id) && <span aria-label="нужно заполнить" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--color-negative)]" />}
              </button>
            ))}
          </nav>
        </div>
      )}

      {refsError && (
        <div className="mb-3">
          <ErrorBox onRetry={() => { void users.refetch(); void departments.refetch(); }}>
            Не удалось загрузить {users.isError ? 'сотрудников' : 'отделы'}: {(users.error ?? departments.error)?.message}
          </ErrorBox>
        </div>
      )}

      {!hasItems && (
        <div className={`${card} mb-3 px-4 py-10 text-center text-sm text-[var(--color-text-muted)]`}>
          На аккаунте ничего не нашлось — передавать нечего. Если это неожиданно, нажмите «Пересобрать».
        </div>
      )}

      {hasItems && refsLoading && !refsError ? <SectionsSkeleton /> : (
        <div className="flex flex-col gap-3">
          <RepeatSection ctx={ctx} />
          <PrimarySection ctx={ctx} />
          <TasksSection ctx={ctx} />
          <Section id={SECTION_IDS.final} num={4} title="В конце">
            <div className="flex flex-col gap-3 p-3 sm:p-4">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-[var(--color-text-muted)]">РОП уволенного — получит задачи без сделок и сообщение</span>
                <SearchSelect options={recipients} value={ropId ? String(ropId) : ''} onChange={v => update(p => ({ ...p, ropBitrixId: v ? Number(v) : null }))}
                  searchable placeholder={usersReady ? 'Выберите РОПа' : 'Загружаю сотрудников…'} disabled={!usersReady} searchPlaceholder="Имя, должность, отдел…"
                  ariaLabel="РОП уволенного" className={`w-full sm:w-[360px] ${ropNeeded && !ropId ? 'border-[var(--color-negative)]' : ''}`} panelClassName="w-[400px] max-w-[calc(100vw-16px)]" />
                {run.rop && ropId && ropId !== run.rop.bitrixId && <span className="text-xs text-[var(--color-text-muted)]">Определён автоматически: {run.rop.name}</span>}
                {!run.rop && <span className="text-xs text-[var(--color-warning)]">Автоматически РОП не определился.</span>}
              </label>
              <div className="flex flex-col">
                <Checkbox checked={!!plan.notifyRop} onChange={v => update(p => ({ ...p, notifyRop: v }))}
                  label={`Написать РОПу${ropName ? ` (${ropName})` : ''} про задачи без сделок — со ссылками`} />
                <Checkbox checked={!!plan.passwordReset} onChange={v => update(p => ({ ...p, passwordReset: v }))}
                  label={`Поставить задачу сменить пароль на аккаунте — ${kuznetsova}`} />
              </div>
            </div>
          </Section>
        </div>
      )}

      {hasItems && (
        <div className="sticky bottom-0 z-10 -mx-3 mt-4 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-3 pb-2 pt-2 [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] sm:-mx-6 sm:px-6 md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums">
                <span>Передаём <b>{fmtNum(totals.repeat.transfer + totals.primary.transfer)}</b> {plural(totals.repeat.transfer + totals.primary.transfer, ['сделку', 'сделки', 'сделок'])}</span>
                {totals.primary.brak > 0 && <span className="text-[var(--color-warning)]">в автобрак <b>{fmtNum(totals.primary.brak)}</b></span>}
                {(totals.follow.transfer + totals.otherTransfer) > 0 && <span>задач <b>{fmtNum(totals.follow.transfer + totals.otherTransfer)}</b></span>}
                {totals.toRop > 0 && <span>РОПу <b>{fmtNum(totals.toRop)}</b></span>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className={save.s === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}>
                  {save.s === 'saving' && <Loader2 size={11} className="mr-1 inline animate-spin" />}
                  {save.s === 'saved' && <Check size={11} className="mr-1 inline" />}
                  {saveText}{save.s === 'error' && `: ${save.msg}`}
                </span>
                {save.s === 'error' && <button type="button" onClick={() => void flush()} className="tap-target font-medium text-[var(--color-accent)] underline">Повторить</button>}
                {refsLoading && <span className="text-[var(--color-text-muted)]">Загружаю сотрудников…</span>}
                {blockers.length > 0 && <span className="text-[var(--color-negative)]">Перед запуском:</span>}
                {blockers.map(b => (
                  <button key={b.label} type="button" onClick={() => scrollToSection(b.anchor)}
                    className="tap-target rounded-full border border-[var(--color-negative)]/40 px-2 py-0.5 text-[var(--color-negative)] hover:bg-[var(--color-negative)]/10">
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className={`${btnPrimary} w-full sm:w-auto`} disabled={!canOpenConfirm} onClick={() => { cmd.reset(); setConfirmOpen(true); }}>
              Проверить и запустить
            </button>
          </div>
        </div>
      )}

      <ConfirmStartModal
        open={confirmOpen} onOpenChange={o => { if (!starting && !cmd.isPending) setConfirmOpen(o); }}
        sourceName={run.source.name} totals={totals} nameOf={nameOf} ropName={ropName} kuznetsova={kuznetsova}
        notifyRop={!!plan.notifyRop} passwordReset={!!plan.passwordReset}
        deptNote={(['deal_repeat', 'deal_primary'] as DismissalKind[]).flatMap(k => {
          const d = ruleOf(plan, k).departmentId;
          return d ? [`${DISMISSAL_KIND_LABELS[k]} — по отделу «${deptName(d)}»`] : [];
        })}
        saveError={save.s === 'error' ? save.msg : null} onRetrySave={() => void flush()}
        pending={starting || (cmd.isPending && cmd.variables === 'start')}
        error={cmd.isError && cmd.variables === 'start' ? cmd.error.message : null}
        onConfirm={start}
      />

      <ConfirmDialog
        open={deleteOpen} title="Удалить черновик?" tone="danger" confirmLabel="Удалить" cancelLabel="Оставить"
        description={'План и собранный список будут удалены.\nВ Битриксе ничего не менялось и не изменится.'}
        pending={cmd.isPending && cmd.variables === 'cancel'}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={async () => {
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          savedVersion.current = version.current; // удаляем — досохранять незачем
          cmd.mutate('cancel', { onSettled: () => setDeleteOpen(false) });
        }}
      />
    </>
  );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
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

function ConfirmStartModal({ open, onOpenChange, sourceName, totals, nameOf, ropName, kuznetsova, notifyRop, passwordReset, deptNote, saveError, onRetrySave, pending, error, onConfirm }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sourceName: string;
  totals: PlanTotals;
  nameOf: (id: number) => string;
  ropName: string | null;
  kuznetsova: string;
  notifyRop: boolean;
  passwordReset: boolean;
  deptNote: string[];
  saveError: string | null;
  onRetrySave: () => void;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const [checked, setChecked] = useState(false);
  useEffect(() => { if (!open) setChecked(false); }, [open]);
  const rep = [...totals.repeat.byTarget.entries()].sort((a, b) => b[1].ltv - a[1].ltv);
  const prim = [...totals.primary.byTarget.entries()].sort((a, b) => b[1].deals - a[1].deals);
  const h = 'mb-1 text-xs font-medium uppercase text-[var(--color-text-muted)]';
  const taskLines = [
    (totals.follow.transfer + totals.follow.close) > 0 && <li key="f">по сделкам: вслед за сделкой <b>{fmtNum(totals.follow.transfer)}</b>, закроются <b>{fmtNum(totals.follow.close)}</b></li>,
    totals.toRop > 0 && <li key="r">без сделок — РОПу {ropName && <b>{ropName}</b>}: <b>{fmtNum(totals.toRop)}</b></li>,
    totals.otherTransfer > 0 && <li key="o">другим получателям: <b>{fmtNum(totals.otherTransfer)}</b></li>,
    totals.close > 0 && <li key="c">завершить: <b>{fmtNum(totals.close)}</b></li>,
    totals.remove > 0 && <li key="m">убрать его из участников: <b>{fmtNum(totals.remove)}</b></li>,
  ].filter(Boolean);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Передать дела ${sourceName}?`} desktopWidth="sm:max-w-lg" bodyClassName="p-4 pb-0">
      <div className="flex flex-col gap-4 text-sm text-[var(--color-text)]">
        <WarnBox>Будет изменено <b>{fmtNum(totals.changes)}</b> {plural(totals.changes, ['запись', 'записи', 'записей'])} в Битриксе. Откатить нельзя.</WarnBox>
        {totals.primary.brak > 0 && (
          <WarnBox>В автобрак уйдёт <b>{fmtNum(totals.primary.brak)}</b> {plural(totals.primary.brak, ['сделка', 'сделки', 'сделок'])} первички на <b>{fmtRub(totals.primary.brakAmount)}</b> — они останутся на уволенном в стадии «НЕ ТРОГАТЬ».</WarnBox>
        )}

        {totals.repeat.transfer > 0 && (
          <div>
            <p className={h}>Повторка · {fmtNum(totals.repeat.transfer)} {plural(totals.repeat.transfer, ['сделка', 'сделки', 'сделок'])}</p>
            <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
              {rep.map(([id, e]) => (
                <li key={id} className="flex flex-wrap items-baseline justify-between gap-x-2 px-3 py-2">
                  <span className="min-w-0 break-words">{nameOf(id)}</span>
                  <span className="text-xs tabular-nums text-[var(--color-text-muted)]">
                    <b className="text-[var(--color-text)]">{fmtNum(e.deals)}</b> · {fmtNum(e.clients.size)} зак. · LTV {fmtRub(e.ltv)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(totals.primary.transfer + totals.primary.brak + totals.primary.skip) > 0 && (
          <div>
            <p className={h}>Первичка</p>
            <p>передаём <b>{fmtNum(totals.primary.transfer)}</b> · в автобрак <b>{fmtNum(totals.primary.brak)}</b>{totals.primary.skip > 0 && <> · не трогаем <b>{fmtNum(totals.primary.skip)}</b></>}</p>
            {prim.length > 0 && (
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)] break-words">
                {prim.slice(0, 8).map(([id, e]) => `${nameOf(id)} ${fmtNum(e.deals)}`).join(' · ')}{prim.length > 8 && ` и ещё ${prim.length - 8}`}
              </p>
            )}
          </div>
        )}

        {deptNote.length > 0 && (
          <p className="text-xs text-[var(--color-text-muted)] break-words">{deptNote.join('; ')}. Раскладка — по текущему составу отдела; точный состав берётся в момент запуска.</p>
        )}

        {taskLines.length > 0 && (
          <div>
            <p className={h}>Задачи и дела</p>
            <ul className="flex flex-col gap-0.5">{taskLines}</ul>
          </div>
        )}

        <div>
          <p className={h}>В конце</p>
          <ul className="flex flex-col gap-0.5">
            <li>{notifyRop ? <>Сообщение РОПу {ropName && <b>{ropName}</b>} — со ссылками на задачи без сделок</> : <span className="text-[var(--color-text-muted)]">РОПу — не пишем</span>}</li>
            <li>{passwordReset ? <>Задача сменить пароль — {kuznetsova}</> : <span className="text-[var(--color-text-muted)]">Задачу сменить пароль — не ставим</span>}</li>
          </ul>
        </div>

        {totals.leftOnSource > 0 && <p className="text-[var(--color-text-muted)]">Останется на уволенном: <b className="text-[var(--color-text)]">{fmtNum(totals.leftOnSource)}</b></p>}

        {saveError && <ErrorBox onRetry={onRetrySave}>План не сохранился: {saveError}</ErrorBox>}
        {error && <ErrorBox>{error}</ErrorBox>}

        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-4 py-3">
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
            Я проверил получателей
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={btnSecondary} onClick={() => onOpenChange(false)} disabled={pending}>Отмена</button>
            <button type="button" className={btnPrimary} onClick={onConfirm} disabled={pending || !checked || !!saveError}>
              {pending ? 'Запускаю…' : `Запустить · ${fmtNum(totals.changes)} ${plural(totals.changes, ['запись', 'записи', 'записей'])}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
