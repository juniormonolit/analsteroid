'use client';
// Доска Задачника: колонки по статусу (ТЗ): Новая · В работе · Ждёт контроля · Завершена · На замере · Итог.
// Перетаскивание (нативный HTML5, как в канбане больших чеков) — только мышью и только между
// статусами Битрикса (TaskerPatchableStatus): «На замере» и «Итог» ставит автозамер, не человек.
// Телефон (<sm): одна колонка за раз + переключатель-чипы с переносом строки (CLAUDE.md, правило 12,
// вариант flex-wrap — без горизонтальной ленты); статус там меняется кнопками в карточке задачи.
// sm+: горизонтальная лента колонок с затуханием у краёв, когда правда есть что скроллить.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TASKER_STATUS_LABELS, type TaskerPatchableStatus, type TaskerStatus, type TaskerTask } from '../../types';
import { STATUS_COLOR } from '../shared/format';
import { PATCHABLE } from '../shared/TaskDrawer';
import { TaskCard } from '../shared/TaskCard';

const COLUMNS: TaskerStatus[] = ['new', 'in_progress', 'awaiting_control', 'done', 'measuring', 'result'];
const HINT: Record<TaskerStatus, string> = {
  new: 'Поставлена, менеджер ещё не начал',
  in_progress: 'Менеджер работает',
  awaiting_control: 'Менеджер сдал — проверьте и закройте',
  done: 'Закрыта в Битриксе',
  measuring: 'Ждёт контрольной даты — потом автозамер',
  result: 'Автозамер поставил вердикт',
};
const isPatchable = (s: TaskerStatus): s is TaskerPatchableStatus => (PATCHABLE as TaskerStatus[]).includes(s);

export function TaskerBoard({ tasks, dragEnabled, onOpen, onMove }: {
  tasks: TaskerTask[];
  dragEnabled: boolean;
  onOpen: (t: TaskerTask) => void;
  onMove: (t: TaskerTask, s: TaskerPatchableStatus) => void;
}) {
  const byStatus = useMemo(() => {
    const m = new Map<TaskerStatus, TaskerTask[]>(COLUMNS.map(s => [s, []]));
    for (const t of tasks) m.get(t.status)?.push(t);
    for (const list of m.values()) list.sort((a, b) => a.deadline.localeCompare(b.deadline));
    return m;
  }, [tasks]);

  const [drag, setDrag] = useState<TaskerTask | null>(null);
  const [over, setOver] = useState<TaskerStatus | null>(null);
  // Колонка, показанная на телефоне. По умолчанию — первая непустая из рабочих.
  const [phoneCol, setPhoneCol] = useState<TaskerStatus | null>(null);
  const shownPhone = phoneCol ?? COLUMNS.find(s => (byStatus.get(s)?.length ?? 0) > 0) ?? 'new';

  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tasks]);

  const canDrop = (s: TaskerStatus) => !!drag && s !== drag.status && isPatchable(s) && isPatchable(drag.status) && drag.bitrixTaskId != null;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
      {/* Переключатель колонок — только телефон. */}
      <div className="flex min-w-0 flex-wrap gap-1.5 sm:hidden" role="tablist" aria-label="Статус">
        {COLUMNS.map(s => {
          const on = s === shownPhone;
          return (
            <button key={s} type="button" role="tab" aria-selected={on} onClick={() => setPhoneCol(s)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
              {TASKER_STATUS_LABELS[s]}<span className="tabular-nums opacity-70">{byStatus.get(s)?.length ?? 0}</span>
            </button>
          );
        })}
      </div>

      <div className="relative min-w-0 flex-1 sm:min-h-0">
        <div ref={scrollRef} onScroll={measure} className="scroll-x h-full">
          <div className="flex h-full min-w-0 items-stretch gap-2.5">
            {COLUMNS.map(s => {
              const list = byStatus.get(s) ?? [];
              const dropOk = canDrop(s);
              const dim = !!drag && !dropOk && s !== drag.status;
              return (
                <section key={s} data-column={s} aria-label={TASKER_STATUS_LABELS[s]}
                  onDragOver={e => { if (dropOk) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== s) setOver(s); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === s ? null : o)); }}
                  onDrop={e => { e.preventDefault(); const c = drag; setDrag(null); setOver(null); if (c && dropOk && isPatchable(s)) onMove(c, s); }}
                  className={`${s === shownPhone ? 'flex' : 'hidden'} w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl bg-[var(--color-bg-surface)] transition-opacity sm:flex sm:h-full sm:w-72 ${dim ? 'opacity-40' : ''} ${over === s ? 'ring-2 ring-[var(--color-accent)]' : ''}`}>
                  <header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5" title={HINT[s]}>
                    <span aria-hidden className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                    <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{TASKER_STATUS_LABELS[s]}</h2>
                    <span className="ml-auto shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{list.length}</span>
                  </header>
                  <p className="shrink-0 px-3 pb-1 text-[11px] text-[var(--color-text-muted)]">{HINT[s]}</p>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
                    {list.map(t => (
                      <TaskCard key={t.id} task={t} onOpen={onOpen}
                        draggable={dragEnabled && isPatchable(t.status) && t.bitrixTaskId != null}
                        dragging={drag?.id === t.id}
                        onDragStart={setDrag}
                        onDragEnd={() => { setDrag(null); setOver(null); }} />
                    ))}
                    {list.length === 0 && <div className="px-1 py-3 text-center text-xs text-[var(--color-text-muted)]">пусто</div>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        {edges.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 hidden w-8 bg-gradient-to-r from-[var(--color-bg)] to-transparent sm:block" />}
        {edges.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-8 bg-gradient-to-l from-[var(--color-bg)] to-transparent sm:block" />}
      </div>
    </div>
  );
}
