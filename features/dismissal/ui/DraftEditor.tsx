'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { SearchSelectOption } from '@/components/ui/SearchSelect';
import { enumParam, useUrlState } from '@/lib/hooks/useUrlState';
import {
  PASSWORD_RESET_BITRIX_ID,
  type DismissalKind, type DismissalOverride, type DismissalPlan, type DismissalRule, type DismissalRunDetail,
} from '../types';
import { ApiError, runKey, savePlan, useDismissalDepartments, useDismissalUsers, useRunCommand } from './api';
import { fmtDateTime, plural, planTotals, repeatClients, resolveItems, ruleOf, topCountOf, type DeptManagers } from './planMath';
import { computeStatuses } from './stepStatus';
import { WizardStepper } from './WizardStepper';
import { AnnouncementBanner } from './AnnouncementBanner';
import { ErrorBox, Skeleton, WarnBox, card, recipientOptions } from './shared';
import { STEP_KEYS, type SaveState, type StepKey, type WizardCtx } from './wizardCtx';
import { StepTop } from './steps/StepTop';
import { StepRest } from './steps/StepRest';
import { StepPrimary } from './steps/StepPrimary';
import { StepBrak } from './steps/StepBrak';
import { StepTasks } from './steps/StepTasks';
import { StepFinal } from './steps/StepFinal';

// Черновик «Увольнятора» v3 — мастер из 6 шагов (спека ai_docs/fresh_docs/DISMISSAL_WIZARD_SPEC.md).
// План живёт локально и сохраняется PATCH-ем с дебаунсом. Без гонок: у каждой правки — номер
// версии; запросы идут цепочкой через один inflight-промис; «сохранено» = сервер подтвердил ТЕКУЩУЮ
// версию; flush() перед запуском ждёт текущий запрос и досылает последнюю версию; уход со страницы —
// keepalive.

const SAVE_DEBOUNCE_MS = 700;

export function DraftEditor({ run, existing, title }: { run: DismissalRunDetail; existing?: boolean; title: React.ReactNode }) {
  const qc = useQueryClient();
  const users = useDismissalUsers();
  const departments = useDismissalDepartments();
  const cmd = useRunCommand(run.id);
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const planRef = useRef(plan);
  const version = useRef(0);
  const savedVersion = useRef(0);
  const inflight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const update = useCallback((fn: (p: DismissalPlan) => DismissalPlan) => {
    const next = fn(planRef.current);
    planRef.current = next;
    setPlan(next);
    schedule();
  }, [schedule]);

  useEffect(() => { if (initialFilled) schedule(); }, [initialFilled, schedule]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    let ok = await runSave();
    while (ok && savedVersion.current !== version.current) ok = await runSave();
    return ok;
  }, [runSave]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (savedVersion.current !== version.current) void savePlan(run.id, planRef.current, { keepalive: true }).catch(() => {});
  }, [run.id]);

  // ── Справочники ──
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

  // ── Производные ──
  const resolvedList = useMemo(() => resolveItems(plan, run.items, deptManagers), [plan, run.items, deptManagers]);
  const resolved = useMemo(() => new Map(resolvedList.map(r => [r.item.key, r])), [resolvedList]);
  const totals = useMemo(() => planTotals(resolvedList), [resolvedList]);
  const clients = useMemo(() => repeatClients(run.items), [run.items]);
  const topN = topCountOf(plan);
  const top = useMemo(() => clients.slice(0, topN), [clients, topN]);
  const rest = useMemo(() => clients.slice(topN), [clients, topN]);
  const primaryQ = useMemo(() => run.items.filter(i => i.kind === 'deal_primary' && i.info?.qualified), [run.items]);
  const primaryN = useMemo(() => run.items.filter(i => i.kind === 'deal_primary' && !i.info?.qualified), [run.items]);

  // ── Шаг и посещённые ──
  const defaultStep: StepKey = top.length ? 'top' : rest.length ? 'rest' : primaryQ.length ? 'primary' : primaryN.length ? 'brak' : 'tasks';
  const [step, setStep] = useUrlState('step', { ...enumParam(STEP_KEYS, defaultStep), mode: 'push' });
  const visitedKey = `dismissal-visited:${run.id}`;
  const [visited, setVisited] = useState<Set<StepKey>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(visitedKey) ?? '[]') as StepKey[]); } catch { return new Set(); }
  });
  useEffect(() => {
    setVisited(prev => {
      if (prev.has(step)) return prev;
      const next = new Set(prev).add(step);
      try { sessionStorage.setItem(visitedKey, JSON.stringify([...next])); } catch { /* приватный режим */ }
      return next;
    });
  }, [step, visitedKey]);
  const goStep = useCallback((k: StepKey) => {
    setStep(k);
    rootRef.current?.closest('.overflow-y-auto')?.scrollTo({ top: 0 });
  }, [setStep]);

  const ropId = plan.ropBitrixId ?? null;
  const statuses = useMemo(() => computeStatuses({ plan, items: run.items, resolved, totals, top, rest, primaryQ, primaryN, visited, ropId }),
    [plan, run.items, resolved, totals, top, rest, primaryQ, primaryN, visited, ropId]);

  const ctx: WizardCtx = {
    run, plan, items: run.items, resolved, totals, recipients, deptOptions, deptManagers, deptName, deptsReady, usersReady, ownDeptId, nameOf,
    ropName: ropId ? nameOf(ropId) : null,
    kuznetsova: run.userNames?.[PASSWORD_RESET_BITRIX_ID] ?? users.data?.find(u => u.bitrixId === PASSWORD_RESET_BITRIX_ID)?.name ?? 'Анна Кузнецова',
    clients, top, rest, primaryQ, primaryN, statuses, step, goStep, save,
    retrySave: () => void flush(),
    update,
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
    cmd.mutate('start', { onSettled: () => setStarting(false) });
  };

  const refsLoading = !usersReady || !deptsReady;
  const refsError = users.isError || departments.isError;
  const linkBtn = 'inline-flex min-h-11 items-center px-1 text-xs font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50';

  return (
    <div ref={rootRef}>
      {/* Шапка в одну строку: имя + бейдж; справа — сбор, пересобрать, удалить */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">{title}</div>
        <div className="flex flex-wrap items-center gap-x-3 text-xs text-[var(--color-text-muted)]">
          <span>Собрано {fmtDateTime(run.scannedAt ?? run.createdAt)}</span>
          <button type="button" className={linkBtn} onClick={rescan} disabled={cmd.isPending || starting}>Пересобрать</button>
          <button type="button" className={`${linkBtn} text-[var(--color-negative)]`} onClick={() => setDeleteOpen(true)} disabled={cmd.isPending || starting}>Удалить черновик</button>
        </div>
      </div>

      {run.announcement && <AnnouncementBanner a={run.announcement} onDelete={() => setDeleteOpen(true)} deleteDisabled={cmd.isPending || starting} />}
      {existing && (
        <WarnBox className="mb-3">
          Открыт незавершённый черновик от {fmtDateTime(run.createdAt)}. Данные могли устареть —{' '}
          <button type="button" onClick={rescan} className="font-medium text-[var(--color-accent)] underline">Пересобрать</button>
        </WarnBox>
      )}
      {run.source.active && (
        <WarnBox className="mb-3">Сотрудник ещё активен в Битриксе — на него могут упасть новые сделки после сбора. Отключите аккаунт или пересоберите перед запуском.</WarnBox>
      )}
      {cmd.isError && cmd.variables !== 'start' && <div className="mb-3"><ErrorBox>{cmd.error.message}</ErrorBox></div>}
      {refsError && (
        <div className="mb-3">
          <ErrorBox onRetry={() => { void users.refetch(); void departments.refetch(); }}>
            Не удалось загрузить {users.isError ? 'сотрудников' : 'отделы'}: {(users.error ?? departments.error)?.message}
          </ErrorBox>
        </div>
      )}

      <div className="mb-4">
        <WizardStepper step={step} statuses={statuses} onStep={goStep} />
      </div>

      {run.items.length === 0 && step !== 'tasks' && step !== 'final' && (
        <div className={`${card} mb-3 px-4 py-6 text-center text-sm text-[var(--color-text-muted)]`}>
          На аккаунте ничего не нашлось — передавать нечего. Шаги 5–6 доступны: сообщение РОПу и задача сменить пароль. Если это неожиданно — «Пересобрать».
        </div>
      )}

      {refsLoading && !refsError && step !== 'final' ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]" aria-busy="true" aria-label="Загружаю сотрудников и отделы">
          <Skeleton className="h-[480px]" />
          <Skeleton className="hidden h-64 lg:block" />
        </div>
      ) : (
        <>
          {step === 'top' && <StepTop key={`top:${run.items.length}`} ctx={ctx} />}
          {step === 'rest' && <StepRest ctx={ctx} />}
          {step === 'primary' && <StepPrimary ctx={ctx} />}
          {step === 'brak' && <StepBrak ctx={ctx} />}
          {step === 'tasks' && <StepTasks ctx={ctx} />}
          {step === 'final' && (
            <StepFinal ctx={ctx} onStart={start} starting={starting || (cmd.isPending && cmd.variables === 'start')}
              startError={cmd.isError && cmd.variables === 'start' ? cmd.error.message : null} />
          )}
        </>
      )}

      <ConfirmDialog
        open={deleteOpen} title="Удалить черновик?" tone="danger" confirmLabel="Удалить — увольнение отменено" cancelLabel="Оставить"
        description={'Увольнение будет отменено, бот перестанет напоминать.\nВ Битриксе ничего не менялось и не изменится.'}
        pending={cmd.isPending && cmd.variables === 'cancel'}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (timer.current) { clearTimeout(timer.current); timer.current = null; }
          savedVersion.current = version.current; // удаляем — досохранять незачем
          cmd.mutate('cancel', { onSettled: () => setDeleteOpen(false) });
        }}
      />
    </div>
  );
}
