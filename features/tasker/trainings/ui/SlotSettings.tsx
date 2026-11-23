'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type { TrainingGroupSettings, TrainingSlotInput, TrainingSlotsResponse } from '../types';
import { QUEUE_KEY, SLOTS_KEY, getJson, saveSlots } from './api';
import { WEEKDAYS_SHORT } from './format';

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
const LABEL = 'flex min-w-0 flex-col gap-1 text-[12.5px] text-[var(--color-text-secondary)]';

type Row = TrainingSlotInput & { key: string };
let seq = 0;
const newKey = () => `n${++seq}`;

/** Настройки тренера: сетка слотов по дням недели, закрепления отделов, размер группы. Сохраняется целиком. */
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
  const add = (weekday: number) => {
    setMsg(null);
    const last = rows.filter(r => r.weekday === weekday).at(-1);
    setRows(rs => [...rs, {
      key: newKey(), id: null, weekday, startTime: last ? nextTime(last.startTime, last.durationMin) : '09:30', durationMin: 45,
      label: null, place: null, isOffline: false, departmentIds: [], departmentLabel: null, active: true,
    }]);
  };

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

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <p className="text-[13px] text-[var(--color-text-secondary)]">
        Сетка {data.trainer.name}: по этим слотам строится «Неделя» и ищется время для автопредложения. Слот с подписью отдела, но без
        выбранных отделов — закреплён «на словах»: в сетке виден, автоматически не предлагается. Время — московское.
      </p>

      <fieldset className="grid min-w-0 grid-cols-2 gap-3 rounded-xl border border-[var(--color-border)] p-3 sm:grid-cols-4">
        <legend className="px-1 text-[13px] font-medium">Группа</legend>
        <NumField label="Предлагать от, чел." value={group.min} onChange={v => setGroup(g => ({ ...g, min: v }))} />
        <NumField label="Обычно берём" value={group.target} onChange={v => setGroup(g => ({ ...g, target: v }))} />
        <NumField label="Максимум" value={group.max} onChange={v => setGroup(g => ({ ...g, max: v }))} />
        <NumField label="Искать вперёд, дней" value={group.horizonDays} onChange={v => setGroup(g => ({ ...g, horizonDays: v }))} />
      </fieldset>

      {days.map(d => (
        <div key={d} className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3">
          <h3 className="text-sm font-semibold">{WEEKDAYS_SHORT[d]}</h3>
          {rows.filter(r => r.weekday === d).sort((a, b) => a.startTime.localeCompare(b.startTime)).map(r => (
            <div key={r.key} className={`grid min-w-0 grid-cols-2 items-end gap-2 border-t border-[var(--color-border)] pt-2 sm:grid-cols-[112px_80px_1fr_1fr] lg:grid-cols-[112px_80px_1fr_1fr_1.3fr_1fr_auto] ${r.active ? '' : 'opacity-60'}`}>
              <label className={LABEL}>Время<input type="time" step={300} className={INPUT} value={r.startTime} onChange={e => patch(r.key, { startTime: e.target.value })} /></label>
              <label className={LABEL}>Мин<input type="number" inputMode="numeric" min={10} max={240} className={INPUT} value={r.durationMin} onChange={e => patch(r.key, { durationMin: Number(e.target.value) })} /></label>
              <label className={LABEL}>Название<input className={INPUT} value={r.label ?? ''} maxLength={80} placeholder="напр. Нулевой цикл" onChange={e => patch(r.key, { label: e.target.value || null })} /></label>
              <label className={LABEL}>Место / ссылка<input className={INPUT} value={r.place ?? ''} maxLength={300} placeholder="онлайн" onChange={e => patch(r.key, { place: e.target.value || null })} /></label>
              <div className={`${LABEL} col-span-2 sm:col-span-2 lg:col-span-1`}>
                Закреплённые отделы
                <SearchMultiSelect options={deptOptions} value={r.departmentIds} onChange={v => patch(r.key, { departmentIds: v })}
                  allLabel="Для всех" unitLabel="отдела" searchPlaceholder="Поиск отдела" ariaLabel="Закреплённые отделы" className="min-h-11 w-full min-w-0" />
              </div>
              <label className={LABEL}>Подпись отдела<input className={INPUT} value={r.departmentLabel ?? ''} maxLength={80} placeholder="напр. Москва" onChange={e => patch(r.key, { departmentLabel: e.target.value || null })} /></label>
              <div className="flex min-h-11 items-center gap-3 lg:justify-end">
                <label className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" checked={r.isOffline} onChange={e => patch(r.key, { isOffline: e.target.checked })} className="size-4 accent-[var(--color-accent)]" /> очно
                </label>
                <label className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px]">
                  <input type="checkbox" checked={r.active} onChange={e => patch(r.key, { active: e.target.checked })} className="size-4 accent-[var(--color-accent)]" /> вкл.
                </label>
                <button type="button" aria-label="Удалить слот" onClick={() => remove(r.key)}
                  className="tap-target inline-flex size-9 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-negative)]">
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
          <button type="button" onClick={() => add(d)} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
            <Plus size={14} /> Слот
          </button>
        </div>
      ))}

      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-3 bg-[var(--color-bg)] py-2">
        {!days.includes(6) && (
          <button type="button" onClick={() => add(6)} className="min-h-11 rounded-lg px-3 text-[13px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">+ Суббота</button>
        )}
        {msg && <span className={`text-[13px] ${msg.ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>{msg.text}</span>}
        <button type="button" onClick={() => mut.mutate()} disabled={mut.isPending}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-5 text-sm font-medium text-white disabled:opacity-50">
          {mut.isPending ? 'Сохраняю…' : 'Сохранить сетку'}
        </button>
      </div>
    </section>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className={LABEL}>
      {label}
      <input type="number" inputMode="numeric" min={1} max={60} className={INPUT} value={value} onChange={e => onChange(Number(e.target.value))} />
    </label>
  );
}

function nextTime(t: string, dur: number): string {
  const [h, m] = t.split(':').map(Number);
  const total = Math.min(23 * 60 + 55, h * 60 + m + dur);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
