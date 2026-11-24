'use client';

import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { TabStrip } from '@/features/tasker/ui/shared/TabStrip';
import { STEPS, type StepKey, type StepState, type StepStatus } from './wizardCtx';

// Степпер мастера (спека §1): ≥lg — 6 вкладок слева направо; <lg — «Шаг 2 из 6 ▾» + полоска состояний.

const BAR: Record<StepState, string> = {
  empty: 'bg-[var(--color-border)]',
  todo: 'bg-[var(--color-border-strong)]',
  warn: 'bg-[var(--color-warning)]',
  done: 'bg-[var(--color-positive)]',
};

function Circle({ n, state, active }: { n: number; state: StepState; active: boolean }) {
  const cls = state === 'warn' ? 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]'
    : state === 'done' ? 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]'
    : active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]';
  return (
    <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${cls}`}>
      {state === 'warn' ? <AlertTriangle size={12} /> : state === 'done' ? <Check size={13} /> : n}
    </span>
  );
}

export function WizardStepper({ step, statuses, onStep }: { step: StepKey; statuses: Record<StepKey, StepStatus>; onStep: (k: StepKey) => void }) {
  const [open, setOpen] = useState(false);
  const idx = STEPS.findIndex(s => s.key === step);
  return (
    <>
      {/* ≥lg: вкладки */}
      <div className="hidden min-w-0 lg:block">
        <TabStrip activeKey={step} ariaLabel="Шаги увольнения" role="tablist" innerClassName="gap-1.5 p-1" className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]" fadeFrom="var(--color-bg-surface)">
          {STEPS.map((s, i) => {
            const st = statuses[s.key];
            const active = s.key === step;
            return (
              <button key={s.key} type="button" role="tab" aria-selected={active} data-tab-key={s.key} onClick={() => onStep(s.key)}
                className={`relative flex min-h-14 min-w-[168px] flex-1 items-center gap-2.5 rounded-lg px-3 text-left transition-colors ${active ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'} ${st.state === 'empty' && !active ? 'opacity-60' : ''}`}>
                <Circle n={i + 1} state={st.state} active={active} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.title}</span>
                  <span className="block truncate text-xs tabular-nums text-[var(--color-text-muted)]">{st.count}</span>
                </span>
                {active && <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--color-accent)]" />}
              </button>
            );
          })}
        </TabStrip>
      </div>

      {/* <lg: компактный выбор шага */}
      <div className="lg:hidden">
        <Popover open={open} onOpenChange={setOpen} align="start" className="w-[340px] max-w-[calc(100vw-16px)] p-1"
          trigger={
            <button type="button" aria-haspopup="menu" aria-expanded={open}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-left text-sm text-[var(--color-text)]">
              <Circle n={idx + 1} state={statuses[step].state} active />
              <span className="min-w-0 flex-1 truncate"><span className="text-[var(--color-text-muted)]">Шаг {idx + 1} из {STEPS.length} · </span><b className="font-medium">{STEPS[idx].title}</b></span>
              <ChevronDown size={16} className="shrink-0 text-[var(--color-text-muted)]" />
            </button>
          }>
          <div role="menu" className="flex flex-col">
            {STEPS.map((s, i) => (
              <button key={s.key} type="button" role="menuitem" onClick={() => { onStep(s.key); setOpen(false); }}
                className={`flex min-h-11 items-center gap-2.5 rounded-md px-2 text-left text-sm ${s.key === step ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                <Circle n={i + 1} state={statuses[s.key].state} active={s.key === step} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{statuses[s.key].count}</span>
              </button>
            ))}
          </div>
        </Popover>
        <div className="mt-1.5 grid grid-cols-6 gap-1" aria-hidden>
          {STEPS.map(s => (
            <span key={s.key} className={`h-1 rounded-full ${BAR[statuses[s.key].state]} ${s.key === step ? 'outline outline-2 outline-offset-1 outline-[var(--color-accent)]' : ''}`} />
          ))}
        </div>
      </div>
    </>
  );
}
