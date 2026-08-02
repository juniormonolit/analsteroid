'use client';
// «Настройки → Геймификация → Дайджест» (задача 2765): вкл/выкл ежедневного и
// еженедельного дайджеста, час отправки (МСК), лимит напоминаний + сводная
// статистика попаданий журнала подсказок (advice_log). Singleton
// digest_settings (id=1, миграция 134).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface DigestPayload {
  settings: { dailyEnabled: boolean; weeklyEnabled: boolean; dailyHour: number; weeklyHour: number; maxReminders: number };
  stats: { total: number; success: number; closedNoContact: number; closedNoDeal: number; open: number; successRatePct: number | null };
}

export function DigestSettingsBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<DigestPayload>({
    queryKey: ['settings-digest'],
    queryFn: async () => {
      const res = await fetch('/api/settings/digest');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/digest', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings-digest'] }),
  });

  const [hourDraft, setHourDraft] = useState<Record<string, string>>({});
  if (!data) return null;
  const s = data.settings;

  const saveHour = (key: 'dailyHour' | 'weeklyHour') => {
    const raw = hourDraft[key];
    if (raw === undefined || raw.trim() === '') return;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 23) return;
    patch.mutate({ [key]: v });
    setHourDraft(d => { const n = { ...d }; delete n[key]; return n; });
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
        <h2 className="mb-1 text-sm font-semibold">Дайджест менеджерам</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Ежедневный (будни, короткий) и еженедельный (по понедельникам, итоги) пуш ботом «Аналитик» —
          гамбургер похвала→укор→похвала + подсказка «кому позвонить». Пока действует общий рубильник
          dry-run (см. вкладку «Исходящие»), реальной отправки нет — только формирование и лог.
        </p>
        <div className="flex flex-col gap-3 max-w-md">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Ежедневный дайджест</span>
            <input type="checkbox" checked={s.dailyEnabled} onChange={e => patch.mutate({ dailyEnabled: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Час отправки ежедневного (МСК)</span>
            <input
              type="number" min={0} max={23}
              value={hourDraft.dailyHour ?? s.dailyHour}
              onChange={e => setHourDraft(d => ({ ...d, dailyHour: e.target.value }))}
              onBlur={() => saveHour('dailyHour')}
              onKeyDown={e => { if (e.key === 'Enter') saveHour('dailyHour'); }}
              className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Еженедельный дайджест (по пн)</span>
            <input type="checkbox" checked={s.weeklyEnabled} onChange={e => patch.mutate({ weeklyEnabled: e.target.checked })} className="w-4 h-4 accent-[var(--color-accent)]" />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Час отправки еженедельного (МСК)</span>
            <input
              type="number" min={0} max={23}
              value={hourDraft.weeklyHour ?? s.weeklyHour}
              onChange={e => setHourDraft(d => ({ ...d, weeklyHour: e.target.value }))}
              onBlur={() => saveHour('weeklyHour')}
              onKeyDown={e => { if (e.key === 'Enter') saveHour('weeklyHour'); }}
              className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>Лимит напоминаний по подсказке</span>
            <select
              value={s.maxReminders}
              onChange={e => patch.mutate({ maxReminders: Number(e.target.value) })}
              className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
            >
              {[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
        <h2 className="mb-3 text-sm font-semibold">Журнал подсказок — статистика попаданий</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Всего выдано" value={data.stats.total} />
          <Stat label="Сработало" value={data.stats.success} accent="green" />
          <Stat label="Не дозвонились" value={data.stats.closedNoContact} />
          <Stat label="Контакт без сделки" value={data.stats.closedNoDeal} />
          <Stat label="% попаданий" value={data.stats.successRatePct !== null ? `${data.stats.successRatePct}%` : '—'} accent="green" />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: 'green' }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] px-3 py-2">
      <div className={`text-lg font-semibold tabular-nums ${accent === 'green' ? 'text-green-600' : ''}`}>{value}</div>
      <div className="text-[11px] text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}
