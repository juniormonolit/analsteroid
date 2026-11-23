'use client';
// Карточка задачи Задачника (ТЗ: «снимок → текущее значение (живое) → вердикт, чек-лист заказчиков,
// ссылка в Битрикс»). Drawer: справа на десктопе, на весь экран на телефоне.
// «Текущее» — POST /api/tasker/snapshot за период «с постановки по сегодня» (тот же расчёт, что замер).
// Смена статуса кнопками — для тача, где перетаскивания нет (и как явная альтернатива на десктопе).
import { useQuery } from '@tanstack/react-query';
import { CheckSquare, CloudOff, ExternalLink, Square } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { useAppMode } from '@/lib/hooks/useAppMode';
import {
  TASKER_METRIC_GROUP_LABELS, TASKER_VERDICT_LABELS,
  type Snapshot, type TaskerSnapshotResponse, type TaskerTask,
} from '../../types';
import { BOARD_COLUMN_LABELS, VERDICT_CLS, boardColumn, fmtD, fmtDT, fmtValue, isOverdue, moveTargets, mskDay, TASK_KIND_LABELS, taskExtras, todayMsk, type MoveTarget } from './format';
import { ManagerTrainingHistory } from '@/features/tasker/trainings/ui/ManagerTrainingHistory';


function useLiveValue(t: TaskerTask, mock: boolean) {
  const from = mskDay(t.createdAt);
  const to = todayMsk();
  const enabled = t.status !== 'result' && from <= to;
  return useQuery<Snapshot | null>({
    queryKey: ['tasker-live', t.id, from, to, mock],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      if (mock) {
        const v = t.snapshot.value;
        return { ...t.snapshot, value: v == null ? null : Math.round(v * 1.08 * 10) / 10 };
      }
      const r = await fetch('/api/tasker/snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managerIds: [t.manager.id], metricId: t.metricId, period: { from, to } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return (j as TaskerSnapshotResponse)[String(t.manager.id)] ?? null;
    },
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[var(--color-text-muted)]">{label}</span>
      <span className="min-w-0 text-right tabular-nums text-[var(--color-text)]">{children}</span>
    </div>
  );
}

export function TaskDrawer({ task: t, mock, onClose, onStatus, busy }: {
  task: TaskerTask;
  mock: boolean;
  onClose: () => void;
  onStatus: (t: TaskerTask, s: MoveTarget) => void;
  busy?: boolean;
}) {
  const live = useLiveValue(t, mock);
  // Внутри портала ссылки на Битрикс открываем в нём же (_top), иначе — новой вкладкой.
  const { isBitrixIframe } = useAppMode();
  const linkTarget = isBitrixIframe ? '_top' : '_blank';
  const overdue = isOverdue(t);
  const targets = moveTargets(t);
  const { kind, assignee, doneNote, doneAt } = taskExtras(t);
  const canChangeStatus = targets.length > 0;

  return (
    <Drawer open onOpenChange={o => { if (!o) onClose(); }} title={`${t.metricLabel} · ${t.manager.name}`} desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-5 text-sm">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 font-medium text-[var(--color-accent)]">{BOARD_COLUMN_LABELS[boardColumn(t)]}</span>
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)]">{TASKER_METRIC_GROUP_LABELS[t.metricGroup]}</span>
          {kind && <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-medium text-[var(--color-text)]">{TASK_KIND_LABELS[kind]}</span>}
          {overdue && <span className="rounded-full bg-[var(--color-negative-soft)] px-2 py-0.5 font-medium text-[var(--color-negative)]">просрочена</span>}
          {t.verdict && <span className={`rounded-full px-2 py-0.5 font-medium ${VERDICT_CLS[t.verdict]}`}>{TASKER_VERDICT_LABELS[t.verdict]}</span>}
        </div>

        {t.syncState !== 'synced' && (
          <div className="flex items-start gap-2 rounded-lg bg-[var(--color-negative-soft)] p-3 text-[var(--color-negative)]">
            <CloudOff size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">{t.syncState === 'pending' ? 'Задача ещё отправляется в Битрикс.' : `Не ушла в Битрикс: ${t.syncError ?? 'ошибка'}`}</span>
          </div>
        )}

        {/* Снимок → текущее → вердикт */}
        <section aria-label="Цифры" className="min-w-0">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Цифры {t.higherIsBetter ? '(больше — лучше)' : '(меньше — лучше)'}
          </h3>
          <div className="grid min-w-0 grid-cols-3 gap-2">
            <div className="min-w-0 rounded-lg bg-[var(--color-bg-surface)] p-2 sm:p-3">
              <div className="text-xs text-[var(--color-text-muted)]">При постановке</div>
              <div className="break-words text-base font-semibold tabular-nums sm:text-lg">{fmtValue(t.snapshot.value, t.format)}</div>
              <div className="text-xs text-[var(--color-text-muted)]">{fmtD(t.period.from)}–{fmtD(t.period.to)}</div>
            </div>
            <div className="min-w-0 rounded-lg bg-[var(--color-bg-surface)] p-2 sm:p-3">
              <div className="text-xs text-[var(--color-text-muted)]">{t.status === 'result' ? 'На замере' : 'Сейчас'}</div>
              <div className="break-words text-base font-semibold tabular-nums sm:text-lg">
                {t.status === 'result' ? fmtValue(t.measuredValue, t.format)
                  : live.isLoading ? '…'
                  : live.error ? '—'
                  : fmtValue(live.data?.value, t.format)}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {t.status === 'result' ? (t.measuredAt ? fmtD(t.measuredAt) : '') : live.error ? 'не посчиталось' : `с ${fmtD(t.createdAt)} по сегодня`}
                {t.status !== 'result' && live.data && !live.data.enoughData ? ' · мало данных' : ''}
              </div>
            </div>
            <div className="min-w-0 rounded-lg bg-[var(--color-bg-surface)] p-2 sm:p-3">
              <div className="text-xs text-[var(--color-text-muted)]">Цель</div>
              <div className="break-words text-base font-semibold tabular-nums sm:text-lg">{fmtValue(t.target, t.format)}</div>
              <div className="text-xs text-[var(--color-text-muted)]">замер {fmtD(t.controlDate)}</div>
            </div>
          </div>
          <div className="mt-2 min-w-0 divide-y divide-[var(--color-border)] text-xs">
            <Row label={t.snapshot.deptName ? `Среднее · ${t.snapshot.deptName}` : 'Среднее отдела'}>{fmtValue(t.snapshot.deptAvg, t.format)}</Row>
            <Row label="Своё среднее за 6 мес.">{fmtValue(t.snapshot.ownAvg6m, t.format)}</Row>
            {!t.snapshot.enoughData && <Row label="Объём при постановке">мало данных{t.snapshot.denominator != null ? ` (${t.snapshot.denominator})` : ''}</Row>}
          </div>
        </section>

        <section aria-label="Кто и когда" className="min-w-0 divide-y divide-[var(--color-border)]">
          <Row label="Менеджер">{t.manager.name}</Row>
          {assignee && <Row label={kind === 'theory' ? 'Исполнитель (тренер)' : 'Исполнитель'}>{assignee.name}</Row>}
          {t.rop && <Row label="РОП">{t.rop.name}</Row>}
          {t.director && <Row label="Наблюдатель">{t.director.name}</Row>}
          <Row label="Поставил">{t.creator.name}</Row>
          <Row label="Срок"><span className={overdue ? 'font-medium text-[var(--color-negative)]' : ''}>{fmtDT(t.deadline)}</span></Row>
          {t.slotStart && <Row label="Сессия">{fmtDT(t.slotStart)} · {t.durationMin} мин</Row>}
          <Row label="Контрольная дата">{fmtD(t.controlDate)}</Row>
        </section>

        {doneNote && (
          <section aria-label="Что сделано" className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Что сделано{doneAt ? ` · ${fmtDT(doneAt)}` : ''}</h3>
            <p className="whitespace-pre-line break-words rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text)]">{doneNote}</p>
          </section>
        )}

        {t.body.trim() && (
          <section aria-label="Рекомендации" className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Рекомендации</h3>
            <p className="whitespace-pre-line break-words rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text)]">{t.body}</p>
          </section>
        )}

        {t.checklist.length > 0 && (
          <section aria-label="Заказчики" className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Заказчики из повторки · {t.checklist.filter(c => c.done).length}/{t.checklist.length}
            </h3>
            <ul className="flex min-w-0 flex-col gap-1">
              {t.checklist.map(c => (
                <li key={c.clientKey} className="flex min-w-0 items-center gap-2">
                  {c.done ? <CheckSquare size={16} className="shrink-0 text-[var(--color-positive)]" aria-label="Сделано" /> : <Square size={16} className="shrink-0 text-[var(--color-text-muted)]" aria-label="Не сделано" />}
                  {c.crmUrl ? (
                    <a href={c.crmUrl} target={linkTarget} rel="noreferrer" className={`min-w-0 truncate underline-offset-2 hover:underline ${c.done ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-accent)]'}`}>{c.title}</a>
                  ) : (
                    <span className={`min-w-0 truncate ${c.done ? 'text-[var(--color-text-muted)] line-through' : ''}`}>{c.title}</span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Отмечает менеджер в чек-листе задачи Битрикса.</p>
          </section>
        )}

        {/* Обучения менеджера (сессия D): на что, зачем, кто отправил, был ли, что изменилось. */}
        {!mock && (
          <section aria-label="Обучения менеджера" className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Обучения менеджера</h3>
            <ManagerTrainingHistory managerId={t.manager.id} compact />
          </section>
        )}

        {canChangeStatus && (
          <section aria-label="Статус" className="min-w-0">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Перевести в</h3>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {targets.map(s => (
                <button key={s} type="button" disabled={busy} onClick={() => onStatus(t, s)}
                  className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
                  {(t.status === 'done' || t.status === 'measuring') && s === 'in_progress' ? 'Вернуть в работу' : BOARD_COLUMN_LABELS[s]}
                </button>
              ))}
            </div>
          </section>
        )}

        {t.bitrixUrl && (
          <a href={t.bitrixUrl} target={linkTarget} rel="noreferrer"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)]">
            <ExternalLink size={16} aria-hidden /> Открыть в Битриксе
          </a>
        )}
      </div>
    </Drawer>
  );
}
