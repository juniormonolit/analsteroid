'use client';
// «Принять вариант» с предпросмотром «было/станет» товаров сделки (S4: GET /request/:id/deal-rows?offerId=).
// Подтверждение передаёт hash предпросмотра в action accept { dealRows: { confirm: true, hash } } — без него
// сделку не трогают (deal_rows_status='skipped'). Предпросмотр недоступен (нет сделки, Битрикс не ответил,
// эндпоинт ещё не выкачен) — принимаем без записи товаров и честно об этом пишем.
import { useQuery } from '@tanstack/react-query';
import { Modal } from '@/components/ui/Modal';
import type { Offer, RequestDetails } from '../engine/requests/contract';
import type { DealRowChange, DealRowView, DealRowsPreview } from '../engine/bitrix/types';
import { lkFetch } from './api';
import { money, qty } from './format';

const KIND: Record<DealRowChange['kind'], { label: string; cls: string }> = {
  keep: { label: 'без изменений', cls: 'text-[var(--color-text-muted)]' },
  replace: { label: 'заменится', cls: 'text-[var(--color-warning)]' },
  add: { label: 'добавится', cls: 'text-[var(--color-positive)]' },
};
const row = (r: DealRowView | null) => (r ? `${r.name} — ${qty(r.quantity)} ${r.measure ?? ''} × ${money(r.price)}` : '—');

export function usePreview(d: RequestDetails, offerId: number | null, enabled = true) {
  return useQuery<DealRowsPreview>({
    queryKey: ['logist-deal-rows', d.id, offerId, d.version],
    queryFn: () => lkFetch<DealRowsPreview>(`/api/logist-kanban/request/${d.id}/deal-rows${offerId ? `?offerId=${offerId}` : ''}`),
    enabled: enabled && !!d.deal,
    retry: false,
    staleTime: 0,
  });
}

export function PreviewBody({ p }: { p: DealRowsPreview }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <ul className="flex max-h-56 min-w-0 flex-col gap-1 overflow-y-auto text-[12.5px]">
        {p.changes.map((c, i) => (
          <li key={i} className="min-w-0 rounded-md bg-[var(--color-bg-surface)] px-2 py-1">
            <span className={`text-[11px] font-medium ${KIND[c.kind].cls}`}>{KIND[c.kind].label}</span>
            {c.kind !== 'add' && <div className="break-words text-[var(--color-text-muted)] [text-decoration:line-through]">{c.kind === 'replace' ? row(c.before) : ''}</div>}
            <div className="break-words">{c.kind === 'keep' ? row(c.before) : row(c.after)}</div>
            {c.note && <div className="text-[11px] text-[var(--color-text-muted)]">{c.note}</div>}
          </li>
        ))}
      </ul>
      <p className="text-[12.5px]">Сумма товаров сделки: {money(p.beforeTotal)} → <b>{money(p.afterTotal)}</b></p>
      {p.warnings.map(w => <p key={w} className="text-[12px] text-[var(--color-warning)]">⚠ {w}</p>)}
    </div>
  );
}

export function AcceptOfferDialog({ d, offer: o, busy, onCancel, onConfirm }: {
  d: RequestDetails; offer: Offer; busy: boolean; onCancel: () => void; onConfirm: (hash: string | null) => void;
}) {
  const pv = usePreview(d, o.id);
  const p = pv.data;
  const willWrite = !!p && p.writeEnabled;
  const rows = o.lines.filter(l => l.availability !== 'none');
  return (
    <Modal open onOpenChange={x => { if (!x) onCancel(); }} title={`Принять вариант № ${o.n}?`} desktopWidth="sm:max-w-lg">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        {d.deal && pv.isLoading && <p className="text-[var(--color-text-muted)]">Читаю товары сделки № {d.deal.id}…</p>}
        {p && (
          <>
            <p>{willWrite ? `Товары сделки № ${p.dealId} будут переписаны так:` : `Так изменились бы товары сделки № ${p.dealId}:`}</p>
            <PreviewBody p={p} />
            {!p.writeEnabled && (
              <p className="text-[12px] text-[var(--color-text-muted)]">Запись товаров в сделку сейчас выключена{p.blockedReason ? ` (${p.blockedReason})` : ''} — вариант будет принят, сделка не изменится.</p>
            )}
          </>
        )}
        {(!d.deal || pv.isError) && (
          <>
            <p>Вариант: {rows.length} строк, {money(o.goodsTotal)}{o.deliveryTotal ? ` + доставка ${money(o.deliveryTotal)}` : ''}.</p>
            <ul className="max-h-40 overflow-y-auto text-[12.5px] text-[var(--color-text-secondary)]">
              {rows.map(l => <li key={l.id} className="break-words">• {l.name} — {qty(l.quantity)} {l.measure ?? ''} × {money(l.price)}</li>)}
            </ul>
            <p className="text-[12px] text-[var(--color-text-muted)]">
              {d.deal ? `Товары сделки не прочитались (${pv.error instanceof Error ? pv.error.message : 'ошибка'}) — вариант будет принят без записи в сделку; переписать можно позже из карточки.` : 'Запрос без сделки — переписывать нечего.'}
            </p>
          </>
        )}
        <p className="text-[12px] text-[var(--color-text-muted)]">Остальные варианты останутся в истории. Запрос уйдёт в «Приняты».</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || (!!d.deal && pv.isLoading)} onClick={() => onConfirm(willWrite ? p!.hash : null)}
            className="min-h-11 rounded-lg bg-[var(--color-positive)] px-4 text-sm font-medium text-white disabled:opacity-50">
            {willWrite ? 'Принять и переписать товары' : 'Принять'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
