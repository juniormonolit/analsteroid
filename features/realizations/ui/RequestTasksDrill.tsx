'use client';
// Дриллдаун «Ответов на запросы» (задача #8034): список задач-запросов менеджера
// за период отчёта. Общий DrilldownDrawer умеет только сделки — здесь задачи.
// Только просмотр: ссылок в Битрикс нет (правило брифа).

import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DASH, fmt1, fmtDateTime, fmtInt, fmtRub } from './format';
import type { RequestTaskItem } from '@/features/reports/engine/requestResponse';

const STATUS: Record<number, string> = { 1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена' };
const th = 'sticky top-0 z-10 bg-[var(--color-table-header)] border-b border-[var(--color-border)] px-2 py-1.5 text-[11px] font-semibold text-[var(--color-text-muted)] whitespace-nowrap text-left';
const td = 'border-b border-[var(--color-border)] px-2 py-1.5 whitespace-nowrap';
const hoursBetween = (a: string | null, b: string | null) => (a && b ? (Date.parse(b) - Date.parse(a)) / 3_600_000 : null);

export function RequestTasksDrill({ managerId, name, metricName, period, onClose }: {
  managerId: string; name: string; metricName?: string; period: { from: Date; to: Date }; onClose: () => void;
}) {
  const qs = new URLSearchParams({ managerId, from: period.from.toISOString(), to: period.to.toISOString() });
  const q = useQuery<{ items: RequestTaskItem[]; truncated: boolean }>({
    queryKey: ['realizations', 'tasks', qs.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/realizations/tasks?${qs}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
      return body;
    },
  });
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} desktopWidth="sm:max-w-[1100px]"
      title={<span>Запросы · {name}{metricName ? <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">из колонки «{metricName}»</span> : null}</span>}>
      {q.isLoading && <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем запросы…</div>}
      {q.error && <div className="rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-negative)]">{(q.error as Error).message}</div>}
      {q.data && (q.data.items.length === 0 ? <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Запросов за период нет</div> : (
        <div className="flex flex-col gap-2">
          <div className="text-xs text-[var(--color-text-muted)]">
            {fmtInt(q.data.items.length)} запросов{q.data.truncated ? ' (показаны последние 2 000)' : ''} · время — МСК · первый ответ — по результатам задачи, надёжно с 07.09.2026
          </div>
          <div className="scroll-x max-h-[65dvh] overflow-y-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full border-collapse text-xs text-[var(--color-text)]">
              <thead><tr>
                <th className={th}>Задача</th><th className={th}>Поток</th><th className={th}>Статус</th>
                <th className={th}>Создана</th><th className={`${th} text-right`}>До работы, ч</th>
                <th className={`${th} text-right`}>1-й ответ, ч</th><th className={`${th} text-right`}>Цикл, ч</th>
                <th className={th}>Исполнитель</th><th className={th}>Сделка</th><th className={th}>Продажа / отгрузка</th>
              </tr></thead>
              <tbody>{q.data.items.map(t => (
                <tr key={t.taskId} className="report-row">
                  <td className={`${td} max-w-[280px] truncate`} title={t.title ?? ''}><span className="text-[var(--color-text-muted)]">#{t.taskId}</span> {t.title ?? DASH}</td>
                  <td className={td}>{t.flow ?? DASH}</td>
                  <td className={td}>{t.status !== null ? STATUS[t.status] ?? t.status : DASH}{t.closedAt && !t.dateStart ? <span className="ml-1 text-[var(--color-warning)]">без взятия</span> : null}</td>
                  <td className={td}>{fmtDateTime(t.createdAt)}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(hoursBetween(t.createdAt, t.dateStart))}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(hoursBetween(t.createdAt, t.firstAnswerAt))}</td>
                  <td className={`${td} text-right tabular-nums`}>{fmt1(hoursBetween(t.createdAt, t.closedAt))}</td>
                  <td className={`${td} max-w-[160px] truncate`}>{t.responsible ?? DASH}</td>
                  <td className={td}>{t.dealId ?? DASH}</td>
                  <td className={td}>
                    {t.dealSoldAt ? <span className="text-[var(--color-positive)]">продано {fmtDateTime(t.dealSoldAt).slice(0, 8)}</span> : DASH}
                    {t.dealDeliveredAt ? <span className="ml-1 text-[var(--color-text-muted)]">· отгр. {fmtDateTime(t.dealDeliveredAt).slice(0, 8)}</span> : null}
                    {t.dealAmount ? <span className="ml-1 text-[var(--color-text-muted)]">· {fmtRub(t.dealAmount)}</span> : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      ))}
    </Modal>
  );
}
