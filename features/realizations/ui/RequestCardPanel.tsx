'use client';
// Карточка заявки раздела «Реализация»: шапка, состав, приобретения, история
// статусов (со всех копий заявки). Только просмотр — никаких ссылок в 1С/Битрикс.
// Задача #8126 (находки 6, 13): не модалка, а та же правая панель, что карточка
// сделки/дрилл «Продаж» (SidePanelShell); открыта — ?request=<id> в адресе;
// логист — ссылка на его заявки; тексты без технических полей.

import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertTriangle } from 'lucide-react';
import { SidePanelShell } from '@/features/reports/ui/SidePanelShell';
import { DASH, fmtDate, fmtDateTime, fmtInt, fmtPct, fmtRub, humanName } from './format';

interface Card {
  head: Record<string, string | number | boolean | null>;
  lines: { line_number: number; nomenclature: string | null; characteristic: string | null; quantity: string | null; unit: string | null; price: string | null; amount: string | null; vat_amount: string | null }[];
  purchases: { id: string; number: string; doc_date: string | null; posted: boolean; operation: string | null; include_vat: boolean; amount: string | null; amount_vat: string | null; integrity_ok: boolean | null; supplier: string | null; creator: string | null; lines_n: string }[];
  history: { changed_at: string; old_status: string | null; new_status: string }[];
  money: { salesNv: number; purchNv: number; broken: boolean; marginNv: number | null };
}

const n = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const th = 'border-b border-[var(--color-border)] bg-[var(--color-table-header)] px-2 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] whitespace-nowrap';
const td = 'border-b border-[var(--color-border)] px-2 py-1.5 align-top';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className="text-sm text-[var(--color-text)] break-words">{value ?? DASH}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h3>
      {children}
    </section>
  );
}

export function RequestCardPanel({ id, onClose, onPickLogist }: { id: string; onClose: () => void; onPickLogist?: (logistId: string) => void }) {
  const q = useQuery<Card>({
    queryKey: ['realizations', 'card', id],
    queryFn: async () => {
      const res = await fetch(`/api/realizations/requests/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`);
      return body;
    },
  });
  const h = q.data?.head;
  const m = q.data?.money;
  const time = h?.shipment_time_start ? `${String(h.shipment_time_start).slice(0, 5)}–${String(h.shipment_time_end ?? '').slice(0, 5)}` : null;

  return (
    <SidePanelShell ariaLabel="Карточка заявки" onClose={onClose}
      title={h ? `Заявка ${h.number}` : 'Заявка'}
      subtitle={h ? <>Реализация · Заявки · {String(h.status)}</> : 'Реализация · Заявки'}>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-4">
      {q.isLoading && <div className="flex items-center gap-2 py-8 justify-center text-sm text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" />Загружаем карточку…</div>}
      {q.error && <div className="rounded-lg border border-[var(--color-negative)]/40 bg-[var(--color-negative)]/10 px-3 py-2 text-sm text-[var(--color-negative)]">{(q.error as Error).message}</div>}
      {q.data && h && m && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Статус" value={String(h.status)} />
            <Field label="Дата заявки" value={fmtDate(h.doc_date as string)} />
            <Field label="Плановая отгрузка" value={`${fmtDate(h.shipment_date as string)}${time ? `, ${time}` : ''}`} />
            <Field label="Покупатель" value={humanName(h.buyer as string) ?? 'Без покупателя'} />
            <Field label="Менеджер" value={humanName(h.manager as string)} />
            <Field label="Логист" value={h.logist_id && onPickLogist ? (
              <button type="button" onClick={() => onPickLogist(String(h.logist_id))} title="Все заявки логиста"
                className="focus-ring rounded-sm text-left font-medium text-[var(--brand)] hover:underline">{String(h.logist)}</button>
            ) : humanName(h.logist as string)} />
            <Field label="Организация" value={h.organization as string} />
            <Field label="Оплата" value={[h.payment_form, h.payment_method].filter(Boolean).join(' · ') || DASH} />
            <Field label="Сумма заявки (с НДС)" value={fmtRub(n(h.amount))} />
            <div className="sm:col-span-3"><Field label="Адрес" value={h.address as string} /></div>
            {(h.comment || h.shipment_comment) && <div className="sm:col-span-3"><Field label="Комментарий" value={[h.comment, h.shipment_comment].filter(Boolean).join(' · ')} /></div>}
            {(h.cancel_reason || h.not_shipped_comment) && <div className="sm:col-span-3"><Field label="Причина отмены / недогруза" value={[h.cancel_reason, h.not_shipped_comment].filter(Boolean).join(' · ')} /></div>}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Продажа, без НДС', fmtRub(m.salesNv)],
              ['Закупка, без НДС', q.data.purchases.length ? fmtRub(m.purchNv) : DASH],
              ['Маржа', m.marginNv === null ? (m.broken ? 'не считается: закупка задвоена' : 'нет закупки') : fmtRub(m.marginNv)],
              ['Маржа, %', m.marginNv === null || !m.salesNv ? DASH : fmtPct((100 * m.marginNv) / m.salesNv)],
            ].map(([l, v]) => (
              <div key={l} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                <div className="text-xs text-[var(--color-text-muted)]">{l}</div>
                <div className="text-sm font-semibold tabular-nums text-[var(--color-text)]">{v}</div>
              </div>
            ))}
          </div>
          {m.broken && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--warning-text)]/30 bg-[var(--warning-bg)] px-3 py-2 text-[13px] text-[var(--color-text)]">
              <AlertTriangle size={16} className="mt-px shrink-0 text-[var(--warning-text)]" />
              Сумма закупки задвоена в 1С — заявка не входит в расчёт маржи.
            </div>
          )}
          <p className="-mt-2 text-xs text-[var(--color-text-muted)]">Маржа без НДС, предварительно — методика ещё не согласована.</p>

          <Section title={`Состав · ${fmtInt(q.data.lines.length)}`}>
            {q.data.lines.length === 0 ? <div className="text-xs text-[var(--color-text-muted)]">Строк нет</div> : (
              <div className="scroll-x rounded-lg border border-[var(--color-border)]">
                <table className="w-full border-collapse text-xs text-[var(--color-text)]">
                  <thead><tr>
                    <th className={`${th} text-left`}>№</th><th className={`${th} text-left`}>Номенклатура</th>
                    <th className={`${th} text-right`}>Кол-во</th><th className={`${th} text-right`}>Цена</th>
                    <th className={`${th} text-right`}>Сумма</th><th className={`${th} text-right`}>НДС</th>
                  </tr></thead>
                  <tbody>{q.data.lines.map(l => (
                    <tr key={l.line_number}>
                      <td className={td}>{l.line_number}</td>
                      <td className={`${td} min-w-[200px]`}>{l.nomenclature ?? DASH}{l.characteristic ? <span className="text-[var(--color-text-muted)]"> · {l.characteristic}</span> : null}</td>
                      <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtInt(n(l.quantity))} {l.unit ?? ''}</td>
                      <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtRub(n(l.price))}</td>
                      <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtRub(n(l.amount))}</td>
                      <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtRub(n(l.vat_amount))}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`Приобретения · ${fmtInt(q.data.purchases.length)}`}>
            {q.data.purchases.length === 0 ? <div className="text-xs text-[var(--color-text-muted)]">Приобретений нет — себестоимости в базе нет</div> : (
              <div className="scroll-x rounded-lg border border-[var(--color-border)]">
                <table className="w-full border-collapse text-xs text-[var(--color-text)]">
                  <thead><tr>
                    <th className={`${th} text-left`}>Номер</th><th className={`${th} text-left`}>Дата</th>
                    <th className={`${th} text-left`}>Поставщик</th><th className={`${th} text-left`}>Операция</th>
                    <th className={`${th} text-right`}>Сумма</th><th className={`${th} text-right`}>Без НДС</th>
                    <th className={`${th} text-left`}>Отметки</th>
                  </tr></thead>
                  <tbody>{q.data.purchases.map(p => {
                    const nv = (n(p.amount) ?? 0) - (p.include_vat ? n(p.amount_vat) ?? 0 : 0);
                    return (
                      <tr key={p.id} className={p.integrity_ok === false ? 'bg-[var(--warning-bg)]' : ''}>
                        <td className={`${td} whitespace-nowrap`}>{p.number}</td>
                        <td className={`${td} whitespace-nowrap`}>{fmtDate(p.doc_date)}</td>
                        <td className={`${td} min-w-[160px]`}>{humanName(p.supplier) ?? DASH}</td>
                        <td className={td}>{p.operation ?? DASH}</td>
                        <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtRub(n(p.amount))}</td>
                        <td className={`${td} text-right tabular-nums whitespace-nowrap`}>{fmtRub(nv)}</td>
                        <td className={`${td} whitespace-nowrap`}>
                          {p.integrity_ok === false && <span className="mr-1 inline-flex items-center gap-1 font-medium text-[var(--warning-text)]"><AlertTriangle size={12} />сумма задвоена — не в марже</span>}
                          {!p.posted && <span className="text-[var(--color-text-muted)]">не проведено</span>}
                          {p.integrity_ok !== false && p.posted && DASH}
                        </td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title={`История статусов · ${fmtInt(q.data.history.length)}`}>
            {q.data.history.length === 0 ? <div className="text-xs text-[var(--color-text-muted)]">Истории нет — история статусов ведётся с 08.06.2026</div> : (
              <ol className="flex flex-col">
                {q.data.history.map((e, i) => (
                  <li key={i} className="flex items-baseline gap-3 border-l-2 border-[var(--color-border)] py-1 pl-3">
                    <span className="w-[98px] shrink-0 text-xs tabular-nums text-[var(--color-text-muted)]">{fmtDateTime(e.changed_at)}</span>
                    <span className="min-w-0 text-xs text-[var(--color-text)]">
                      {e.old_status && <span className="text-[var(--color-text-muted)]">{e.old_status} → </span>}
                      <span className="font-medium">{e.new_status}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      )}
      </div>
    </SidePanelShell>
  );
}
