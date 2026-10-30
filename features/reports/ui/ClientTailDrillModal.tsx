'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { DealCard } from './DealCard';
import type { DrillResult, DrillTarget } from '@/features/reports/engine/clientTail';

// Дрилл «Вход и хвост» (задача владельца 28.10: «сделайте возможность в отчёте
// Вход и хвост проваливаться в сделки и в клиентов»). Клик по цифре «Сделки» /
// «Отгрузки» / «Клиентов» (строка группы или итог) открывает этот список. Из
// списка клиентов — в отгрузки одного клиента (вход + хвост), из сделки — в
// карточку сделки. Шаги складываются в стек: «назад» возвращает к предыдущему.
// Карточка сделки — внутри Modal, как в MetricBreakdownModal (см. там почему).

export interface DrillStep { target: DrillTarget; title: string }

const rub = (v: number) => `${Math.round(v).toLocaleString('ru-RU')} ₽`;
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

async function fetchDrill(body: unknown): Promise<DrillResult> {
  const res = await fetch('/api/reports/client-tail/drill', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    throw new Error(b?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

const clientUrl = (id: string) => `https://td.monolit-crm.ru/crm/contact/details/${id}/`;

export function ClientTailDrillModal({ filters, initial, onClose, onOpenClientCard }: {
  /** Тело запроса отчёта (те же фильтры — список совпадает с кликнутой цифрой). */
  filters: Record<string, unknown>;
  initial: DrillStep;
  onClose: () => void;
  /** Клик по имени клиента: карточка клиента (#11255). Панель карточки живёт вне этого окна, поэтому окно закрывает хозяин. */
  onOpenClientCard?: (contactId: string) => void;
}) {
  const [stack, setStack] = useState<DrillStep[]>([initial]);
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  const step = stack[stack.length - 1];
  const push = (s: DrillStep) => setStack(prev => [...prev, s]);
  const openClient = (contactId: string, name: string | null) =>
    push({
      target: { side: 'both', kind: 'shipments', group: null, contactId },
      title: `${name ?? `Контакт #${contactId}`} — входные и хвостовые отгрузки`,
    });

  const body = { ...filters, target: step.target };
  const { data, isLoading, error } = useQuery<DrillResult>({
    queryKey: ['client-tail-drill', body],
    queryFn: () => fetchDrill(body),
    staleTime: 5 * 60 * 1000,
  });

  const isCreated = step.target.kind === 'created';
  const showSide = step.target.side === 'both';

  return (
    <Modal
      open
      // Esc/клик мимо при открытой карточке закрывают карточку, затем шаг назад, затем окно.
      onOpenChange={o => {
        if (o) return;
        if (openDealId !== null) { setOpenDealId(null); return; }
        onClose();
      }}
      desktopWidth="sm:max-w-[min(1100px,96vw)]"
      contentClassName="h-[100dvh] max-h-[100dvh] rounded-none sm:rounded-lg sm:h-[88vh] sm:max-h-[88vh] overflow-hidden flex flex-col"
      bodyClassName="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      title={
        <span className="flex items-center gap-2 min-w-0">
          {stack.length > 1 && (
            <button type="button" onClick={() => setStack(prev => prev.slice(0, -1))} aria-label="Назад"
              className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <ArrowLeft size={16} />
            </button>
          )}
          <span className="truncate">{step.title}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        {data && (
          <p className="text-xs text-[var(--color-text-muted)]">
            {step.target.kind === 'clients'
              ? <>Клиентов: <b className="text-[var(--color-text)]">{data.total.toLocaleString('ru-RU')}</b>, их отгрузки на {rub(data.amount)}. Нажмите на клиента — откроется его карточка.</>
              : <>{isCreated ? 'Сделок' : 'Отгрузок'}: <b className="text-[var(--color-text)]">{data.total.toLocaleString('ru-RU')}</b> на {rub(data.amount)}
                {isCreated ? ' (сумма сделок, не только отгруженных)' : ''}. Нажмите на сделку — откроется её карточка.</>}
            {data.truncated && ` Показаны первые ${(data.deals ?? data.clients ?? []).length}.`}
          </p>
        )}
        {isLoading && <div className="py-8 text-center text-sm text-[var(--color-text-muted)]">Загружаю…</div>}
        {error && <div className="py-3 text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}

        {data?.deals && (
          <div className="scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                  <th className="text-left font-medium py-1.5 pr-2">Сделка</th>
                  {showSide && <th className="text-left font-medium py-1.5 px-2">Где</th>}
                  <th className="text-left font-medium py-1.5 px-2">Клиент</th>
                  <th className="text-left font-medium py-1.5 px-2">Группа</th>
                  <th className="text-right font-medium py-1.5 px-2">Сумма</th>
                  <th className="text-right font-medium py-1.5 px-2">Создана</th>
                  <th className="text-right font-medium py-1.5 px-2">Отгружена</th>
                  <th className="text-left font-medium py-1.5 pl-2">Менеджер</th>
                </tr>
              </thead>
              <tbody>
                {data.deals.map(d => (
                  <tr key={`${d.side}-${d.dealId}`} className="border-b border-[var(--color-border)] align-top">
                    <td className="py-1.5 pr-2 max-w-[240px]">
                      <button type="button" onClick={() => setOpenDealId(d.dealId)}
                        className="min-h-11 sm:min-h-0 text-left hover:text-[var(--color-accent)] max-w-full">
                        <span className="block truncate">{d.name || `Сделка #${d.dealId}`}</span>
                        <span className="block text-[10px] text-[var(--color-text-muted)]">
                          #{d.dealId} · {d.isRepeatFunnel ? 'повторная воронка' : 'первичная воронка'}
                        </span>
                      </button>
                    </td>
                    {showSide && (
                      <td className="py-1.5 px-2 whitespace-nowrap">
                        <span className={`text-xs ${d.side === 'entry' ? 'text-[var(--color-text)]' : 'text-[var(--color-accent)]'}`}>
                          {d.side === 'entry' ? 'Вход' : 'Хвост'}
                        </span>
                      </td>
                    )}
                    <td className="py-1.5 px-2 max-w-[200px]">
                      {d.contactId ? (
                        showSide ? <span className="block truncate">{d.clientName ?? `Контакт #${d.contactId}`}</span> : (
                          <button type="button" onClick={() => (onOpenClientCard ? onOpenClientCard(d.contactId!) : openClient(d.contactId!, d.clientName))}
                            className="min-h-11 sm:min-h-0 text-left hover:text-[var(--color-accent)] max-w-full">
                            <span className="block truncate">{d.clientName ?? `Контакт #${d.contactId}`}</span>
                          </button>
                        )
                      ) : <span className="text-[var(--color-text-muted)]">без клиента</span>}
                    </td>
                    <td className="py-1.5 px-2 max-w-[160px]"><span className="block truncate text-xs">{d.group}</span></td>
                    <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{rub(d.amount)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{dt(d.createdAt)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{dt(d.deliveredAt)}</td>
                    <td className="py-1.5 pl-2 max-w-[160px]"><span className="block truncate text-xs">{d.managerName ?? '—'}</span></td>
                  </tr>
                ))}
                {data.deals.length === 0 && (
                  <tr><td colSpan={8} className="py-6 text-center text-sm text-[var(--color-text-muted)]">Пусто</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {data?.clients && (
          <div className="scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                  <th className="text-left font-medium py-1.5 pr-2">Клиент</th>
                  <th className="text-left font-medium py-1.5 px-2">Менеджер</th>
                  <th className="text-right font-medium py-1.5 px-2">Отгрузок</th>
                  <th className="text-right font-medium py-1.5 px-2">Сумма отгрузок</th>
                  <th className="text-right font-medium py-1.5 pl-2 whitespace-nowrap">Последняя отгрузка</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map(c => (
                  <tr key={c.contactId} className="border-b border-[var(--color-border)]">
                    <td className="py-1.5 pr-2 max-w-[280px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <button type="button" onClick={() => (onOpenClientCard ? onOpenClientCard(c.contactId) : openClient(c.contactId, c.name))}
                          className="min-h-11 sm:min-h-0 text-left truncate hover:text-[var(--color-accent)]">
                          {c.name ?? `Контакт #${c.contactId}`}
                        </button>
                        <a href={clientUrl(c.contactId)} target="_blank" rel="noreferrer" aria-label="Открыть в Битриксе"
                          className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
                          <ExternalLink size={12} />
                        </a>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 max-w-[180px]"><span className="block truncate text-xs" title={c.responsibleName ?? undefined}>{c.responsibleName ?? '—'}</span></td>
                    <td className="py-1.5 px-2 text-right tabular-nums">{c.shipments}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">{rub(c.amount)}</td>
                    <td className="py-1.5 pl-2 text-right tabular-nums whitespace-nowrap">{dt(c.lastAt)}</td>
                  </tr>
                ))}
                {data.clients.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-sm text-[var(--color-text-muted)]">Пусто</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </Modal>
  );
}
