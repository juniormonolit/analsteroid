'use client';
// Доска Задачника: Новая · В работе · Завершена · На замере · Вырос · Не вырос (правки собрания 23.11:
// «Ждёт контроля» убрана — РОП закрывает сам; «Итог» разделён по знаку результата).
// Перетаскивание (нативный HTML5, как в канбане больших чеков) — только мышью. Куда можно — moveTargets():
// между «Новая»/«В работе»; из «Завершена»/«На замере» обратно в «В работе», пока нет вердикта (откат
// ошибочного завершения). Бросок в «Завершена» открывает карточку: завершение требует «Что сделано».
// Телефон (<sm): одна колонка за раз + переключатель-чипы с переносом строки (CLAUDE.md, правило 12,
// вариант flex-wrap — без горизонтальной ленты); статус там меняется кнопками в карточке задачи.
// sm+: горизонтальная лента колонок с затуханием у краёв, когда правда есть что скроллить.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskerTask } from '../../types';
import { ChevronDown } from 'lucide-react';
import { BOARD_COLUMNS, BOARD_COLUMN_LABELS, STATUS_COLOR, boardColumn, executorOf, moveTargets, shortName, type BoardColumn, type MoveTarget } from '../shared/format';
import { TaskCard } from '../shared/TaskCard';

const HINT: Record<BoardColumn, string> = {
  new: 'Поставлена, ещё не начата',
  in_progress: 'РОП или тренер работает с менеджером',
  done: 'Закрыта с результатом «Что сделано»',
  measuring: 'Ждёт контрольной даты — потом автозамер',
  grown: 'Автозамер: показатель вырос',
  not_grown: 'Автозамер: без роста или мало данных',
};

/** Группы колонки по исполнителю: от GROUP_FROM карточек и если исполнителей больше одного; иначе — одна группа без заголовка. */
const GROUP_FROM = 6;
function groupsOf(list: TaskerTask[]): { key: string; label: string | null; tasks: TaskerTask[] }[] {
  const m = new Map<string, { label: string; tasks: TaskerTask[] }>();
  for (const t of list) {
    const ex = executorOf(t);
    const key = ex ? `${ex.role === 'менеджер' ? 'self' : ex.person.id}` : 'none';
    const label = !ex ? 'Без исполнителя' : ex.role === 'менеджер' ? 'Ведут сами менеджеры' : `${ex.role ? `${ex.role} ` : ''}${shortName(ex.person.name)}`;
    if (!m.has(key)) m.set(key, { label, tasks: [] });
    m.get(key)!.tasks.push(t);
  }
  if (list.length < GROUP_FROM || m.size < 2) return [{ key: 'all', label: null, tasks: list }];
  return [...m.entries()].map(([key, g]) => ({ key, ...g })).sort((a, b) => b.tasks.length - a.tasks.length || a.label.localeCompare(b.label, 'ru'));
}

export function TaskerBoard({ tasks, dragEnabled, onOpen, onMove }: {
  tasks: TaskerTask[];
  dragEnabled: boolean;
  onOpen: (t: TaskerTask) => void;
  onMove: (t: TaskerTask, s: MoveTarget) => void;
}) {
  const byStatus = useMemo(() => {
    const m = new Map<BoardColumn, TaskerTask[]>(BOARD_COLUMNS.map(s => [s, []]));
    for (const t of tasks) m.get(boardColumn(t))?.push(t);
    for (const list of m.values()) list.sort((a, b) => a.deadline.localeCompare(b.deadline));
    return m;
  }, [tasks]);

  const [drag, setDrag] = useState<TaskerTask | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  // Колонка, показанная на телефоне. По умолчанию — первая непустая из рабочих.
  const [phoneCol, setPhoneCol] = useState<BoardColumn | null>(null);
  const shownPhone = phoneCol ?? BOARD_COLUMNS.find(s => (byStatus.get(s)?.length ?? 0) > 0) ?? 'new';

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

  // Лента чипов (телефон): затухание по краям и автоскролл к активному статусу.
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipEdges, setChipEdges] = useState({ left: false, right: false });
  const measureChips = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    setChipEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  const firstChipScroll = useRef(true);
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    el.querySelector<HTMLElement>(`[data-tab-key="${shownPhone}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: firstChipScroll.current ? 'auto' : 'smooth' });
    firstChipScroll.current = false;
    measureChips();
  }, [shownPhone, measureChips]);

  const occupied = BOARD_COLUMNS.filter(c => (byStatus.get(c)?.length ?? 0) > 0).length;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) => setCollapsed(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const canDrop = (s: BoardColumn) => !!drag && (moveTargets(drag) as BoardColumn[]).includes(s);

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
      {/* Переключатель колонок — только телефон: одна лента вместо трёх рядов чипов (аудит 23.11, п.30).
          CLAUDE.md, правило 12: min-w-0 у родителя, затухание у края, scrollbar-none, автоскролл к активной. */}
      <div className="relative min-w-0 sm:hidden">
        <div ref={chipsRef} onScroll={measureChips} className="scrollbar-none flex min-w-0 gap-1.5 overflow-x-auto" role="tablist" aria-label="Статус">
          {BOARD_COLUMNS.map(s => {
            const on = s === shownPhone;
            return (
              <button key={s} type="button" role="tab" aria-selected={on} data-tab-key={s} onClick={() => setPhoneCol(s)}
                className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
                <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                {BOARD_COLUMN_LABELS[s]}<span className="tabular-nums opacity-70">{byStatus.get(s)?.length ?? 0}</span>
              </button>
            );
          })}
        </div>
        {chipEdges.left && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--color-bg)] to-transparent" />}
        {chipEdges.right && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-[var(--color-bg)] to-transparent" />}
      </div>

      <div className="relative min-w-0 flex-1 sm:min-h-0">
        <div ref={scrollRef} onScroll={measure} className="scroll-x h-full">
          <div className="flex h-full min-w-0 items-stretch gap-2.5">
            {BOARD_COLUMNS.map(s => {
              // Ширина (правка владельца 24.11): занятые колонки делят свободное место (min 300, max 460;
              // если занятых ≤ 2 — без потолка, чтобы карточки встали в 2 столбца), пустые — узкая полоса.
              const list = byStatus.get(s) ?? [];
              const dropOk = canDrop(s);
              const dim = !!drag && !dropOk && s !== boardColumn(drag);
              // Пустая колонка на sm+ — узкая полоса с названием и нулём (во время перетаскивания, если сюда можно, раскрывается).
              const slim = list.length === 0 && !(drag && dropOk);
              return (
                <section key={s} data-column={s} aria-label={BOARD_COLUMN_LABELS[s]}
                  onDragOver={e => { if (dropOk) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (over !== s) setOver(s); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(o => (o === s ? null : o)); }}
                  onDrop={e => { e.preventDefault(); const c = drag; setDrag(null); setOver(null); if (!c || !dropOk) return; if (s === 'done') onOpen(c); else onMove(c, s as MoveTarget); }}
                  className={`${s === shownPhone ? 'flex' : 'hidden'} w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-xl bg-[var(--color-bg-surface)] transition-opacity sm:flex sm:h-full ${slim ? 'sm:w-12' : `sm:min-w-[300px] sm:flex-1 ${occupied > 2 ? 'sm:max-w-[460px]' : ''}`} ${dim ? 'opacity-40' : ''} ${over === s ? 'ring-2 ring-[var(--color-accent)]' : ''}`}>
                  {slim && (
                    <div className="hidden h-full flex-col items-center gap-2 py-3 sm:flex" title={`${BOARD_COLUMN_LABELS[s]}: пусто · ${HINT[s]}`}>
                      <span aria-hidden className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                      <span className="text-xs tabular-nums text-[var(--color-text-muted)]">0</span>
                      <span className="text-sm font-semibold text-[var(--color-text-secondary)] [writing-mode:vertical-rl]">{BOARD_COLUMN_LABELS[s]}</span>
                    </div>
                  )}
                  <div className={`${slim ? 'flex sm:hidden' : 'flex'} min-h-0 flex-1 flex-col`}>
                  <header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5" title={HINT[s]}>
                    <span aria-hidden className="h-4 w-[3px] shrink-0 rounded-full" style={{ background: STATUS_COLOR[s] }} />
                    <h2 className="min-w-0 truncate text-sm font-semibold text-[var(--color-text)]">{BOARD_COLUMN_LABELS[s]}</h2>
                    <span className="ml-auto shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{list.length}</span>
                  </header>
                  <p className="shrink-0 px-3 pb-1 text-[11px] text-[var(--color-text-muted)]">{HINT[s]}</p>
                  <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
                    {/* Много карточек — подгруппы по исполнителю (сворачиваются); широкая колонка — карточки в 2+ столбца. */}
                    {groupsOf(list).map(g => {
                      const key = `${s}|${g.key}`;
                      const open = !collapsed.has(key);
                      return (
                        <div key={g.key} className="flex min-w-0 flex-col gap-2">
                          {g.label && (
                            <button type="button" onClick={() => toggleGroup(key)} aria-expanded={open}
                              className="flex min-h-9 min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">
                              <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
                              <span className="min-w-0 break-words">{g.label}</span>
                              <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">· {g.tasks.length}</span>
                            </button>
                          )}
                          {open && (
                            <div className="grid min-w-0 gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
                              {g.tasks.map(t => (
                                <TaskCard key={t.id} task={t} onOpen={onOpen}
                                  draggable={dragEnabled && moveTargets(t).length > 0}
                                  dragging={drag?.id === t.id}
                                  onDragStart={setDrag}
                                  onDragEnd={() => { setDrag(null); setOver(null); }} />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {list.length === 0 && <div className="px-1 py-3 text-center text-xs text-[var(--color-text-muted)]">Здесь пока ничего — {HINT[s].toLowerCase()}.</div>}
                  </div>
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
