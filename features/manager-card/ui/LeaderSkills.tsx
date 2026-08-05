'use client';
// Скиллы руководителя в профиле (решение владельца 05.08): вместо товарных
// классов XP, которых у РОПа быть не может, — четыре показателя ОТДЕЛА и
// сложенный из них уровень с титулом тяги (Дрезина → … → Атомный ледокол).
import { useQuery } from '@tanstack/react-query';

interface Skill {
  key: string; label: string; value: number;
  unit: 'count' | 'percent' | 'money'; percentile: number; level: number;
}
interface Result {
  level: number; title: string; skills: Skill[];
  deptCount: number; windowDays: number; scopeDepts: number;
}

function fmt(v: number, unit: Skill['unit']): string {
  if (unit === 'percent') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (unit === 'money') {
    if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
    return `${Math.round(v / 1000).toLocaleString('ru-RU')} тыс ₽`;
  }
  return v.toLocaleString('ru-RU');
}

export function LeaderSkills({ bitrixId }: { bitrixId?: string }) {
  const { data } = useQuery({
    queryKey: ['leader-skills', bitrixId ?? 'me'],
    queryFn: async () => {
      const qs = bitrixId ? `?bitrixId=${encodeURIComponent(bitrixId)}` : '';
      const res = await fetch(`/api/manager-card/leader-skills${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ skills: Result | null }>;
    },
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const r = data?.skills;
  if (!r) return null; // не руководитель — блока нет

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="text-3xl font-extrabold leading-none tabular-nums text-[var(--color-accent)]">{r.level}</span>
        <div className="flex flex-col">
          <span className="text-sm font-bold text-[var(--color-text)]">уровень · {r.title}</span>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            по показателям {r.scopeDepts > 1 ? `${r.scopeDepts} отделов` : 'отдела'} за {r.windowDays} дней,
            в сравнении с {r.deptCount} отделами компании
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5">
        {r.skills.map(s => (
          <div key={s.key} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[13px] text-[var(--color-text)] truncate">{s.label}</span>
              <span className="text-[13px] font-bold tabular-nums text-[var(--color-accent)] shrink-0">{s.level} ур.</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-[var(--color-bg-hover)]">
              <div
                className="h-2 rounded-full transition-all"
                style={{ width: `${Math.max(s.percentile, 2)}%`, backgroundColor: 'var(--color-accent)' }}
                title={`Лучше ${s.percentile}% отделов`}
              />
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span className="tabular-nums">{fmt(s.value, s.unit)}</span>
              <span className="tabular-nums">лучше {s.percentile}% отделов</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
