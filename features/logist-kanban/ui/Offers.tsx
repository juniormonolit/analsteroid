'use client';
// Варианты ответа логиста: карточка варианта (с разбором «наша / конкурент / вариант» для cheaper) и форма
// нового варианта — строки (позиции запроса подставлены, можно добавить свою), доставка, итог считается на лету.
// Итоги на сервере (validate.ts) считаются так же: товары = Σ строк, кроме «нет в наличии»; доставка = машины × цена.
import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { Availability, Offer, OfferInput, OfferLineInput, RequestDetails, RequestItem } from '../engine/requests/contract';
import { fmtDT, fmtDate, money, qty } from './format';

const AVAIL_OPTIONS: { value: Availability; label: string }[] = [
  { value: 'ok', label: 'Есть' }, { value: 'analog', label: 'Аналог' }, { value: 'none', label: 'Нет в наличии' },
];
const AVAIL_LABEL: Record<Availability, string> = { ok: 'есть', analog: 'аналог', none: 'нет' };
const OFFER_STATUS: Record<Offer['status'], { label: string; cls: string }> = {
  active: { label: 'актуален', cls: 'text-[var(--color-text-muted)]' },
  withdrawn: { label: 'отозван', cls: 'text-[var(--color-negative)]' },
  accepted: { label: 'принят', cls: 'font-semibold text-[var(--color-positive)]' },
};
export const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-border-focus)] sm:min-h-9 sm:text-sm';

const n = (v: string): number | null => {
  const x = Number(v.replace(/\s/g, '').replace(',', '.'));
  return v.trim() !== '' && Number.isFinite(x) && x >= 0 ? x : null;
};
const lineSum = (q: number | null, p: number | null) => (q != null && p != null ? Math.round(q * p * 100) / 100 : null);

// ── карточка варианта ───────────────────────────────────────────────────────────────────

export function OfferCard({ offer: o, details: d, canAccept, canWithdraw, busy, onAccept, onWithdraw }: {
  offer: Offer; details: RequestDetails; canAccept: boolean; canWithdraw: boolean; busy: boolean;
  onAccept: (o: Offer) => void; onWithdraw: (o: Offer) => void;
}) {
  const items = new Map(d.items.map(i => [i.id, i]));
  const cheaper = d.type === 'cheaper';
  const st = OFFER_STATUS[o.status];
  const competitorTotal = d.competitorTotal ?? (d.items.some(i => i.competitorPrice != null)
    ? d.items.reduce((s, i) => s + (i.competitorPrice ?? 0) * (i.quantity ?? 0), 0) : null);
  const beats = cheaper && competitorTotal != null ? o.goodsTotal - competitorTotal : null;
  return (
    <article className={`flex min-w-0 flex-col gap-2 rounded-lg border p-3 ${o.status === 'accepted' ? 'border-[var(--color-positive)]' : o.status === 'withdrawn' ? 'border-[var(--color-border)] opacity-60' : 'border-[var(--color-border)]'}`}>
      <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h4 className="text-sm font-semibold">Вариант № {o.n}</h4>
        <span className={`text-xs ${st.cls}`}>{st.label}</span>
        {o.cycle > 1 && <span className="text-xs text-[var(--color-text-muted)]">цикл {o.cycle}</span>}
        <span className="ml-auto text-xs text-[var(--color-text-muted)]">{o.author?.name ?? '—'} · {fmtDT(o.createdAt)}</span>
      </header>
      <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-0.5 text-[12.5px] sm:grid-cols-2">
        {o.supplier && <div className="min-w-0 truncate"><dt className="inline text-[var(--color-text-muted)]">Поставщик: </dt><dd className="inline">{o.supplier}</dd></div>}
        {o.paymentForm && <div className="min-w-0 truncate"><dt className="inline text-[var(--color-text-muted)]">Оплата: </dt><dd className="inline">{o.paymentForm}</dd></div>}
        {(o.leadTime || o.readyDate) && <div className="min-w-0 truncate"><dt className="inline text-[var(--color-text-muted)]">Срок: </dt><dd className="inline">{[o.leadTime, o.readyDate && `готово ${fmtDate(o.readyDate)}`].filter(Boolean).join(', ')}</dd></div>}
        {(o.deliveryTrucks || o.deliveryPrice) && <div className="min-w-0 truncate"><dt className="inline text-[var(--color-text-muted)]">Доставка: </dt><dd className="inline">{qty(o.deliveryTrucks)} маш. × {money(o.deliveryPrice)}</dd></div>}
      </dl>
      <div className="scroll-x">
        <table className="w-full min-w-[520px] text-[12.5px]">
          <thead className="text-left text-[11px] text-[var(--color-text-muted)]">
            <tr>
              <th className="py-1 pr-2 font-medium">Товар</th>
              <th className="py-1 pr-2 text-right font-medium">Кол-во</th>
              {cheaper && <th className="py-1 pr-2 text-right font-medium">Наша</th>}
              {cheaper && <th className="py-1 pr-2 text-right font-medium">Конкурент</th>}
              <th className="py-1 pr-2 text-right font-medium">{cheaper ? 'Вариант' : 'Цена'}</th>
              <th className="py-1 text-right font-medium">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map(l => {
              const it = l.itemId ? items.get(l.itemId) : undefined;
              const win = cheaper && it?.competitorPrice != null && l.price != null ? l.price <= it.competitorPrice : null;
              return (
                <tr key={l.id} className={`border-t border-[var(--color-border)] align-top ${l.availability === 'none' ? 'text-[var(--color-text-muted)] line-through' : ''}`}>
                  <td className="py-1 pr-2">
                    <div className="break-words">{l.name}</div>
                    {(l.availability !== 'ok' || !l.itemId || l.comment) && (
                      <div className="text-[11px] text-[var(--color-text-muted)] no-underline">
                        {[l.availability !== 'ok' && AVAIL_LABEL[l.availability], !l.itemId && 'новая позиция', l.comment].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{qty(l.quantity)} {l.measure ?? ''}</td>
                  {cheaper && <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{money(it?.ourPrice)}</td>}
                  {cheaper && <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{money(it?.competitorPrice)}</td>}
                  <td className={`whitespace-nowrap py-1 pr-2 text-right tabular-nums ${win === true ? 'font-semibold text-[var(--color-positive)]' : win === false ? 'text-[var(--color-negative)]' : ''}`}>{money(l.price)}</td>
                  <td className="whitespace-nowrap py-1 text-right tabular-nums">{money(l.sum)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[12.5px]">
        <span>Товары: <b className="tabular-nums">{money(o.goodsTotal)}</b></span>
        {o.deliveryTotal > 0 && <span>Доставка: <b className="tabular-nums">{money(o.deliveryTotal)}</b></span>}
        <span className="text-sm">Итого: <b className="tabular-nums">{money(o.total)}</b></span>
        {cheaper && (
          <span className="flex flex-wrap gap-x-3 text-[12px] text-[var(--color-text-secondary)]">
            <span>наша {money(d.ourTotal)}</span>
            {competitorTotal != null && <span>конкурент {money(competitorTotal)}</span>}
            {beats != null && (
              <span className={beats <= 0 ? 'font-semibold text-[var(--color-positive)]' : 'font-semibold text-[var(--color-negative)]'}>
                {beats <= 0 ? `дешевле конкурента на ${money(-beats)}` : `дороже конкурента на ${money(beats)}`}
              </span>
            )}
          </span>
        )}
      </div>
      {o.comment && <p className="whitespace-pre-wrap break-words text-[12.5px] text-[var(--color-text-secondary)]">{o.comment}</p>}
      {(canAccept || canWithdraw) && o.status === 'active' && (
        <div className="flex flex-wrap gap-2">
          {canAccept && (
            <button type="button" disabled={busy} onClick={() => onAccept(o)} className="min-h-11 rounded-lg bg-[var(--color-positive)] px-4 text-sm font-medium text-white disabled:opacity-50">
              Принять этот вариант
            </button>
          )}
          {canWithdraw && (
            <button type="button" disabled={busy} onClick={() => onWithdraw(o)} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50">
              Отозвать
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// ── форма варианта ──────────────────────────────────────────────────────────────────────

interface LineDraft { key: string; itemId: number | null; availability: Availability; name: string; quantity: string; measure: string; price: string; comment: string }

const fromItem = (i: RequestItem): LineDraft => ({
  key: `i${i.id}`, itemId: i.id, availability: 'ok', name: i.name, quantity: i.quantity != null ? String(i.quantity) : '',
  measure: i.measure ?? '', price: '', comment: '',
});

export function OfferForm({ details: d, busy, onSubmit, onCancel }: {
  details: RequestDetails; busy: boolean; onSubmit: (o: OfferInput) => void; onCancel: () => void;
}) {
  const [lines, setLines] = useState<LineDraft[]>(() => d.items.map(fromItem));
  const [supplier, setSupplier] = useState('');
  const [paymentForm, setPaymentForm] = useState(d.paymentForm ?? '');
  const [leadTime, setLeadTime] = useState('');
  const [readyDate, setReadyDate] = useState('');
  const [trucks, setTrucks] = useState('');
  const [truckPrice, setTruckPrice] = useState('');
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const seq = useMemo(() => ({ n: 0 }), []);

  const totals = useMemo(() => {
    const goods = lines.reduce((s, l) => (l.availability === 'none' ? s : s + (lineSum(n(l.quantity), n(l.price)) ?? 0)), 0);
    const delivery = (n(trucks) ?? 0) * (n(truckPrice) ?? 0);
    return { goods, delivery, total: goods + delivery };
  }, [lines, trucks, truckPrice]);

  const patch = (key: string, p: Partial<LineDraft>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...p } : l)));
  const addLine = () => setLines(ls => [...ls, { key: `n${++seq.n}`, itemId: null, availability: 'ok', name: '', quantity: '', measure: '', price: '', comment: '' }]);

  const submit = () => {
    const ls = lines.filter(l => l.name.trim());
    if (!ls.length) { setErr('Нужна хотя бы одна строка'); return; }
    const noPrice = ls.filter(l => l.availability !== 'none' && n(l.price) == null);
    if (noPrice.length) { setErr(`Укажите цену: ${noPrice.map(l => l.name).slice(0, 3).join(', ')}${noPrice.length > 3 ? '…' : ''} (или отметьте «Нет в наличии»)`); return; }
    setErr(null);
    const out: OfferLineInput[] = ls.map(l => ({
      itemId: l.itemId, availability: l.availability, name: l.name.trim(),
      quantity: n(l.quantity), measure: l.measure.trim() || null, price: l.availability === 'none' ? null : n(l.price), comment: l.comment.trim() || null,
    }));
    onSubmit({
      supplier: supplier.trim() || null, paymentForm: paymentForm.trim() || null, leadTime: leadTime.trim() || null,
      readyDate: readyDate || null, deliveryTrucks: n(trucks), deliveryPrice: n(truckPrice), comment: comment.trim() || null, lines: out,
    });
  };

  const items = new Map(d.items.map(i => [i.id, i]));
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--color-accent)] p-3" aria-label="Новый вариант">
      <h4 className="text-sm font-semibold">Новый вариант ответа</h4>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Поставщик / база
          <input value={supplier} onChange={e => setSupplier(e.target.value)} className={INPUT} placeholder="ООО «…», склад Подольск" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Форма оплаты
          <input value={paymentForm} onChange={e => setPaymentForm(e.target.value)} className={INPUT} placeholder="безнал с НДС" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Срок поставки
          <input value={leadTime} onChange={e => setLeadTime(e.target.value)} className={INPUT} placeholder="3–5 дней" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Готово к отгрузке
          <input type="date" value={readyDate} onChange={e => setReadyDate(e.target.value)} className={INPUT} />
        </label>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {lines.map((l, i) => {
          const it = l.itemId ? items.get(l.itemId) : undefined;
          const sum = l.availability === 'none' ? null : lineSum(n(l.quantity), n(l.price));
          return (
            <div key={l.key} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-[var(--color-bg-surface)] p-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-5 shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{i + 1}</span>
                <input value={l.name} onChange={e => patch(l.key, { name: e.target.value })} aria-label="Наименование" placeholder="Наименование"
                  className={`${INPUT} flex-1`} />
                <button type="button" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label="Убрать строку"
                  className="tap-target shrink-0 rounded p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><Trash2 size={14} /></button>
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-1.5 pl-7 sm:grid-cols-[1.2fr_0.8fr_0.7fr_1fr_auto]">
                <SearchSelect ariaLabel="Наличие" value={l.availability} onChange={v => patch(l.key, { availability: v as Availability })} options={AVAIL_OPTIONS}
                  className="min-h-11 w-full min-w-0 justify-start rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm sm:min-h-9" />
                <input value={l.quantity} onChange={e => patch(l.key, { quantity: e.target.value })} inputMode="decimal" aria-label="Количество" placeholder="Кол-во" className={`${INPUT} tabular-nums`} />
                <input value={l.measure} onChange={e => patch(l.key, { measure: e.target.value })} aria-label="Единица" placeholder="ед." className={INPUT} />
                <input value={l.price} onChange={e => patch(l.key, { price: e.target.value })} inputMode="decimal" aria-label="Цена за единицу"
                  placeholder={it?.ourPrice != null ? `наша ${Math.round(it.ourPrice)}` : 'Цена, ₽'} disabled={l.availability === 'none'} className={`${INPUT} tabular-nums disabled:opacity-50`} />
                <span className="col-span-2 self-center text-right text-sm tabular-nums sm:col-span-1">{sum != null ? money(sum) : '—'}</span>
              </div>
              {(l.availability !== 'ok' || l.comment) || !l.itemId ? (
                <input value={l.comment} onChange={e => patch(l.key, { comment: e.target.value })} aria-label="Комментарий к строке"
                  placeholder={l.availability === 'analog' ? 'Какой аналог предлагаем' : 'Комментарий к строке'} className={`${INPUT} ml-7 w-[calc(100%-1.75rem)]`} />
              ) : null}
              {d.type === 'cheaper' && it?.competitorPrice != null && (
                <div className="pl-7 text-[11.5px] text-[var(--color-text-muted)]">
                  конкурент {money(it.competitorPrice)} за ед.{n(l.price) != null && (
                    <b className={n(l.price)! <= it.competitorPrice ? ' text-[var(--color-positive)]' : ' text-[var(--color-negative)]'}>
                      {n(l.price)! <= it.competitorPrice ? ' — дешевле' : ' — дороже'}
                    </b>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <button type="button" onClick={addLine} className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg border border-dashed border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)]">
          <Plus size={14} aria-hidden /> Добавить строку
        </button>
      </div>

      <div className="grid min-w-0 grid-cols-2 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Доставка: машин
          <input value={trucks} onChange={e => setTrucks(e.target.value)} inputMode="decimal" className={`${INPUT} tabular-nums`} placeholder="0" />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Цена машины, ₽
          <input value={truckPrice} onChange={e => setTruckPrice(e.target.value)} inputMode="decimal" className={`${INPUT} tabular-nums`} placeholder="0" />
        </label>
      </div>
      <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--color-text-muted)]">Комментарий
        <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} className={`${INPUT} py-2`} placeholder="Условия, остатки, что уточнить" />
      </label>

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg bg-[var(--color-bg-surface)] px-3 py-2 text-sm">
        <span>Товары: <b className="tabular-nums">{money(totals.goods)}</b></span>
        <span>Доставка: <b className="tabular-nums">{money(totals.delivery)}</b></span>
        <span>Итого: <b className="tabular-nums">{money(totals.total)}</b></span>
        {d.type === 'cheaper' && d.competitorTotal != null && (
          <span className={totals.goods <= d.competitorTotal ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}>
            конкурент {money(d.competitorTotal)}
          </span>
        )}
      </div>
      {err && <div role="alert" className="text-sm text-[var(--color-negative)]">{err}</div>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-lg px-3 text-sm hover:bg-[var(--color-bg-hover)]">Отмена</button>
        <button type="button" disabled={busy} onClick={submit} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50">
          Отправить вариант менеджеру
        </button>
      </div>
    </section>
  );
}
