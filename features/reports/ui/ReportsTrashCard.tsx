'use client';

// Корзина отчётов — переехала из сайдбара в ЛК (задача Иосифа 16.07, оптимизация
// левого меню). Логика прежняя (бриф 09.07, п.2): свои удалённые видит любой,
// витринные — по праву (сервер фильтрует, GET /api/saved-reports/trash);
// восстановление POST /restore, «навсегда» DELETE /permanent, автоочистка >30 дней.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { TrashedReport } from '@/lib/saved-reports/types';

const cardCls = 'rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 sm:p-5';

export function ReportsTrashCard() {
  const qc = useQueryClient();
  const { data: trashedReports = [] } = useQuery<TrashedReport[]>({
    queryKey: ['saved-reports-trash'],
    queryFn: async () => {
      const res = await fetch('/api/saved-reports/trash');
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
  });

  async function restoreReport(id: string) {
    await fetch(`/api/saved-reports/${id}/restore`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
  }

  async function permanentlyDelete(id: string, name: string) {
    if (!confirm(`Удалить отчёт «${name}» НАВСЕГДА? Это действие необратимо.`)) return;
    await fetch(`/api/saved-reports/${id}/permanent`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
  }

  return (
    <div className={cardCls}>
      <div className="flex items-center gap-2 mb-1">
        <Trash2 size={15} className="text-[var(--color-text-muted)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Корзина отчётов</h2>
        {trashedReports.length > 0 && (
          <span className="min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-border)] text-[var(--color-text-muted)] text-[10.5px] font-bold flex items-center justify-center">
            {trashedReports.length}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">
        Удалённые отчёты хранятся 30 дней, затем очищаются автоматически.
      </p>

      {trashedReports.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Корзина пуста.</p>
      ) : (
        <div className="flex flex-col divide-y divide-[var(--color-border)]">
          {trashedReports.map(r => (
            <div key={r.id} className="py-2.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-3">
              <div className="flex-1 min-w-0">
                <span className="text-sm text-[var(--color-text)] break-words">{r.name}</span>
                {r.isShared && (
                  <span className="ml-1.5 align-middle inline-block px-1.5 py-px text-[9.5px] rounded bg-[var(--color-border)] text-[var(--color-text-muted)]">
                    витрина
                  </span>
                )}
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {format(new Date(r.deletedAt), 'd MMM, HH:mm', { locale: ru })}
                  {r.deletedBy && ` · ${r.deletedBy}`}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={() => restoreReport(r.id)}
                  className="tap-target flex items-center gap-1 text-xs font-semibold text-[var(--color-accent)] hover:underline"
                >
                  <RotateCcw size={12} /> Восстановить
                </button>
                <button
                  onClick={() => permanentlyDelete(r.id, r.name)}
                  className="tap-target flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"
                >
                  <Trash2 size={12} /> Навсегда
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
