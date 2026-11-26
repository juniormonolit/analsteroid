'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { Drawer } from '@/components/ui/Drawer';
import type { TrainingGroupSettings, TrainingSlotInput, TrainingSlotsResponse } from '../types';
import { QUEUE_KEY, SLOTS_KEY, getJson, saveSlots } from './api';
import { WEEKDAYS_SHORT } from './format';
import { ClosuresSettings } from './Closures';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[12.5px] text-[var(--color-text-secondary)]';

type Row = TrainingSlotInput & { key: string };
let seq = 0;
const newKey = () => `n${++seq}`;

/** Настройки тренера: матрица «время × день», параметры слота — в панели, размер группы. Сохраняется целиком. */
export function SlotSettings() {
  const q = useQuery({ queryKey: SLOTS_KEY, queryFn: () => getJson<TrainingSlotsResponse>('/api/tasker/trainings/slots') });
  if (q.isLoading) return <p className="text-sm text-[var(--color-text-muted)]">Загружаю настройки…</p>;
  if (q.isError) return <p className="text-sm text-[var(--color-negative)]">{(q.error as Error).message}</p>;
  return <SlotEditor key={q.dataUpdatedAt} data={q.data!} />;
}

function SlotEditor({ data }: { data: TrainingSlotsResponse }) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<Row[]>(() => data.slots.map(s => ({ ...s, key: `s${s.id}` })));
  const [group, setGroup] = useState<TrainingGroupSettings>(data.group);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const deptOptions = data.departments.map(d => ({ value: d.id, label: d.name, hint: d.path }));

  const patch = (key: string, p: Partial<Row>) => { setMsg(null); setRows(rs => rs.map(r => (r.key === key ? { ...r, ...p } : r))); };
  const remove = (key: string) => { setMsg(null); setRows(rs => rs.filter(r => r.key !== key)); };

  const mut = useMutation({
    mutationFn: () => saveSlots({ slots: rows.map(({ key: _k, ...r }) => { void _k; return r; }), group }),
    onSuccess: r => {
      qc.setQueryData(SLOTS_KEY, r);
      qc.invalidateQueries({ queryKey: QUEUE_KEY });
      setMsg({ ok: true, text: 'Сохранено' });
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  const days = [1, 2, 3, 4, 5, 6, 7].filter(d => d <= 5 || rows.some(r => r.weekday === d));
  const times = [...new Set(rows.map(r => r.startTime))].sort();
  const at = (d: number, t: string) => rows.find(r => r.weekday === d && r.startTime === t) ?? null;
  const [editKey, setEditKey] = useState<string | null>(null);
  const editing = rows.find(r => r.key === editKey) ?? null;
  const [newTime, setNewTime] = useState('');

  /** Новый слот в клетке: параметры — как у соседа в это же время (обычно строка одинакова по дням). */
  const addAt = (d: number, t: string) => {
    setMsg(null);
    const twin = rows.find(r => r.startTime === t);
    const key = newKey();
    setRows(rs => [...rs, {
      key, id: null, weekday: d, startTime: t, durationMin: twin?.durationMin ?? 45, label: twin?.label ?? null, place: twin?.place ?? null,
      isOffline: twin?.isOffline ?? false, departmentIds: twin?.departmentIds ?? [], departmentLabel: twin?.departmentLabel ?? null, active: true,
    }]);
  };
  const addTime = () => {
    if (!/^\d{2}:\d{2}$/.test(newTime) || times.includes(newTime)) return;
    for (const d of days.filter(x => x <= 5)) addAt(d, newTime);
    setNewTime('');
  };
  const removeTime = (t: string) => { setMsg(null); setRows(rs => rs.filter(r => r.startTime !== t)); };
  /** Скопировать параметры слота на все дни в это время (создаёт недостающие). */
  const applyToRow = (src: Row) => {
    setMsg(null);
    setRows(rs => {
      const params = { durationMin: src.durationMin, label: src.label, place: src.place, isOffline: src.isOffline, departmentIds: src.departmentIds, departmentLabel: src.departmentLabel };
      const next = rs.map(r => (r.startTime === src.startTime ? { ...r, ...params } : r));
      for (const d of days) if (!next.some(r => r.weekday === d && r.startTime === src.startTime)) next.push({ ...src, ...params, key: newKey(), id: null, weekday: d, active: true });
      return next;
    });
  };

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] text-[var(--color-text-secondary)]">
        Сетка {data.trainer.name} (время московское): по ней строится «Неделя» и подбирается время для группы из очереди.
        Нажмите на клетку, чтобы добавить слот или изменить его. Слоты по 45 минут, если не указано иначе.
      </p>

      <fieldset className="grid min-w-0 grid-cols-2 gap-3 rounded-xl border border-[var(--color-border)] p-3 sm:grid-cols-3 lg:grid-cols-5">
        <legend className="px-1 text-[13px] font-medium">Группа</legend>
        <NumField label="Предлагать от, чел." value={group.min} onChange={v => setGroup(g => ({ ...g, min: v }))} />
        <NumField label="Обычно берём" value={group.target} onChange={v => setGroup(g => ({ ...g, target: v }))} />
        <NumField label="Максимум" value={group.max} onChange={v => setGroup(g => ({ ...g, max: v }))} />
        <NumField label="Максимум по материалам" max={100} value={group.maxProduct} onChange={v => setGroup(g => ({ ...g, maxProduct: v }))} />
        <NumField label="Искать вперёд, дней" value={group.horizonDays} onChange={v => setGroup(g => ({ ...g, horizonDays: v }))} />
        <p className="col-span-full text-[12px] text-[var(--color-text-muted)]">
          «Максимум по материалам» — для тем-товарных групп (кровля, фасад…): такие занятия собираются большими группами.
        </p>
      </fieldset>

      {data.canManage && <ClosuresSettings />}

      {/* Матрица «время × день»: подписи один раз в шапке, в клетке — только отличие. */}
      <div className="scroll-x rounded-xl border border-[var(--color-border)]">
        <table className="w-full min-w-[520px] table-fixed border-collapse text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 w-20 bg-[var(--color-bg)] px-2 py-2 text-left text-[12px] font-medium text-[var(--color-text-muted)]">Время</th>
              {days.map(d => <th key={d} className="border-l border-[var(--color-border)] px-2 py-2 text-left font-semibold">{WEEKDAYS_SHORT[d]}</th>)}
            </tr>
          </thead>
          <tbody>
            {times.map(t => (
              <tr key={t} className="border-t border-[var(--color-border)] align-top">
                <th scope="row" className="sticky left-0 bg-[var(--color-bg)] px-2 py-1.5 text-left font-normal">
                  <span className="block font-semibold tabular-nums">{t}</span>
                  <button type="button" onClick={() => removeTime(t)} aria-label={`Удалить время ${t} во всех днях`}
                    className="tap-target mt-0.5 inline-flex items-center text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
                    <Trash2 size={13} />
                  </button>
                </th>
                {days.map(d => {
                  const r = at(d, t);
                  const tag = r ? [r.label, r.departmentLabel].filter(Boolean).join(' · ') : '';
                  return (
                    <td key={d} className="border-l border-[var(--color-border)] p-1">
                      {r ? (
                        <button type="button" onClick={() => setEditKey(r.key)}
                          className={`flex min-h-11 w-full min-w-0 flex-col justify-center rounded-lg px-2 py-1 text-left ${r.active ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]' : 'border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] line-through'}`}>
                          {/* Только отличия: подпись, нестандартная длительность, очно, отделы; обычный слот — галочка. */}
                          {tag ? <span className="min-w-0 truncate font-medium">{tag}</span> : <Check size={15} aria-label="Слот есть" className="text-[var(--color-accent)]" />}
                          {(r.durationMin !== 45 || r.isOffline || r.departmentIds.length > 0) && (
                            <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">
                              {[r.durationMin !== 45 ? `${r.durationMin} мин` : null, r.isOffline ? 'очно' : null, r.departmentIds.length ? `отделов ${r.departmentIds.length}` : null].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </button>
                      ) : (
                        <button type="button" onClick={() => addAt(d, t)} aria-label={`Добавить слот ${WEEKDAYS_SHORT[d]} ${t}`}
                          className="group flex min-h-11 w-full items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
                          <Plus size={14} className="hover-reveal" />
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-2">
        <label className={`${LABEL} w-32`}>Новое время<input type="time" step={300} className={INPUT} value={newTime} onChange={e => setNewTime(e.target.value)} /></label>
        <button type="button" onClick={addTime} disabled={!newTime || times.includes(newTime)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
          <Plus size={14} /> Строка на Пн–Пт
        </button>
        {!days.includes(6) && (
          <button type="button" onClick={() => { const t = times[0] ?? '10:00'; addAt(6, t); }} className="min-h-11 rounded-lg px-3 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">+ Суббота</button>
        )}
      </div>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 bg-[var(--color-bg)] py-2">
        {msg && <span className={`text-[13px] ${msg.ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>{msg.text}</span>}
        <button type="button" onClick={() => mut.mutate()} disabled={mut.isPending}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-5 text-sm font-medium text-white disabled:opacity-50">
          {mut.isPending ? 'Сохраняю…' : 'Сохранить сетку'}
        </button>
      </div>

      <Drawer open={editing !== null} onOpenChange={o => { if (!o) setEditKey(null); }} title={editing ? `Слот · ${WEEKDAYS_SHORT[editing.weekday]} ${editing.startTime}` : 'Слот'}>
        {editing && (
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className={LABEL}>Время<input type="time" step={300} className={INPUT} value={editing.startTime} onChange={e => patch(editing.key, { startTime: e.target.value })} /></label>
              <label className={LABEL}>Минут<input type="number" inputMode="numeric" min={10} max={240} className={INPUT} value={editing.durationMin} onChange={e => patch(editing.key, { durationMin: Number(e.target.value) })} /></label>
            </div>
            <label className={LABEL}>Название<input className={INPUT} value={editing.label ?? ''} maxLength={80} placeholder="Нулевой цикл" onChange={e => patch(editing.key, { label: e.target.value || null })} /></label>
            <label className={LABEL}>Место или ссылка<input className={INPUT} value={editing.place ?? ''} maxLength={300} placeholder="онлайн" onChange={e => patch(editing.key, { place: e.target.value || null })} /></label>
            <div className={LABEL}>
              Для каких отделов
              <SearchMultiSelect options={deptOptions} value={editing.departmentIds} onChange={v => patch(editing.key, { departmentIds: v })}
                allLabel="Для всех" unitLabel="отдела" searchPlaceholder="Поиск отдела" ariaLabel="Закреплённые отделы" className="min-h-11 w-full min-w-0" />
            </div>
            <label className={LABEL}>Подпись в сетке<input className={INPUT} value={editing.departmentLabel ?? ''} maxLength={80} placeholder="Москва" onChange={e => patch(editing.key, { departmentLabel: e.target.value || null })} /></label>
            {editing.departmentLabel && !editing.departmentIds.length && (
              <p className="text-[12.5px] text-[var(--color-warning)]">
                Подпись есть, а отделы не выбраны — в сетке слот подписан, но в автоподбор не попадает. Выберите отделы, чтобы система предлагала его их людям.
              </p>
            )}
            <div className="flex flex-wrap gap-4">
              <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={editing.isOffline} onChange={e => patch(editing.key, { isOffline: e.target.checked })} className="size-4 accent-[var(--color-accent)]" /> Очно</label>
              <label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={editing.active} onChange={e => patch(editing.key, { active: e.target.checked })} className="size-4 accent-[var(--color-accent)]" /> Слот работает</label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
              <button type="button" onClick={() => { remove(editing.key); setEditKey(null); }}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]"><Trash2 size={15} /> Удалить слот</button>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => applyToRow(editing)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 hover:bg-[var(--color-bg-hover)]">
                  Так же во все дни в {editing.startTime}
                </button>
                <button type="button" onClick={() => setEditKey(null)} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 font-medium text-white">Готово</button>
              </div>
            </div>
            <p className="text-[12px] text-[var(--color-text-muted)]">Изменения применятся после «Сохранить сетку».</p>
          </div>
        )}
      </Drawer>
    </section>
  );
}

function NumField({ label, value, onChange, max = 60 }: { label: string; value: number; onChange: (v: number) => void; max?: number }) {
  return (
    <label className={LABEL}>
      {label}
      <input type="number" inputMode="numeric" min={1} max={max} className={INPUT} value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  );
}
