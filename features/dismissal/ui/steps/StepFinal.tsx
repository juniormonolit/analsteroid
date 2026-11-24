'use client';

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { REPEAT_BRAK_REASONS } from '../../types';
import { fmtNum, fmtRub, plural, ruleOf } from '../planMath';
import { allBlockers } from '../stepStatus';
import { StepLayout, WizardFooter } from '../StepLayout';
import { ErrorBox, WarnBox, btnPrimary, card } from '../shared';
import { STEPS, type WizardCtx } from '../wizardCtx';

// Шаг 6 «Итог и запуск»: блокеры ссылками на шаги, «кому сколько», что не передаём, РОП и сообщения,
// комментарий и подтверждение запуска инлайн (без модалки).

export function StepFinal({ ctx, onStart, starting, startError }: {
  ctx: WizardCtx;
  onStart: () => void;
  starting: boolean;
  startError: string | null;
}) {
  const [checked, setChecked] = useState(false);
  const t = ctx.totals;
  const blockers = allBlockers(ctx.statuses);
  const stepNo = (k: string) => STEPS.findIndex(s => s.key === k) + 1;
  const stepTitle = (k: string) => STEPS.find(s => s.key === k)?.title ?? '';

  // Получатели: повторка + первичка + задачи следом
  const ids = new Set<number>([...t.repeat.byTarget.keys(), ...t.primary.byTarget.keys(), ...t.follow.byTarget.keys()]);
  const rows = [...ids].map(id => {
    const r = t.repeat.byTarget.get(id);
    const p = t.primary.byTarget.get(id);
    return { id, rd: r?.deals ?? 0, rc: r?.clients.size ?? 0, ltv: r?.ltv ?? 0, pd: p?.deals ?? 0, sum: p?.amount ?? 0, f: t.follow.byTarget.get(id) ?? 0 };
  }).sort((a, b) => b.ltv - a.ltv || b.pd - a.pd);
  const tot = rows.reduce((a, r) => ({ rd: a.rd + r.rd, rc: a.rc + r.rc, ltv: a.ltv + r.ltv, pd: a.pd + r.pd, sum: a.sum + r.sum, f: a.f + r.f }), { rd: 0, rc: 0, ltv: 0, pd: 0, sum: 0, f: 0 });
  const reason = REPEAT_BRAK_REASONS.find(r => r.value === (ctx.plan.repeatBrakReason ?? 'nothing_needed'))?.label;
  const deptNote = (['deal_repeat', 'deal_primary'] as const).flatMap(k => {
    const d = ruleOf(ctx.plan, k).departmentId;
    return d ? [`${k === 'deal_repeat' ? 'Повторка' : 'Первичка'} — по отделу «${ctx.deptName(d)}»`] : [];
  });
  const saveErr = ctx.save.s === 'error';
  const canStart = checked && !blockers.length && !saveErr && !starting && t.changes > 0;
  const th = 'px-2 py-1.5 text-xs font-medium text-[var(--color-text-muted)]';
  const td = 'px-2 py-1.5 text-right';

  return (
    <StepLayout title="6. Итог и запуск" subtitle="Проверьте, кому что уйдёт, и запустите. Исполнитель пойдёт по одной записи с паузами."
      footer={plaque => <WizardFooter ctx={ctx} plaque={plaque} />}>
      <div className="flex max-w-[1200px] flex-col gap-4">
        {blockers.length > 0 && (
          <div role="alert" className="rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 p-3">
            <p className="mb-1 text-sm font-medium text-[var(--color-text)]">Перед запуском нужно поправить:</p>
            <ul className="flex flex-col">
              {blockers.map(b => (
                <li key={b.step + b.text} className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-text)]">
                  <span>Шаг {stepNo(b.step)} «{stepTitle(b.step)}»: {b.text}</span>
                  <button type="button" onClick={() => ctx.goStep(b.step)} className="inline-flex min-h-11 items-center gap-1 font-medium text-[var(--color-accent)] hover:underline">
                    Перейти <ArrowRight size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <section className={`${card} p-3 sm:p-4 lg:col-span-2`}>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Кому сколько</h3>
            {rows.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Никому ничего не передаём.</p> : (
              <div className="scroll-x rounded-lg border border-[var(--color-border)]">
                <table className="w-full min-w-[640px] text-sm tabular-nums">
                  <thead className="bg-[var(--color-table-header)]">
                    <tr>
                      <th className={`${th} text-left`} rowSpan={2}>Получатель</th>
                      <th className={`${th} text-center`} colSpan={3}>Повторка</th>
                      <th className={`${th} text-center`} colSpan={2}>Первичка</th>
                      <th className={`${th} text-right`} rowSpan={2}>Задач следом</th>
                    </tr>
                    <tr>
                      <th className={`${th} text-right`}>сделок</th><th className={`${th} text-right`}>заказчиков</th><th className={`${th} text-right`}>LTV</th>
                      <th className={`${th} text-right`}>сделок</th><th className={`${th} text-right`}>сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id} className="border-t border-[var(--color-table-row-border)]">
                        <td className="px-2 py-1.5 text-left">{ctx.nameOf(r.id)}</td>
                        <td className={td}>{r.rd ? fmtNum(r.rd) : '—'}</td><td className={td}>{r.rc ? fmtNum(r.rc) : '—'}</td><td className={`${td} whitespace-nowrap`}>{r.ltv ? fmtRub(r.ltv) : '—'}</td>
                        <td className={td}>{r.pd ? fmtNum(r.pd) : '—'}</td><td className={`${td} whitespace-nowrap`}>{r.sum ? fmtRub(r.sum) : '—'}</td>
                        <td className={td}>{r.f ? fmtNum(r.f) : '—'}</td>
                      </tr>
                    ))}
                    <tr className="border-t border-[var(--color-border)] bg-[var(--color-totals-bg)] font-semibold">
                      <td className="px-2 py-1.5 text-left">Итого</td>
                      <td className={td}>{fmtNum(tot.rd)}</td><td className={td}>{fmtNum(tot.rc)}</td><td className={`${td} whitespace-nowrap`}>{fmtRub(tot.ltv)}</td>
                      <td className={td}>{fmtNum(tot.pd)}</td><td className={`${td} whitespace-nowrap`}>{fmtRub(tot.sum)}</td><td className={td}>{fmtNum(tot.f)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            {deptNote.length > 0 && <p className="mt-2 text-xs text-[var(--color-text-muted)]">{deptNote.join('; ')}. Раскладка — по текущему составу отдела; точный состав берётся в момент запуска.</p>}
          </section>

          <section className={`${card} p-3 sm:p-4`}>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">Не передаём</h3>
            <ul className="flex flex-col gap-1 text-sm">
              <li>Закрываем повторку: <b>{fmtNum(t.repeat.brak)}</b>{t.repeat.brak > 0 && reason && <span className="text-[var(--color-text-muted)]"> · {reason}</span>}</li>
              <li>Автобрак первички: <b>{fmtNum(t.primary.brak)}</b>{t.primary.brakAmount > 0 && <> · {fmtRub(t.primary.brakAmount)}</>}</li>
              {t.follow.close + t.close > 0 && <li>Закроются задачи и дела: <b>{fmtNum(t.follow.close + t.close)}</b></li>}
              <li>Остаётся на уволенном: <b>{fmtNum(t.leftOnSource)}</b></li>
            </ul>
          </section>

          <section className={`${card} p-3 sm:p-4`}>
            <h3 className="mb-2 text-sm font-semibold text-[var(--color-text)]">РОПу и сообщения</h3>
            <ul className="flex flex-col gap-1 text-sm">
              <li>Задач и дел без сделок → {ctx.ropName ? <b>{ctx.ropName}</b> : <span className="text-[var(--color-negative)]">РОП не выбран</span>}: <b>{fmtNum(t.toRop)}</b></li>
              {t.otherTransfer > 0 && <li>Другим получателям: <b>{fmtNum(t.otherTransfer)}</b></li>}
              {t.remove > 0 && <li>Убираем его из участников: <b>{fmtNum(t.remove)}</b></li>}
              <li>Сообщение РОПу: <b>{ctx.plan.notifyRop ? 'да' : 'нет'}</b></li>
              <li>Задача «сменить пароль» — {ctx.kuznetsova}: <b>{ctx.plan.passwordReset ? 'да' : 'нет'}</b></li>
            </ul>
          </section>

          <label className={`${card} flex flex-col gap-1 p-3 sm:p-4 lg:col-span-2`}>
            <span className="text-sm font-semibold text-[var(--color-text)]">Комментарий для истории</span>
            <input value={ctx.plan.note ?? ''} onChange={e => { const note = e.target.value; ctx.update(p => ({ ...p, note })); }}
              placeholder="Например: уходит 30.11, клиентов забирает отдел Иванова"
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:text-sm" />
          </label>
        </div>

        <section className={`${card} flex flex-col gap-3 border-[var(--color-warning)]/40 p-4`}>
          <WarnBox>Будет изменено <b>{fmtNum(t.changes)}</b> {plural(t.changes, ['запись', 'записи', 'записей'])} в Битриксе. Откатить нельзя.</WarnBox>
          {saveErr && <ErrorBox onRetry={ctx.retrySave}>План не сохранился: {ctx.save.s === 'error' ? ctx.save.msg : ''}</ErrorBox>}
          {startError && <ErrorBox>{startError}</ErrorBox>}
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-text)]">
            <input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
            Я проверил получателей
          </label>
          <button type="button" onClick={onStart} disabled={!canStart} className={`${btnPrimary} w-full sm:w-auto sm:self-start`}>
            {starting ? 'Запускаю…' : `Запустить · ${fmtNum(t.changes)} ${plural(t.changes, ['запись', 'записи', 'записей'])}`}
          </button>
          {blockers.length > 0 && <p className="text-xs text-[var(--color-negative)]">Запуск заблокирован — поправьте пункты выше.</p>}
        </section>
      </div>
    </StepLayout>
  );
}
