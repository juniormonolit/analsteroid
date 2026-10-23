'use client';
// Проверка звонка по задаче (план повторки, владелец 23.10: «если менеджер закрыл задачу и есть успешный звонок —
// пометка „есть уведомление“ и предложить проанализировать последний звонок на соответствие задаче»; запуск —
// ТОЛЬКО вручную, владелец контролирует бюджет). Движок — сессия ИИ-анализа: GET/POST /api/ai-analysis/task-check,
// результат — GET /api/ai-analysis/{id} → parsed.taskCheck {verdict, items[]}. Видят только РОПы (право разбора).
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, PhoneCall, XCircle } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';

export interface TaskCheckState { hasCall: boolean; check: { id: number; status: string; verdict: string | null; at: string } | null }
interface TaskCheckResult { verdict: 'done' | 'partial' | 'not_done' | 'no_talk' | null; items: { item: string; done: 'yes' | 'partial' | 'no'; quote: string | null; date: string | null; quoteFound: boolean }[] }

export const VERDICT: Record<string, { label: string; bg: string; fg: string }> = {
  done: { label: 'выполнено', bg: '#d9ead3', fg: '#38761d' },
  partial: { label: 'частично', bg: '#fff2cc', fg: '#7f6000' },
  not_done: { label: 'не выполнено', bg: '#f4cccc', fg: '#990000' },
  no_talk: { label: 'разговора нет', bg: '#efefef', fg: '#434343' },
};

/** Состояние проверок для видимых задач (сданных/принятых) — одним запросом, как комментарии задач. */
export function useTaskChecks(taskIds: number[], enabled: boolean) {
  return useQuery<Record<string, TaskCheckState>>({
    queryKey: ['repeat-kanban-task-checks', taskIds.join(',')],
    enabled: enabled && taskIds.length > 0,
    queryFn: async () => {
      const out: Record<string, TaskCheckState> = {};
      for (let i = 0; i < taskIds.length; i += 300) {
        const r = await fetch(`/api/ai-analysis/task-check?taskIds=${taskIds.slice(i, i + 300).join(',')}`);
        if (r.ok) Object.assign(out, await r.json());
      }
      return out;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });
}

/** Блок проверки: результат, если есть; кнопка «Проверить звонок» (стоимость не показываем — владелец 23.10); пока идёт — опрос раз в 4 с. */
export function TaskCheckPanel({ taskId, state }: { taskId: number; state: TaskCheckState | undefined }) {
  const qc = useQueryClient();
  const [runId, setRunId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = runId ?? state?.check?.id ?? null;
  const { data: row } = useQuery<{ status: string; error: string | null; parsed: { taskCheck?: TaskCheckResult } | null; createdAt: string }>({
    queryKey: ['ai-analysis-row', id],
    enabled: id !== null,
    queryFn: async () => { const r = await fetch(`/api/ai-analysis/${id}`); if (!r.ok) throw new Error(String(r.status)); return r.json(); },
    refetchInterval: q => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'error') ? false : 4000),
  });
  const running = !!row && (row.status === 'queued' || row.status === 'running');
  useEffect(() => { if (row?.status === 'done') void qc.invalidateQueries({ queryKey: ['repeat-kanban-task-checks'] }); }, [row?.status, qc]);
  const run = async () => {
    setErr(null);
    const r = await fetch('/api/ai-analysis/task-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setErr(j.error ?? `Ошибка ${r.status}`); return; }
    setRunId(Number(j.id));
  };
  const res = row?.status === 'done' ? row.parsed?.taskCheck ?? null : null;
  const v = res?.verdict ? VERDICT[res.verdict] : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <PhoneCall size={14} className="shrink-0 text-[var(--color-accent)]" />
        <span className="font-semibold text-[var(--color-text)]">Звонок по задаче</span>
        {v && <span className="rounded px-1.5 py-0.5 text-[11.5px] font-semibold" style={{ background: v.bg, color: v.fg }}>{v.label}</span>}
        {row?.status === 'done' && <span className="text-[11px] text-[var(--color-text-muted)]">проверено {new Date(row.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })}</span>}
      </div>
      {!state?.hasCall && !res && <p className="text-[var(--color-text-muted)]">После постановки задачи звонков с расшифровкой нет — проверять нечего.</p>}
      {res && res.items.length > 0 && (
        <ul className="flex flex-col gap-1">
          {res.items.map((it, i) => (
            <li key={i} className="flex min-w-0 items-start gap-1.5">
              {it.done === 'yes' ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-[#38761d]" /> : it.done === 'partial' ? <CircleDashed size={14} className="mt-0.5 shrink-0 text-[#b45f06]" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-[#990000]" />}
              <span className="min-w-0">
                <span className="text-[var(--color-text)]">{it.item}</span>
                {it.quote && <span className="block italic text-[var(--color-text-secondary)]">«{it.quote}»{it.date ? ` · ${it.date}` : ''}{!it.quoteFound ? ' (цитата не найдена в расшифровке)' : ''}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {running && <p className="text-[var(--color-text-muted)]">Проверяю звонок… обычно 10–20 секунд.</p>}
      {row?.status === 'error' && <p className="text-[var(--color-negative)]">Проверка не удалась{row.error ? `: ${row.error}` : ''}.</p>}
      {err && <p className="text-[var(--color-negative)]">{err}</p>}
      {state?.hasCall && !running && (
        <button type="button" onClick={run}
          className="inline-flex min-h-11 items-center gap-1 self-start rounded-md border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] active:scale-[0.98]">
          <PhoneCall size={13} /> {res || row?.status === 'error' ? 'Проверить заново' : 'Проверить звонок'}
        </button>
      )}
    </div>
  );
}

export function TaskCheckModal({ taskId, title, state, onClose }: { taskId: number; title: string; state: TaskCheckState | undefined; onClose: () => void }) {
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Звонок по задаче · ${title}`} desktopWidth="sm:max-w-lg">
      <TaskCheckPanel taskId={taskId} state={state} />
    </Modal>
  );
}
