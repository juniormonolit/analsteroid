'use client';
// Раздел «Задачник» (/tasker, ai_docs/fresh_docs/TASKER_SPEC.md): три вида — Доска / Неделя / Сегодня —
// с общим фильтром и карточкой задачи в Drawer; вкладка «Обучения» ведёт на /tasker/trainings (сессия D),
// «Собрания» — на /tasker/meetings (регулярные собрания, features/tasker/meetings).
// Данные — GET /api/tasker/tasks (view, from/to, фильтр), смена статуса — PATCH /api/tasker/tasks/:id
// с оптимистичным переносом и откатом. Вид, неделя, фильтр и открытая задача — в URL.
// ?mock=1 в dev — моковые данные без API.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react';
import { enumParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { useIsTouch } from '@/lib/hooks/useMediaQuery';
import type { TaskerTask, TaskerTasksResponse, TaskerView } from '../../types';
import { TASKS_KEY, patchTask, useMockFlag, useTaskerFilters, useTaskerMetrics, useTaskerTasks } from './api';
import { addDays, fmtD, mondayOf, todayMsk, type MoveTarget } from './format';
import { TaskerFilters } from './TaskerFilters';
import { TabStrip } from './TabStrip';
import { TaskDrawer } from './TaskDrawer';
import { CreateTaskDrawer } from '../create/CreateTaskDrawer';
import { TaskerBoard } from '../board/TaskerBoard';
import { TaskerWeek } from '../week/TaskerWeek';
import { TaskerToday } from '../today/TaskerToday';
import { useCanManageTemplates } from '../templates/useCanManageTemplates';

const VIEWS = ['board', 'week', 'today'] as const;
const VIEW_LABELS: Record<TaskerView, string> = { board: 'Доска', week: 'Неделя', today: 'Сегодня' };
const tabCls = (on: boolean) => `inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]';

/**
 * Вкладки раздела. В TaskerPage виды переключаются на месте (onSelect); без onSelect (страница
 * /tasker/trainings) — ссылками на /tasker?view=….
 */
export function TaskerTabs({ active, onSelect }: { active: TaskerView | 'trainings' | 'meetings' | 'templates'; onSelect?: (v: TaskerView) => void }) {
  const canTemplates = useCanManageTemplates();
  // Лента без переноса (правило 12; раньше на 375/768 вкладки уезжали во вторую строку).
  const tab = (key: string, on: boolean, label: string, href: string) => onSelect && (VIEWS as readonly string[]).includes(key) ? (
    <button key={key} type="button" data-tab-key={key} aria-current={on ? 'page' : undefined} onClick={() => onSelect(key as TaskerView)} className={`${tabCls(on)} shrink-0`}>{label}</button>
  ) : (
    <Link key={key} href={href} data-tab-key={key} aria-current={on ? 'page' : undefined} className={`${tabCls(on)} shrink-0`}>{label}</Link>
  );
  return (
    <TabStrip activeKey={active} ariaLabel="Вид Задачника" className="w-fit rounded-lg border border-[var(--color-border)]" innerClassName="gap-1 p-0.5">
      {VIEWS.map(v => tab(v, active === v, VIEW_LABELS[v], v === 'board' ? '/tasker' : `/tasker?view=${v}`))}
      {tab('meetings', active === 'meetings', 'Собрания', '/tasker/meetings')}
      {tab('trainings', active === 'trainings', 'Обучения', '/tasker/trainings')}
      {/* На самой странице шаблонов вкладка видна сразу — иначе она «впрыгивала» после загрузки сессии. */}
      {(canTemplates || active === 'templates') && tab('templates', active === 'templates', 'Шаблоны', '/tasker/templates')}
    </TabStrip>
  );
}

function replaceTask(d: TaskerTasksResponse | undefined, t: TaskerTask): TaskerTasksResponse | undefined {
  return d && { ...d, tasks: d.tasks.map(x => (x.id === t.id ? t : x)) };
}

export function TaskerPage({ canAssign }: { canAssign: boolean }) {
  const qc = useQueryClient();
  const mock = useMockFlag();
  const isTouch = useIsTouch();
  const [view, setView] = useUrlState('view', { ...enumParam(VIEWS, 'board'), mode: 'push' });
  const [weekParam, setWeek] = useUrlState('week', stringParam(''));
  const [taskParam, setTaskParam] = useUrlState('task', { ...stringParam(''), mode: 'push' });
  const f = useTaskerFilters();

  const today = todayMsk();
  const monday = /^\d{4}-\d{2}-\d{2}$/.test(weekParam) ? mondayOf(weekParam) : mondayOf(today);
  const range = view === 'week' ? { from: monday, to: addDays(monday, 4) } : view === 'today' ? { from: today, to: today } : null;

  const { data, error, isLoading, isFetching, refetch, queryKey } = useTaskerTasks(view, range, f, mock);
  const metrics = useTaskerMetrics(mock);

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const [busy, setBusy] = useState(false);
  // doneNote — «Что сделано» (обязательно при завершении, форма в карточке). true — сервер принял.
  const move = useCallback(async (t: TaskerTask, status: MoveTarget, doneNote?: string): Promise<boolean> => {
    if (t.status === status) return true;
    await qc.cancelQueries({ queryKey });
    const prev = qc.getQueryData<TaskerTasksResponse>(queryKey);
    qc.setQueryData<TaskerTasksResponse>(queryKey, d => replaceTask(d, { ...t, status }));
    if (mock) return true;
    setBusy(true);
    try {
      const fresh = await patchTask(t.id, { status, ...(doneNote ? { doneNote } : {}) });
      qc.setQueryData<TaskerTasksResponse>(queryKey, d => replaceTask(d, fresh));
      qc.invalidateQueries({ queryKey: [TASKS_KEY] });
      return true;
    } catch (e) {
      qc.setQueryData(queryKey, prev);
      setToast(`Не удалось сменить статус задачи «${t.kind === 'deal' ? `Сделка #${t.dealId ?? '?'}` : t.metricLabel}» (${t.manager.name}): ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }, [qc, queryKey, mock]);

  // Открытая задача — в URL (?task=), держим последний снимок, если после фильтра её не стало в выдаче.
  const lastOpened = useRef<TaskerTask | null>(null);
  const openTask = useMemo(() => {
    const id = Number(taskParam);
    if (!id) return null;
    const found = data?.tasks.find(t => t.id === id);
    if (found) return found;
    return lastOpened.current?.id === id ? lastOpened.current : null;
  }, [data, taskParam]);
  useEffect(() => { if (openTask) lastOpened.current = openTask; }, [openTask]);
  const onOpen = useCallback((t: TaskerTask) => { lastOpened.current = t; setTaskParam(String(t.id)); }, [setTaskParam]);

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className={`flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden ${view === 'board' ? 'sm:overflow-y-hidden' : ''}`}>
      <div className="flex min-w-0 shrink-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Задачник</h1>
          {isFetching && !!data && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg-surface)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]">
              <RefreshCw size={11} className="animate-spin" aria-hidden />обновляется…
            </span>
          )}
          {mock && <span className="rounded bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-xs text-[var(--color-warning)]">моковые данные (dev)</span>}
          {canAssign && (
            <button type="button" onClick={() => setCreateOpen(true)}
              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]">
              <Plus size={16} aria-hidden /> Новая задача
            </button>
          )}
        </header>

        <TaskerTabs active={view} onSelect={v => setView(v)} />

        {/* Неделя — в строке фильтров, а не рядом с вкладками: вкладки не прыгают при переключении вида (аудит 23.11, п.35). */}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {view === 'week' && (
            <div className="flex min-w-0 items-center gap-1" role="group" aria-label="Неделя">
              <button type="button" onClick={() => setWeek(addDays(monday, -7))} aria-label="Предыдущая неделя" className={BTN}><ChevronLeft size={16} /></button>
              <button type="button" onClick={() => setWeek('')} disabled={monday === mondayOf(today)} className={`${BTN} tabular-nums disabled:opacity-100`}>
                {fmtD(monday)}–{fmtD(addDays(monday, 4))}
              </button>
              <button type="button" onClick={() => setWeek(addDays(monday, 7))} aria-label="Следующая неделя" className={BTN}><ChevronRight size={16} /></button>
            </div>
          )}
          <TaskerFilters f={f} data={data} metrics={metrics.data?.metrics ?? []} />
        </div>

        {error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
            {error.status === 403 ? 'Недостаточно прав для Задачника.' : error.message}
            {error.status !== 403 && <button type="button" onClick={() => refetch()} className="ml-2 underline">Повторить</button>}
          </div>
        )}
        {isLoading && !data && !error && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Загружаю задачи…</div>
        )}
        {data && data.tasks.length === 0 && data.sessions.length === 0 && data.trainings.length === 0 && !(data.meetings?.length) && (
          <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">
            {f.active ? 'По фильтру задач нет.' : canAssign ? 'Задач пока нет. Поставьте первую — кнопкой «Новая задача» или из отчёта «По менеджерам».' : 'Задач пока нет.'}
          </div>
        )}
      </div>

      {data && (view === 'board' ? (
        <TaskerBoard tasks={data.tasks} dragEnabled={!isTouch} onOpen={onOpen} onMove={move} />
      ) : view === 'week' ? (
        <TaskerWeek monday={monday} tasks={data.tasks} sessions={data.sessions} trainings={data.trainings} meetings={data.meetings ?? []} onOpen={onOpen} />
      ) : (
        <TaskerToday tasks={data.tasks} sessions={data.sessions} trainings={data.trainings} meetings={data.meetings ?? []} onOpen={onOpen} />
      ))}

      {openTask && (
        <TaskDrawer task={openTask} mock={mock} busy={busy} onClose={() => setTaskParam('')} onStatus={(t, s, note) => move(t, s, note)} />
      )}

      {canAssign && (
        <CreateTaskDrawer open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { if (!mock) qc.invalidateQueries({ queryKey: [TASKS_KEY] }); }}
          managerIds={f.manager ? [f.manager] : undefined} metricId={f.metric || undefined} />
      )}

      {toast && (
        <div role="alert" className="fixed bottom-4 left-1/2 z-50 w-max max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg bg-[var(--color-negative)] px-4 py-3 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
