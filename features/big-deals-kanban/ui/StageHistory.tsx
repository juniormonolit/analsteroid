'use client';
// Стадия сделки в шапке карточки задачи + история стадий по нажатию (Осипов 24.11: «надо бы дату изменения этапа
// сделки, и при нажатии чтоб открывалось красиво история по стадиям с датами»).
// Рядом со стадией — с какого числа сделка в ней и сколько дней; нажатие — поповер с лентой стадий:
// дата перехода, сколько дней сделка простояла в каждой, переносы между воронками. Данные — GET …/task/{id}/stages.
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { BigDealInfo, BigStageStep } from '../engine/types';
import { fmtDT } from './format';

const DAY = 86_400_000;
/** Читаемый текст поверх цвета стадии Битрикса (там и светлые, и тёмные заливки). */
export function onColor(hex: string): string {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map(x => x + x).join('') : h.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#1f1f1f' : '#ffffff';
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
/** «5 дн.», «3 ч», «меньше часа». */
function span(ms: number): string {
  if (ms >= DAY) return `${Math.floor(ms / DAY)} дн.`;
  const h = Math.floor(ms / 3600_000);
  return h >= 1 ? `${h} ч` : 'меньше часа';
}

function mockSteps(deal: BigDealInfo): BigStageStep[] {
  const now = Date.now();
  const s = (d: number, name: string, color: string | null, kind: BigStageStep['kind'] = 'moved'): BigStageStep =>
    ({ at: new Date(now - d * DAY).toISOString(), stageId: name, name, color, kind, semantic: null });
  return [s(9, 'Новая', '#39a8ef', 'created'), s(8, 'Квалификация', '#2fc6f6', 'funnel'), s(6, 'Отправил КП', '#55d0e0'),
    { ...s(2, deal.stageName || 'Текущая', deal.stageColor ?? null) }];
}

export function StageBadge({ deal, taskId, mock = false }: { deal: BigDealInfo; taskId: number; mock?: boolean }) {
  const label = deal.stageName || (deal.closed === 'won' ? 'сделка выиграна' : deal.closed === 'lost' ? 'сделка проиграна' : '—');
  const since = deal.stageAt ?? null;
  const q = useQuery<{ steps: BigStageStep[] }>({
    queryKey: ['big-deals-stages', taskId, mock],
    enabled: false, // грузим по открытию поповера
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      if (mock) return { steps: mockSteps(deal) };
      const r = await fetch(`/api/big-deals-kanban/task/${taskId}/stages`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось загрузить историю стадий');
      return j;
    },
  });
  const steps = q.data?.steps ?? [];
  const now = Date.now();

  return (
    <Popover align="start" className="w-[340px] max-w-[calc(100vw-16px)] p-0"
      onOpenChange={o => { if (o && !q.data) void q.refetch(); }}
      trigger={
        <button type="button" title="История стадий сделки"
          className="inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded text-left">
          <span className={`inline-flex min-w-0 items-center gap-1 rounded px-2 py-0.5 text-[12.5px] font-semibold ${deal.stageColor ? '' : deal.closed === 'won' ? 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]' : deal.closed === 'lost' ? 'bg-[var(--color-negative-soft)] text-[var(--color-negative)]' : 'bg-[var(--color-bg-hover)]'}`}
            style={deal.stageColor ? { background: deal.stageColor, color: onColor(deal.stageColor) } : undefined}>
            <span className="min-w-0 truncate">{label}</span><ChevronDown size={12} className="shrink-0 opacity-80" aria-hidden />
          </span>
          {since && (
            <span className="shrink-0 text-[12px] text-[var(--color-text-muted)]" title={`В этой стадии с ${fmtDT(since)}`}>
              с {fmtDate(since)} · {span(now - Date.parse(since))}
            </span>
          )}
        </button>
      }>
      <div className="flex flex-col">
        <div className="border-b border-[var(--color-border)] px-3 py-2 text-[13px] font-semibold text-[var(--color-text)]">
          История стадий сделки № {deal.id}
        </div>
        {q.isFetching && !q.data && (
          <div className="flex items-center gap-2 px-3 py-3 text-[13px] text-[var(--color-text-muted)]"><Loader2 size={14} className="animate-spin" /> Загружаю…</div>
        )}
        {q.isError && (
          <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-[13px] text-[var(--color-text-muted)]">
            {(q.error as Error).message}
            <button type="button" onClick={() => void q.refetch()} className="tap-target underline">Повторить</button>
          </div>
        )}
        {q.data && !steps.length && <div className="px-3 py-3 text-[13px] text-[var(--color-text-muted)]">Битрикс не хранит историю этой сделки.</div>}
        {steps.length > 0 && (
          <ol className="flex flex-col px-3 py-2">
            {steps.map((s, i) => {
              const next = steps[i + 1];
              const last = i === steps.length - 1;
              const dur = (next ? Date.parse(next.at) : now) - Date.parse(s.at);
              return (
                <li key={i} className="relative flex min-w-0 gap-2.5 pb-3 last:pb-1">
                  {/* Линия ленты и точка цветом стадии. */}
                  {!last && <span className="absolute left-[5px] top-3 h-full w-px bg-[var(--color-border)]" aria-hidden />}
                  <span className={`relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2 ${last ? 'border-[var(--color-accent)]' : 'border-transparent'}`}
                    style={{ background: s.color ?? 'var(--color-text-muted)' }} aria-hidden />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                      <span className={`min-w-0 break-words text-[13px] ${last ? 'font-semibold text-[var(--color-text)]' : 'text-[var(--color-text)]'}`}>{s.name}</span>
                      {s.kind === 'created' && <span className="text-[11px] text-[var(--color-text-muted)]">сделка создана</span>}
                      {s.kind === 'funnel' && <span className="text-[11px] text-[var(--color-text-muted)]">перенос в другую воронку</span>}
                    </div>
                    <div className="text-[11.5px] tabular-nums text-[var(--color-text-muted)]">
                      {fmtDT(s.at)} · {last ? (s.semantic ? 'итоговая стадия' : `сейчас, уже ${span(dur)}`) : span(dur)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Popover>
  );
}
