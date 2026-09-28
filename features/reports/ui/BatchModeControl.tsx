'use client';
// Шапка отчёта: режим выборки — календарный период или «Последние N закрытых сделок»
// (ТЗ владельца 28.09). N применяется к КАЖДОМУ менеджеру отдельно: у всех берутся
// последние N его закрытых сделок, поэтому людей можно сравнивать на одинаковой базе,
// не оглядываясь на число рабочих дней, отпуска и сезон.
import { useEffect, useState } from 'react';
import { Layers, Settings2, Skull } from 'lucide-react';
import type { DealBatchSettings } from '@/lib/reports/dealBatchSettings';

export interface BatchModeState {
  on: boolean;
  size: number;
  useZombies: boolean;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

function zombieHint(s: DealBatchSettings | null): string {
  if (!s) return 'правила задаются в настройках';
  const parts: string[] = [];
  if (s.age.enabled) parts.push(`висит дольше ${s.age.days} ${plural(s.age.days, 'дня', 'дней', 'дней')}`);
  if (s.idle.enabled) parts.push(`без движения ${s.idle.days} ${plural(s.idle.days, 'день', 'дня', 'дней')}`);
  if (s.stage.enabled) parts.push(`в стадии дольше ${s.stage.days} ${plural(s.stage.days, 'дня', 'дней', 'дней')}`);
  return parts.length ? parts.join(' или ') : 'ни одно правило не включено';
}

export function BatchModeControl({ value, onChange }: {
  value: BatchModeState;
  onChange: (v: BatchModeState) => void;
}) {
  const [settings, setSettings] = useState<DealBatchSettings | null>(null);
  const [draft, setDraft] = useState(String(value.size));

  useEffect(() => {
    fetch('/api/settings/deal-batches').then(r => r.json()).then((s: DealBatchSettings) => setSettings(s)).catch(() => {});
  }, []);
  useEffect(() => { setDraft(String(value.size)); }, [value.size]);

  const commitSize = () => {
    const n = Math.min(5000, Math.max(5, Math.round(Number(draft)) || value.size));
    setDraft(String(n));
    if (n !== value.size) onChange({ ...value, size: n });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <div className="flex gap-1 p-1 rounded-lg bg-[var(--color-bg-hover)]">
        <button type="button" onClick={() => onChange({ ...value, on: false })}
          className={`min-h-9 px-3 rounded-md text-sm whitespace-nowrap ${!value.on ? 'bg-[var(--color-bg-surface)] font-medium shadow-sm text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
          Период
        </button>
        <button type="button" onClick={() => onChange({ ...value, on: true })}
          className={`min-h-9 px-3 rounded-md text-sm whitespace-nowrap inline-flex items-center gap-1.5 ${value.on ? 'bg-[var(--color-bg-surface)] font-medium shadow-sm text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
          <Layers size={14} /> Последние сделки
        </button>
      </div>

      {value.on && (
        <>
          <div className="flex items-center gap-2">
            <input type="number" min={5} max={5000} value={draft} inputMode="numeric"
              onChange={e => setDraft(e.target.value)} onBlur={commitSize}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitSize(); } }}
              className="w-20 border border-[var(--color-border)] rounded-lg px-2 py-1.5 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] tabular-nums" />
            <span className="text-sm text-[var(--color-text-muted)]">закрытых сделок у каждого менеджера</span>
          </div>

          <label className="flex items-center gap-2 min-h-9 cursor-pointer text-sm text-[var(--color-text)]"
            title="Открытые висяки приравниваются к отказам. Датой отказа считается момент, когда сделка стала висяком, а не сегодняшний день.">
            <input type="checkbox" checked={value.useZombies} onChange={e => onChange({ ...value, useZombies: e.target.checked })}
              className="accent-[var(--color-accent)] w-4 h-4 shrink-0" />
            <Skull size={14} className="text-[var(--color-text-muted)]" /> Считать зомби проигранными
          </label>

          <span className="text-xs text-[var(--color-text-muted)] basis-full sm:basis-auto">
            {value.useZombies ? `зомби: ${zombieHint(settings)}` : 'только продажи, отгрузки и отказы'}
            <a href="/settings/deal-batches" className="inline-flex items-center gap-1 ml-2 text-[var(--color-accent)] hover:underline">
              <Settings2 size={12} /> настроить
            </a>
          </span>
        </>
      )}
    </div>
  );
}
