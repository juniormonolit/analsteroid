'use client';
// «Настройки → Геймификация → Дайджест» (задача 2765): вкл/выкл ежедневного и
// еженедельного дайджеста, час отправки (МСК), лимит напоминаний + сводная
// статистика попаданий журнала подсказок (advice_log). Singleton
// digest_settings (id=1, миграция 134).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface ScoringSettings {
  scoreThreshold: number;
  weightRecency: number; weightFrequency: number; weightValue: number;
  weightResponsive: number; weightCrosssell: number;
  deadRatioThreshold: number; deadDaysThreshold: number;
}

interface DigestPayload {
  settings: { dailyEnabled: boolean; weeklyEnabled: boolean; dailyHour: number; weeklyHour: number; maxReminders: number };
  scoring: ScoringSettings;
  stats: { total: number; success: number; closedNoContact: number; closedNoDeal: number; open: number; successRatePct: number | null };
}

const WEIGHT_FIELDS: { key: keyof ScoringSettings; label: string; hint: string }[] = [
  { key: 'weightRecency', label: 'Давность / личный цикл', hint: 'Насколько давность последней покупки уместна относительно ЛИЧНОГО цикла повторки этого заказчика (бэктест по истории продаж)' },
  { key: 'weightFrequency', label: 'Частота покупок', hint: 'Число покупок заказчика — капед на 5' },
  { key: 'weightValue', label: 'Сумма и категория', hint: 'Категория из «Мои заказчики» (ключевой/крупный/постоянный/разовый/потенциальный)' },
  { key: 'weightResponsive', label: 'Реакция на касания', hint: 'Прокси: был ли вообще звонок по этому заказчику (точной атрибуции звонок→продажа нет)' },
  { key: 'weightCrosssell', label: 'Сила кросс-перехода', hint: 'Вероятность именно этого перехода товарных групп (не «часто берут», а «часто берут именно после этой покупки»)' },
];

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
  const [scoringDraft, setScoringDraft] = useState<Record<string, string>>({});
  if (!data) return null;
  const s = data.settings;
  const sc = data.scoring;

  const saveHour = (key: 'dailyHour' | 'weeklyHour') => {
    const raw = hourDraft[key];
    if (raw === undefined || raw.trim() === '') return;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 23) return;
    patch.mutate({ [key]: v });
    setHourDraft(d => { const n = { ...d }; delete n[key]; return n; });
  };

  const saveScoring = (key: keyof ScoringSettings) => {
    const raw = scoringDraft[key];
    if (raw === undefined || raw.trim() === '') return;
    const v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    patch.mutate({ [key]: v });
    setScoringDraft(d => { const n = { ...d }; delete n[key]; return n; });
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
        <h2 className="mb-1 text-sm font-semibold">Скоринг подсказок «кому звонить»</h2>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Подсказка по заказчику формируется, только если он набрал явный порог по пяти взвешенным
          факторам ниже — иначе дайджест уходит только с цифрами, без совета (лучше без совета, чем с
          бессмысленным). Заказчики, чья давность многократно превышает их же личный цикл повторки
          (сейчас — {sc.deadRatioThreshold}× цикла И больше {sc.deadDaysThreshold} дней), из кандидатов
          исключаются полностью — «реинкарнировать» их не предлагаем ни при каком скоре.
        </p>
        <div className="flex flex-col gap-3 max-w-md">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span title="Ниже — подсказки не будет вовсе">Порог отсечки (0-100)</span>
            <input
              type="number" min={0} max={100}
              value={scoringDraft.scoreThreshold ?? sc.scoreThreshold}
              onChange={e => setScoringDraft(d => ({ ...d, scoreThreshold: e.target.value }))}
              onBlur={() => saveScoring('scoreThreshold')}
              onKeyDown={e => { if (e.key === 'Enter') saveScoring('scoreThreshold'); }}
              className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
            />
          </label>
          {WEIGHT_FIELDS.map(f => (
            <label key={f.key} className="flex items-center justify-between gap-3 text-sm" title={f.hint}>
              <span>{f.label}</span>
              <input
                type="number" min={0} max={100}
                value={scoringDraft[f.key] ?? sc[f.key]}
                onChange={e => setScoringDraft(d => ({ ...d, [f.key]: e.target.value }))}
                onBlur={() => saveScoring(f.key)}
                onKeyDown={e => { if (e.key === 'Enter') saveScoring(f.key); }}
                className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
              />
            </label>
          ))}
          <label className="flex items-center justify-between gap-3 text-sm" title="Множитель личного цикла повторки, после которого заказчик считается «мёртвым»">
            <span>«Мёртвые»: × личного цикла</span>
            <input
              type="number" min={1} max={50}
              value={scoringDraft.deadRatioThreshold ?? sc.deadRatioThreshold}
              onChange={e => setScoringDraft(d => ({ ...d, deadRatioThreshold: e.target.value }))}
              onBlur={() => saveScoring('deadRatioThreshold')}
              onKeyDown={e => { if (e.key === 'Enter') saveScoring('deadRatioThreshold'); }}
              className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm" title="И одновременно больше стольких дней с последней покупки">
            <span>«Мёртвые»: минимум дней</span>
            <input
              type="number" min={30} max={3650}
              value={scoringDraft.deadDaysThreshold ?? sc.deadDaysThreshold}
              onChange={e => setScoringDraft(d => ({ ...d, deadDaysThreshold: e.target.value }))}
              onBlur={() => saveScoring('deadDaysThreshold')}
              onKeyDown={e => { if (e.key === 'Enter') saveScoring('deadDaysThreshold'); }}
              className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right text-sm"
            />
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
