'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Users } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Modal } from '@/components/ui/Modal';
import { DealCard } from './DealCard';
import type { MatrixTransitionsResult, TransitionChain, TransitionDealBrief } from '@/features/reports/engine/productMatrix';

// Дрилл ячейки «Матрицы переходов» (задача владельца 10.09): «хочу видеть список
// всех менеджеров и явно понимать, кто лучше продаёт кровлю после газобетона, и
// дальше провалиться в эти сделки и увидеть цепочку».
//
// Слева — менеджеры ЗАКРЫВАЮЩЕЙ сделки: сколько связок и какая доля от ИХ
// СОБСТВЕННЫХ повторных покупок после исходной категории (иначе рейтинг просто
// повторял бы размер клиентской базы). Справа — цепочки в две колонки:
// предыдущая покупка → следующая, между ними разрыв в днях. Клик по сделке
// открывает карточку поверх (как в дрилл-дауне отчёта).

const fmtMoney = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
const fmtDate = (iso: string) => (iso ? format(new Date(iso), 'd MMM yy', { locale: ru }) : '—');

function DealSide({ deal, highlight, onOpen }: { deal: TransitionDealBrief; highlight: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex-1 min-w-0 text-left rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 hover:border-[var(--color-accent)] transition-colors"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-mono text-[var(--color-accent)] shrink-0">#{deal.dealId}</span>
        <span className="text-[11px] text-[var(--color-text-muted)] shrink-0 tabular-nums">{fmtDate(deal.at)}</span>
        <span className="ml-auto text-xs tabular-nums text-[var(--color-text)] shrink-0">{fmtMoney(deal.amount)}</span>
      </div>
      <div className="mt-0.5 text-xs text-[var(--color-text)] break-words line-clamp-2">{deal.name ?? '—'}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {deal.cats.map(c => (
          <span
            key={c}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              c === highlight
                ? 'bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] text-[var(--color-accent)] font-medium'
                : 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]'
            }`}
          >
            {c}
          </span>
        ))}
      </div>
    </button>
  );
}

function ChainRow({ chain, from, to, onOpenDeal }: {
  chain: TransitionChain; from: string; to: string; onOpenDeal: (id: number) => void;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-2">
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-[var(--color-text-muted)]">
        <Users size={11} className="shrink-0" />
        <span className="truncate">{chain.managerName ?? `Менеджер ${chain.managerId ?? '—'}`}</span>
        <span className="ml-auto shrink-0 tabular-nums">через {chain.days} дн.</span>
      </div>
      {/* Две колонки: было → стало. На телефоне — стопкой, стрелка поворачивается. */}
      <div className="flex flex-col sm:flex-row items-stretch gap-2">
        <DealSide deal={chain.prev} highlight={from} onOpen={() => onOpenDeal(chain.prev.dealId)} />
        <div className="flex items-center justify-center shrink-0 text-[var(--color-accent)]">
          <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
        </div>
        <DealSide deal={chain.next} highlight={to} onOpen={() => onOpenDeal(chain.next.dealId)} />
      </div>
    </div>
  );
}

export function TransitionDrillModal({ from, to, filters, onClose }: {
  from: string;
  to: string;
  /** Тело запроса матрицы: период, отделы, менеджеры, пилюли, mode. */
  filters: Record<string, unknown>;
  onClose: () => void;
}) {
  const [drillManagerId, setDrillManagerId] = useState<string | null>(null);
  const [openDealId, setOpenDealId] = useState<number | null>(null);

  const body = useMemo(() => ({ ...filters, from, to, drillManagerId }), [filters, from, to, drillManagerId]);
  const { data, isLoading, error } = useQuery<MatrixTransitionsResult>({
    queryKey: ['matrix-transitions', body],
    queryFn: async () => {
      const res = await fetch('/api/reports/product-matrix/transitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const pct = data && data.afterFrom > 0 ? (data.total / data.afterFrom) * 100 : 0;
  const maxN = Math.max(1, ...(data?.managers ?? []).map(m => m.n));
  const selected = data?.managers.find(m => m.managerId === drillManagerId) ?? null;

  return (
    <Modal
      open
      onOpenChange={o => { if (!o) { if (openDealId !== null) setOpenDealId(null); else onClose(); } }}
      desktopWidth="sm:max-w-[1200px]"
      contentClassName="h-[100dvh] max-h-[100dvh] rounded-none sm:rounded-lg sm:h-[88vh] sm:max-h-[88vh]"
      title={
        <span className="flex flex-wrap items-baseline gap-x-2 min-w-0">
          <span className="truncate">{from}</span>
          <ArrowRight size={13} className="shrink-0 text-[var(--color-accent)]" />
          <span className="truncate">{to}</span>
        </span>
      }
    >
      <div className="mb-3 text-sm text-[var(--color-text-muted)]">
        {isLoading ? 'Считаем…' : error ? '' : (
          <>
            <b className="text-[var(--color-text)] tabular-nums">{data?.total ?? 0}</b> связок из{' '}
            <b className="text-[var(--color-text)] tabular-nums">{data?.afterFrom ?? 0}</b> повторных покупок после «{from}»
            {' '}(<b className="text-[var(--color-text)]">{pct.toFixed(pct >= 10 ? 0 : 1)} %</b>)
          </>
        )}
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-[var(--color-negative,#d33)]">{error instanceof Error ? error.message : String(error)}</div>
      ) : isLoading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-9 bg-[var(--color-border)] rounded animate-pulse" />)}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_1fr] items-start">
          {/* Кто продаёт связку */}
          <section className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5">
              Кто продаёт · {data?.managers.length ?? 0}
            </h3>
            <div className="rounded-xl border border-[var(--color-border)] overflow-hidden">
              <button
                onClick={() => setDrillManagerId(null)}
                className={`w-full min-h-11 px-3 text-left text-sm border-b border-[var(--color-border)] transition-colors ${
                  drillManagerId === null ? 'bg-[var(--color-bg-hover)] font-medium' : 'hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                Все менеджеры
              </button>
              <div className="max-h-[52vh] overflow-y-auto">
                {(data?.managers ?? []).filter(m => m.n > 0).map(m => {
                  const share = m.afterFrom > 0 ? (m.n / m.afterFrom) * 100 : 0;
                  const active = m.managerId === drillManagerId;
                  return (
                    <button
                      key={m.managerId ?? 'none'}
                      onClick={() => setDrillManagerId(active ? null : m.managerId)}
                      className={`w-full min-h-11 px-3 py-1.5 text-left border-b border-[var(--color-border)] last:border-b-0 transition-colors ${
                        active ? 'bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]' : 'hover:bg-[var(--color-bg-hover)]'
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{m.name ?? `#${m.managerId}`}</span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-[var(--color-text)]">{m.n}</span>
                        <span className="shrink-0 w-12 text-right text-xs tabular-nums text-[var(--color-text-muted)]">{share.toFixed(0)} %</span>
                      </div>
                      {/* Полоска — доля своих повторных покупок, а не абсолют: так видно
                          не «у кого больше клиентов», а кто реально допродаёт. */}
                      <div className="mt-1 h-1 rounded bg-[var(--color-bg-hover)] overflow-hidden">
                        <div className="h-full bg-[var(--color-accent)]" style={{ width: `${(m.n / maxN) * 100}%` }} />
                      </div>
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">из {m.afterFrom} повт. покупок после «{from}»</div>
                    </button>
                  );
                })}
                {(data?.managers ?? []).filter(m => m.n > 0).length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-[var(--color-text-muted)]">Связок нет</div>
                )}
              </div>
            </div>
          </section>

          {/* Цепочки сделок */}
          <section className="min-w-0">
            <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-1.5">
              Цепочки{selected ? ` · ${selected.name ?? selected.managerId}` : ''} · {data?.chains.length ?? 0}
              {data?.truncated && <span className="ml-1 normal-case font-normal">(показаны последние 300)</span>}
            </h3>
            <div className="flex flex-col gap-2 lg:max-h-[62vh] lg:overflow-y-auto lg:pr-1">
              {(data?.chains ?? []).map(c => (
                <ChainRow key={`${c.prev.dealId}-${c.next.dealId}`} chain={c} from={from} to={to} onOpenDeal={setOpenDealId} />
              ))}
              {(data?.chains ?? []).length === 0 && (
                <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">Нет цепочек в этом срезе</div>
              )}
            </div>
          </section>
        </div>
      )}

      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </Modal>
  );
}
