'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronUp, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useAppMode } from '@/lib/hooks/useAppMode';
import { STEPS, type WizardCtx } from './wizardCtx';
import { btnPrimary, btnSecondary } from './shared';

// Раскладка шага (спека §1, §10): заголовок + подзаголовок; список слева, панель «Кому сколько»
// справа (липкая на ≥lg). На телефоне панель — плашка над нижней панелью → bottom-sheet.

export function StepLayout({ title, subtitle, panel, panelSummary, footer, children }: {
  title: string;
  subtitle: React.ReactNode;
  panel?: React.ReactNode;
  /** Текст плашки на телефоне: «Распределено 14 из 20 · 5 человек» */
  panelSummary?: string;
  footer: (plaque: React.ReactNode) => React.ReactNode;
  children: React.ReactNode;
}) {
  const { isMobileLayout } = useAppMode();
  const [sheet, setSheet] = useState(false);
  const plaque = isMobileLayout && panel ? (
    <button type="button" onClick={() => setSheet(true)}
      className="mb-2 flex min-h-11 w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-left text-sm text-[var(--color-text)]">
      <span className="min-w-0 flex-1 truncate">{panelSummary ?? 'Кому сколько'}</span>
      <ChevronUp size={16} className="shrink-0 text-[var(--color-text-muted)]" />
    </button>
  ) : null;
  return (
    <>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
        <p className="max-w-[720px] text-sm text-[var(--color-text-muted)]">{subtitle}</p>
      </div>
      {panel ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0">{children}</div>
          {!isMobileLayout && (
            <aside className="order-first min-w-0 self-start lg:sticky lg:top-3 lg:order-none lg:max-h-[calc(100dvh-140px)] lg:overflow-y-auto">
              {panel}
            </aside>
          )}
        </div>
      ) : children}
      {footer(plaque)}
      {isMobileLayout && panel && (
        <Modal open={sheet} onOpenChange={setSheet} title="Кому сколько">{panel}</Modal>
      )}
    </>
  );
}

/** Нижняя панель шага: статус сохранения + Назад / Далее; при выделении — BulkBar вместо неё. */
export function WizardFooter({ ctx, plaque, bulk }: { ctx: WizardCtx; plaque?: React.ReactNode; bulk?: React.ReactNode }) {
  const idx = STEPS.findIndex(s => s.key === ctx.step);
  const prev = STEPS[idx - 1];
  const nextStep = STEPS[idx + 1];
  const cur = STEPS[idx];
  const empty = ctx.statuses[ctx.step].state === 'empty';
  const s = ctx.save;
  const status = (
    <span className={`text-xs ${s.s === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text-muted)]'}`}>
      {s.s === 'saving' && <><Loader2 size={11} className="mr-1 inline animate-spin" />Сохраняю…</>}
      {s.s === 'saved' && <><Check size={11} className="mr-1 inline" />Сохранено</>}
      {s.s === 'idle' && 'Сохраняется само'}
      {s.s === 'error' && <>Не сохранилось: {s.msg} · <button type="button" onClick={ctx.retrySave} className="tap-target font-medium underline">Повторить</button></>}
    </span>
  );
  return (
    <div className="sticky bottom-0 z-20 -mx-3 mt-4 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] px-3 pb-2 pt-2 [-webkit-backdrop-filter:var(--glass-blur)] [backdrop-filter:var(--glass-blur)] sm:-mx-6 sm:px-6 md:pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {plaque}
      {bulk ?? (
        <div className="flex flex-col gap-1.5 md:flex-row md:items-center">
          <div className="min-w-0 md:flex-1">{status}</div>
          <div className="flex items-center gap-2">
            {prev && (
              <button type="button" onClick={() => ctx.goStep(prev.key)} className={`${btnSecondary} w-11 shrink-0 px-0 md:w-auto md:px-3`} aria-label={`Назад: ${prev.title}`}>
                <ArrowLeft size={16} /><span className="hidden md:inline">Назад</span>
              </button>
            )}
            {nextStep && (
              <button type="button" onClick={() => ctx.goStep(nextStep.key)} className={`${btnPrimary} min-w-0 flex-1 md:flex-none`}>
                <span className="truncate">{empty ? 'Пропустить' : cur.next}</span><ArrowRight size={16} className="shrink-0" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Пустой шаг. */
export function EmptyStep({ text, ctx }: { text: string; ctx: WizardCtx }) {
  const idx = STEPS.findIndex(s => s.key === ctx.step);
  const next = STEPS[idx + 1];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 py-12 text-center">
      <p className="text-sm text-[var(--color-text-muted)]">{text}</p>
      {next && <button type="button" onClick={() => ctx.goStep(next.key)} className={`${btnSecondary} mt-3`}>Пропустить <ArrowRight size={14} /></button>}
    </div>
  );
}
