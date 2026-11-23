'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock, Plus, Users, X } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import type { TrainingEvent, TrainingQueueResponse, TrainingSlot, TrainingSlotsResponse, TrainingsResponse } from '../types';
import { QUEUE_KEY, SLOTS_KEY, TRAININGS_KEY, getJson } from './api';
import { addDaysKey, ddmm, endOf, isoWeekday, mskDateKey, mskTime, plural, surname, weekStart, WEEKDAYS_SHORT } from './format';
import type { TrainingFormPreset } from './TrainingForm';
import { SlotAssemble, type SlotPick } from './SlotAssemble';

/**
 * Сетка недели тренера (по образцу его Excel): строки — слоты времени, колонки — Пн–Пт (Сб/Вс — если есть).
 * Правила (аудит 23.11, ai_docs/fresh_docs/TASKER_UX_AUDIT.md):
 * - подпись слота («Нулевой цикл · Питер · НЦ · очно») — один раз в заголовке строки, если она одинакова во все дни;
 *   иначе в ячейке маленький чип-закрепление («Москва»), а не текст на всю ячейку;
 * - занятие — заметная карточка: тема, отдел, места X/Y, фамилии;
 * - свободный будущий слот у тренера — видимая (и на таче) кнопка «Собрать занятие» → люди из очереди «Теория»;
 * - прошедшие слоты приглушены и без действий, сегодня — подписанная акцентная колонка;
 * - над сеткой — полоса «что делать»: сколько ждут в очереди / пустая неделя.
 * lg+ — таблица; уже — карточки по дням (на 768 с сайдбаром 5 колонок не читаются).
 */
export function WeekGrid({ canManage, canEnroll, onOpen, onCreate, onOpenQueue }: {
  canManage: boolean;
  canEnroll: boolean;
  onOpen: (id: number) => void;
  onCreate: (preset: TrainingFormPreset) => void;
  onOpenQueue: () => void;
}) {
  const today = mskDateKey(new Date());
  const [monday, setMonday] = useState(() => weekStart(today));
  const [pick, setPick] = useState<SlotPick | null>(null);
  // Режим «тема выбрана»: свободные слоты подсвечены, клик — сборка с людьми этой темы.
  const [focusTheme, setFocusTheme] = useState<string | null>(null);
  // Телефон: показываем один день (лента дней сверху).
  const [phoneDay, setPhoneDay] = useState<string | null>(null);
  const sunday = addDaysKey(monday, 6);
  const slotsQ = useQuery({ queryKey: SLOTS_KEY, queryFn: () => getJson<TrainingSlotsResponse>('/api/tasker/trainings/slots') });
  const evQ = useQuery({
    queryKey: [...TRAININGS_KEY, 'week', monday],
    queryFn: () => getJson<TrainingsResponse>(`/api/tasker/trainings?from=${monday}&to=${sunday}`),
  });
  const queueQ = useQuery({
    queryKey: QUEUE_KEY,
    queryFn: () => getJson<TrainingQueueResponse>('/api/tasker/trainings/queue'),
    enabled: canManage || canEnroll,
  });

  const slots = useMemo(() => (slotsQ.data?.slots ?? []).filter(s => s.active), [slotsQ.data]);
  // Отменённые в сетке не показываем — это расписание, а не журнал.
  const events = useMemo(() => (evQ.data?.events ?? []).filter(e => !e.cancelledAt), [evQ.data]);

  const grid = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => addDaysKey(monday, i));
    const used = new Set<number>([1, 2, 3, 4, 5]);
    for (const s of slots) used.add(s.weekday);
    for (const e of events) used.add(isoWeekday(mskDateKey(e.startsAt)));
    const cols = days.filter(d => used.has(isoWeekday(d)));
    const times = new Set<string>(slots.map(s => s.startTime));
    for (const e of events) times.add(mskTime(e.startsAt));
    const rows = [...times].sort();
    const slotAt = new Map<string, TrainingSlot>(slots.map(s => [`${s.weekday}|${s.startTime}`, s]));
    const evAt = new Map<string, TrainingEvent[]>();
    for (const e of events) {
      const k = `${mskDateKey(e.startsAt)}|${mskTime(e.startsAt)}`;
      evAt.set(k, [...(evAt.get(k) ?? []), e]);
    }
    // Заголовок строки: длительность и подпись, общая для всех слотов этого времени (если одинакова).
    const rowInfo = new Map<string, { duration: number | null; meta: string; uniform: boolean }>();
    for (const t of rows) {
      const ss = cols.map(d => slotAt.get(`${isoWeekday(d)}|${t}`)).filter((s): s is TrainingSlot => !!s);
      const metas = new Set(ss.map(slotMeta));
      const uniform = ss.length === cols.length && metas.size === 1;
      rowInfo.set(t, { duration: ss[0]?.durationMin ?? null, meta: uniform ? [...metas][0] : '', uniform });
    }
    return { cols, rows, slotAt, evAt, rowInfo };
  }, [monday, slots, events]);

  const loading = slotsQ.isLoading || evQ.isLoading;
  const error = (slotsQ.error ?? evQ.error) as Error | null;
  const nowMs = Date.now();
  const startMsOf = (day: string, time: string) => Date.parse(`${day}T${time}:00+03:00`);

  const freeFuture = grid.cols.reduce((n, d) => n + grid.rows.filter(t => {
    const slot = grid.slotAt.get(`${isoWeekday(d)}|${t}`);
    return slot && !grid.evAt.has(`${d}|${t}`) && startMsOf(d, t) > nowMs;
  }).length, 0);

  const queue = queueQ.data;
  const waitingGroups = (queue?.groups ?? [])
    .map(g => ({ id: g.metricId, label: g.label, items: g.items.filter(i => !i.event) }))
    .filter(g => g.items.length > 0);
  const waiting = waitingGroups.reduce((s, g) => s + g.items.length, 0);
  const theme = waitingGroups.find(g => g.id === focusTheme) ?? null;

  const openSlot = (day: string, time: string, slot: TrainingSlot) => setPick({
    meta: slotMeta(slot),
    // Тема выбрана — первые по давности из неё (до «обычно берём»).
    preselect: theme ? theme.items.slice(0, queue?.group.target ?? 4).map(i => i.taskId) : undefined,
    preset: {
      startsAt: new Date(startMsOf(day, time)).toISOString(), durationMin: slot.durationMin, place: slot.place,
      slotId: slot.id, departmentLabel: slot.departmentLabel,
    },
  });

  /** Содержимое ячейки (одинаково для таблицы и списка по дням). */
  const cell = (day: string, time: string, showMeta: boolean) => {
    const evs = grid.evAt.get(`${day}|${time}`) ?? [];
    const slot = grid.slotAt.get(`${isoWeekday(day)}|${time}`) ?? null;
    if (evs.length) return evs.map(e => <EventCard key={e.id} e={e} past={endOf(e.startsAt, e.durationMin).getTime() < nowMs} onOpen={() => onOpen(e.id)} />);
    if (!slot) return null;
    const past = startMsOf(day, time) <= nowMs;
    // Подпись, которой нет в заголовке строки, — чипом (закрепление за отделом и т.п.).
    const tag = showMeta || !grid.rowInfo.get(time)?.uniform ? (slot.departmentLabel || slot.label) : null;
    if (past) return <span title="Слот прошёл" className="px-1 text-[12px] text-[var(--color-text-muted)]">—</span>;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {tag && (
          <span title="Слот закреплён" className="inline-flex min-w-0 max-w-full items-center gap-1 self-start rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
            <Lock size={10} className="shrink-0" /><span className="truncate">{tag}</span>
          </span>
        )}
        {canManage ? (
          // Свободный слот визуально пустой (20 одинаковых кнопок — шум): на мыши «+ Собрать занятие» проявляется
          // по наведению/фокусу ячейки (hover-reveal), на таче виден только бледный «+», тап по ячейке — сборка.
          // В режиме выбранной темы — подсвечен всегда.
          <button type="button" onClick={() => openSlot(day, time, slot)}
            aria-label={`Собрать занятие: ${WEEKDAYS_SHORT[isoWeekday(day)]} ${ddmm(day)}, ${time}${theme ? ` · ${theme.label}` : ''}`}
            className={`group inline-flex min-h-11 w-full min-w-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 text-[12.5px] text-[var(--color-accent)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${theme ? 'border border-dashed border-[var(--color-accent)] bg-[var(--color-bg)]' : 'hover:bg-[var(--color-bg-hover)]'}`}>
            <span className={`inline-flex min-w-0 items-center gap-1 ${theme ? '' : 'hover-reveal'}`}>
              <Plus size={14} className="shrink-0 opacity-70" />
              <span className={`truncate ${theme ? '' : 'hidden pointer-fine:inline'}`}>{theme ? 'Собрать сюда' : 'Собрать занятие'}</span>
            </span>
          </button>
        ) : (
          <span className="text-[12px] text-[var(--color-text-muted)]">свободно</span>
        )}
      </div>
    );
  };

  // Полоса «что делать» над сеткой.
  const banner = !loading && !error && grid.rows.length > 0 && (
    theme ? (
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-2 text-[13px]">
        <span className="min-w-0 flex-1"><b>{theme.label}</b> — ждут {theme.items.length}. Выберите подсвеченный свободный слот: люди подставятся.</span>
        <button type="button" onClick={() => setFocusTheme(null)} className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          <X size={14} /> Отменить
        </button>
      </div>
    ) : waiting > 0 ? (
      <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent-soft)] px-3 py-2.5 text-[13px] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span><b>В очереди {waiting} {plural(waiting, 'человек', 'человека', 'человек')}</b>
            {canManage ? ' — выберите тему, затем свободный слот:' : ` по ${waitingGroups.length} ${plural(waitingGroups.length, 'теме', 'темам', 'темам')}.`}</span>
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {waitingGroups.map(g => canManage ? (
              <button key={g.id} type="button" onClick={() => setFocusTheme(g.id)}
                className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-[var(--color-accent)]/40 bg-[var(--color-bg)] px-3 text-[12.5px] hover:border-[var(--color-accent)]">
                <span className="truncate">{g.label}</span><span className="tabular-nums text-[var(--color-accent)]">{g.items.length}</span>
              </button>
            ) : (
              <span key={g.id} className="max-w-full truncate rounded-full bg-[var(--color-bg)] px-3 py-1 text-[12.5px]">{g.label} · {g.items.length}</span>
            ))}
          </div>
        </div>
        <button type="button" onClick={onOpenQueue} className="min-h-11 shrink-0 self-start rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-bg)] px-3 font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] sm:self-auto">
          Открыть очередь
        </button>
      </div>
    ) : events.length === 0 ? (
      <div className="min-w-0 rounded-xl border border-dashed border-[var(--color-border)] px-3 py-2.5 text-[13px] text-[var(--color-text-secondary)]">
        <b className="text-[var(--color-text)]">На этой неделе занятий нет.</b>{' '}
        {canManage
          ? `Очередь тренера пуста: люди попадают туда, когда РОП ставит задачу «Теория». Занятие можно собрать и вручную — нажмите на любой из ${freeFuture} свободных слотов.`
          : canEnroll
            ? 'Записать менеджера на обучение — задачей с типом «Теория» (попадёт в очередь тренера) или в карточке занятия во вкладке «Ближайшие».'
            : 'Когда тренер назначит занятие, оно появится здесь.'}
      </div>
    ) : null
  );

  const shownPhone = phoneDay && grid.cols.includes(phoneDay) ? phoneDay : grid.cols.includes(today) ? today : grid.cols[0];

  const dayHead = (d: string) => {
    const isToday = d === today;
    const past = d < today;
    return (
      <span className={`inline-flex min-w-0 items-center gap-1.5 ${past ? 'text-[var(--color-text-muted)]' : ''}`}>
        <span className="font-semibold">{WEEKDAYS_SHORT[isoWeekday(d)]}</span>
        <span className="tabular-nums">{ddmm(d)}</span>
        {isToday && <span className="rounded-full bg-[var(--color-accent)] px-2 py-px text-[11px] font-medium text-white">сегодня</span>}
      </span>
    );
  };

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <button type="button" aria-label="Предыдущая неделя" onClick={() => setMonday(addDaysKey(monday, -7))}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-0 px-2 text-sm font-medium tabular-nums">{ddmm(monday)}–{ddmm(addDaysKey(monday, grid.cols.length > 5 ? 6 : 4))}</span>
          <button type="button" aria-label="Следующая неделя" onClick={() => setMonday(addDaysKey(monday, 7))}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]">
            <ChevronRight size={16} />
          </button>
        </div>
        {monday !== weekStart(today) && (
          <button type="button" onClick={() => setMonday(weekStart(today))}
            className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">К текущей неделе</button>
        )}
        {!loading && !error && (
          <span className="ml-auto min-w-0 text-[12.5px] text-[var(--color-text-muted)]">
            {events.length} {plural(events.length, 'занятие', 'занятия', 'занятий')} · свободно {freeFuture}
            {slotsQ.data?.trainer ? ` · тренер ${slotsQ.data.trainer.name}` : ''}
          </span>
        )}
      </div>

      {banner}

      {loading ? (
        <div className="flex min-w-0 flex-col gap-2" aria-busy>
          {[0, 1, 2, 3].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-[var(--color-bg-surface)]" />)}
        </div>
      ) : error ? (
        <div className="rounded-xl bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">
          {error.message}
          <button type="button" onClick={() => { slotsQ.refetch(); evQ.refetch(); }} className="ml-2 underline">Повторить</button>
        </div>
      ) : grid.rows.length === 0 ? (
        <div className="flex min-w-0 flex-col items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
          <span>{canManage ? 'Сетка слотов пуста: задайте дни и время занятий во вкладке «Настройки».' : 'На этой неделе обучений нет.'}</span>
        </div>
      ) : (
        <>
          {/* lg+ — таблица как у тренера */}
          <div className="scroll-x hidden rounded-xl bg-[var(--color-bg-surface)] lg:block">
            <table className="w-full table-fixed border-collapse text-[12.5px]">
              <thead>
                <tr>
                  <th className="w-36 border-b border-[var(--color-border)] px-3 py-2.5 text-left text-[12px] font-medium text-[var(--color-text-muted)]">Слот</th>
                  {grid.cols.map(d => (
                    <th key={d} className={`border-b border-l border-[var(--color-border)] px-2 py-2.5 text-left font-normal ${d === today ? 'border-t-2 border-t-[var(--color-accent)] bg-[var(--color-accent-soft)]' : ''}`}>
                      {dayHead(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(t => {
                  const info = grid.rowInfo.get(t)!;
                  return (
                    <tr key={t} className="align-top">
                      <th scope="row" className="border-b border-[var(--color-border)] px-3 py-2 text-left font-normal">
                        <span className="block text-[13px] font-semibold tabular-nums">{t}{info.duration ? `–${mskTime(endOf(`${today}T${t}:00+03:00`, info.duration))}` : ''}</span>
                        {info.meta && <span className="mt-0.5 block break-words text-[11.5px] leading-snug text-[var(--color-text-muted)]">{info.meta}</span>}
                      </th>
                      {grid.cols.map(d => (
                        <td key={d} className={`border-b border-l border-[var(--color-border)] p-1.5 ${d === today ? 'bg-[var(--color-accent-soft)]' : ''}`}>
                          <div className="flex min-w-0 flex-col gap-1">{cell(d, t, false)}</div>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Телефон — лента дней (без скролла: 5–7 равных ячеек), показан один день. */}
          <div className="grid min-w-0 gap-1 sm:hidden" style={{ gridTemplateColumns: `repeat(${grid.cols.length}, minmax(0, 1fr))` }} role="tablist" aria-label="День недели">
            {grid.cols.map(d => {
              const on = d === shownPhone;
              const n = events.filter(e => mskDateKey(e.startsAt) === d).length;
              return (
                <button key={d} type="button" role="tab" aria-selected={on} onClick={() => setPhoneDay(d)}
                  className={`flex min-h-12 min-w-0 flex-col items-center justify-center rounded-lg text-[12px] ${on ? 'bg-[var(--color-accent)] text-white' : d === today ? 'text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]' : d < today ? 'text-[var(--color-text-muted)]' : 'bg-[var(--color-bg-surface)]'}`}>
                  <span className="font-semibold">{WEEKDAYS_SHORT[isoWeekday(d)]}</span>
                  <span className="tabular-nums">{d.slice(8)}</span>
                  <span aria-label={`${n} занятий`} className="flex h-1.5 gap-0.5">
                    {Array.from({ length: Math.min(n, 3) }, (_, i) => <span key={i} className={`size-1.5 rounded-full ${on ? 'bg-white' : 'bg-[var(--color-accent)]'}`} />)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Телефон (выбранный день) и планшет (все дни в 2 колонки) */}
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:hidden">
            {grid.cols.map(d => {
              const dayRows = grid.rows.filter(t => grid.evAt.has(`${d}|${t}`) || grid.slotAt.has(`${isoWeekday(d)}|${t}`));
              const shown = dayRows.filter(t => grid.evAt.has(`${d}|${t}`) || startMsOf(d, t) > nowMs);
              const hiddenPast = dayRows.length - shown.length;
              return (
                <div key={d} className={`${d === shownPhone ? 'flex' : 'hidden sm:flex'} min-w-0 flex-col gap-1.5 rounded-xl bg-[var(--color-bg-surface)] p-2.5 ${d === today ? 'sm:ring-2 sm:ring-[var(--color-accent)]' : ''}`}>
                  <h3 className="text-[13px]">{dayHead(d)}</h3>
                  {shown.length === 0 && (
                    <p className="text-[12.5px] text-[var(--color-text-muted)]">{d < today || hiddenPast ? 'Занятий не было' : 'Слотов нет'}</p>
                  )}
                  {shown.map(t => (
                    <div key={t} className="flex min-w-0 items-start gap-2 border-t border-[var(--color-border)] pt-1.5">
                      <span className="w-12 shrink-0 pt-1 text-[12.5px] font-semibold tabular-nums">{t}</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">{cell(d, t, true)}</div>
                    </div>
                  ))}
                  {hiddenPast > 0 && shown.length > 0 && (
                    <p className="border-t border-[var(--color-border)] pt-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                      {hiddenPast} {plural(hiddenPast, 'слот', 'слота', 'слотов')} уже прошли
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <Drawer open={pick !== null} onOpenChange={o => { if (!o) setPick(null); }} title="Собрать занятие">
        {pick && (
          <SlotAssemble key={pick.preset.startsAt} pick={pick}
            onDone={id => { setPick(null); setFocusTheme(null); onOpen(id); }}
            onManual={() => { const p = pick.preset; setPick(null); onCreate(p); }}
            onCancel={() => setPick(null)} />
        )}
      </Drawer>
    </section>
  );
}

/** «Нулевой цикл · Питер · НЦ · очно» */
function slotMeta(s: TrainingSlot): string {
  return [s.label, s.departmentLabel, s.isOffline ? 'очно' : null].filter(Boolean).join(' · ');
}

function EventCard({ e, past, onOpen }: { e: TrainingEvent; past: boolean; onOpen: () => void }) {
  const names = e.attendees.map(a => surname(a.manager.name));
  const shown = names.slice(0, 3);
  const more = e.enrolledCount - shown.length;
  const cap = e.capacity;
  const full = cap != null && e.enrolledCount >= cap;
  const small = cap != null && e.enrolledCount < 3;
  return (
    <button type="button" onClick={onOpen}
      className={`flex w-full min-w-0 flex-col gap-0.5 rounded-lg border border-[var(--color-border)] border-l-[3px] bg-[var(--color-bg)] px-2 py-1.5 text-left shadow-sm hover:shadow ${past ? 'border-l-[var(--color-text-muted)] opacity-75' : small ? 'border-l-[var(--color-warning)]' : 'border-l-[var(--color-accent)]'}`}>
      <span className="line-clamp-2 min-w-0 break-words text-[12.5px] font-semibold leading-snug">{e.title}</span>
      {e.departmentLabel && <span className="min-w-0 truncate text-[11.5px] text-[var(--color-text-secondary)]">{e.departmentLabel}</span>}
      <span className={`inline-flex items-center gap-1 text-[11.5px] tabular-nums ${full ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-secondary)]'}`}>
        <Users size={12} className="shrink-0" />{e.enrolledCount}{cap != null ? ` / ${cap}` : ''}
        {past ? ' · прошло' : small ? ' · набирается' : ''}
      </span>
      <span className="min-w-0 break-words text-[11.5px] text-[var(--color-text-muted)]">
        {shown.length ? shown.join(', ') : e.enrolledCount ? '' : 'никто не записан'}{more > 0 ? ` +${more}` : ''}
      </span>
    </button>
  );
}
