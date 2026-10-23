'use client';
// «Участники задачи» в окне постановки (владелец 23.10: «опция сразу (галочкой) добавить соисполнителем/наблюдателем +
// поиск с множественным выбором; по умолчанию — соисполнителем РОП менеджера»). Галочка включена, в соисполнителях —
// «РОП менеджера» (сервер развернёт в конкретного человека по оргструктуре ответственного), остальные — поиском.
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { DEFAULT_PARTICIPANTS, ROP_TOKEN, type TaskParticipants } from '../engine/participants';

export interface ParticipantsState extends TaskParticipants { on: boolean }
export const initialParticipants = (): ParticipantsState => ({ on: true, ...DEFAULT_PARTICIPANTS, accomplices: [...DEFAULT_PARTICIPANTS.accomplices] });
/** Тело запроса: выключено или пусто — без участников. */
export const participantsPayload = (p: ParticipantsState): TaskParticipants | undefined =>
  p.on && (p.accomplices.length || p.auditors.length) ? { accomplices: p.accomplices, auditors: p.auditors } : undefined;

interface PeoplePayload { people: { id: string; name: string; dept: string | null }[]; ropOf: Record<string, string> }
const short = (n: string) => { const p = n.trim().split(/\s+/); return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : n; };

export function ParticipantsPicker({ value, onChange, managerIds }: {
  value: ParticipantsState; onChange: (v: ParticipantsState) => void;
  /** Ответственные менеджеры задач: один — подпись «РОП менеджера — Имя»; несколько (массово) — «у каждой задачи свой». */
  managerIds: string[];
}) {
  const { data } = useQuery<PeoplePayload>({
    queryKey: ['repeat-kanban-people'],
    queryFn: async () => { const r = await fetch('/api/repeat-kanban/people'); return r.ok ? r.json() : { people: [], ropOf: {} }; },
    staleTime: 10 * 60_000,
  });
  const people = data?.people ?? [];
  const nameOf = (id: string) => people.find(p => p.id === id)?.name ?? null;
  const rops = [...new Set(managerIds.map(m => data?.ropOf[m]).filter((x): x is string => !!x))];
  const ropLabel = managerIds.length > 1 && rops.length !== 1 ? 'РОП менеджера — у каждой задачи свой'
    : rops[0] && nameOf(rops[0]) ? `РОП менеджера — ${short(nameOf(rops[0])!)}` : 'РОП менеджера';
  // Сам РОП не дублируется отдельной строкой, если он уже выбран как «РОП менеджера».
  const ropSelf = rops.length === 1 ? rops[0] : null;
  const options = [
    { value: ROP_TOKEN, label: ropLabel, hint: 'по оргструктуре ответственного менеджера' },
    ...people.filter(p => p.id !== ropSelf || !value.accomplices.includes(ROP_TOKEN)).map(p => ({ value: p.id, label: p.name, hint: p.dept ?? undefined })),
  ];
  const set = (patch: Partial<ParticipantsState>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2.5">
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[var(--color-text)]">
        <input type="checkbox" checked={value.on} onChange={e => set({ on: e.target.checked })} className="h-4 w-4 accent-[var(--color-accent)]" />
        <Users size={15} className="text-[var(--color-text-muted)]" />
        <span className="font-medium">Добавить участников</span>
        {!value.on && <span className="text-xs text-[var(--color-text-muted)]">— задача только у ответственного</span>}
      </label>
      {value.on && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Соисполнители — работают с задачей</span>
            <SearchMultiSelect ariaLabel="Соисполнители" allLabel="Никого" unitLabel="соисполнителей" searchPlaceholder="Поиск сотрудника"
              options={options} value={value.accomplices}
              onChange={v => set({ accomplices: v, auditors: value.auditors.filter(x => !v.includes(x)) })}
              className="inline-flex min-h-11 w-full items-center justify-start gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm" />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-[var(--color-text-muted)]">Наблюдатели — видят задачу</span>
            <SearchMultiSelect ariaLabel="Наблюдатели" allLabel="Никого" unitLabel="наблюдателей" searchPlaceholder="Поиск сотрудника"
              options={options.filter(o => !value.accomplices.includes(o.value))} value={value.auditors}
              onChange={v => set({ auditors: v })}
              className="inline-flex min-h-11 w-full items-center justify-start gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-sm" />
          </div>
        </div>
      )}
    </div>
  );
}
