'use client';
// Вкладки единой «Карточки клиента» (20.10), перенесённые из карточки «Моих заказчиков»:
// «Покупки» (путь клиента по отгрузкам), «Звонки» (лента по всем сделкам клиента) и блок
// «Кто вёл заказчика». Данные — /api/modules/client-card/history: тот же доступ, что у
// модуля, поэтому работает и в приложении, и во вкладке Битрикса. Отметок «Отложить/
// Не звонить/Связался» нет намеренно: «Мои заказчики» упраздняются, весь движ — через
// сделки и задачи (владелец 20.10).
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, PhoneMissed } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { fmtMoney } from '@/features/customers/ui/shared';
import type { ClientHistory } from '../engine/history';
import { type ClientModuleData, computeStats } from '../engine/types';
import { callTiming } from '../engine/callTiming';
import { TzMetrics } from './TzBlocks';
import { DealLink } from './dealLink';
import { fmtD, TabError, TabLoading } from './parts';

const DAY_MS = 86_400_000;

export function useClientHistory(qs: string, enabled = true) {
  return useQuery<ClientHistory>({
    queryKey: ['client-module-history', qs],
    enabled: enabled && qs.length > 0,
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card/history?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка загрузки');
      return j;
    },
    staleTime: 5 * 60_000,
  });
}

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h3>
        {hint && <div className="text-[11.5px] text-[var(--color-text-muted)]">{hint}</div>}
      </div>
      {children}
    </section>
  );
}


const fmtGap = (d: number) => (d < 1 ? 'в тот же день' : d < 60 ? `через ${Math.round(d)} дн.` : `через ${(d / 30.44).toFixed(1)} мес.`);
const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

export function PurchasesTab({ qs, card }: { qs: string; card: ClientModuleData }) {
  const { data, isLoading, error, refetch } = useClientHistory(qs);
  if (isLoading) return <TabLoading text="Собираем путь клиента…" />;
  if (error || !data) return <TabError error={error} onRetry={() => void refetch()} />;
  const ps = data.purchases;
  if (!ps.length) return <div className="text-sm text-[var(--color-text-muted)]">Отгрузок ещё не было — путь начнётся с первой покупки.</div>;

  const first = ps[0];
  const last = ps[ps.length - 1];
  const firstMs = new Date(first.deliveredAt).getTime();
  const lastMs = new Date(last.deliveredAt).getTime();
  const groups = new Set(ps.flatMap(p => p.groups.map(g => g.name ?? 'Без группы'))).size;
  // Те же показатели, что на «Обзоре» (аудит 23.10: здесь был средний интервал 37 дн., там медиана 23 — «два цикла»).
  const timing = callTiming(card.deals);
  const churn = timing && timing.cycle > 0 ? Math.round((timing.since / timing.cycle) * 100) : null;
  const lifeMonths = (lastMs - firstMs) / DAY_MS / 30.44;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-[12.5px] text-[var(--color-text-muted)]" title="Категория КЦ первой сделки — по чему пришёл; группы по позициям — что реально продали">
        Зашёл по КЦ: <b className="text-[var(--color-text)]">{first.kcCategory ?? '—'}</b>
        {' → '}продали <b className="text-[var(--color-text)]">{first.groups.map(g => g.name ?? 'Без группы').join(', ') || first.headGroup || '—'}</b>
      </div>

      <TzMetrics s={computeStats(card.deals)} deals={card.deals} />
      <div className="text-[12.5px] text-[var(--color-text-muted)]">
        Категорий куплено: <b className="text-[var(--color-text)]">{groups}</b>
        {' · '}клиент {lifeMonths >= 1 ? <b className="text-[var(--color-text)]">{lifeMonths.toFixed(1).replace('.', ',')} мес.</b> : 'меньше месяца'}
        {churn !== null && <> · риск ухода <b style={{ color: churn > 150 ? 'var(--color-negative,#e03131)' : churn > 100 ? 'var(--color-warning,#e8590c)' : 'var(--color-text)' }}>{churn}%</b> <span title="Дней с последней покупки ÷ обычный цикл (медиана) × 100: больше 100% — пора звонить">(дней с последней ÷ цикл)</span></>}
      </div>

      <Block title={`Цепочка покупок · ${ps.length}`} hint="Каждая отгрузка со всеми товарными группами и суммами по позициям; между покупками — прошедшее время">
        <div className="flex flex-col">
          {ps.map((p, i) => {
            const gap = i === 0 ? null : (new Date(p.deliveredAt).getTime() - new Date(ps[i - 1].deliveredAt).getTime()) / DAY_MS;
            return (
              <Fragment key={p.dealId}>
                {gap !== null && (
                  <div className="flex items-center gap-2 py-0.5 pl-[7px]">
                    <span className="block h-4 w-px bg-[var(--color-border-strong)]" />
                    <span className="text-[11px] text-[var(--color-text-muted)]">{fmtGap(gap)}</span>
                  </div>
                )}
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[12px] font-semibold tabular-nums">{fmtD(p.deliveredAt)}</span>
                    <DealLink dealId={p.dealId} className="min-w-0 truncate text-[12px] text-[var(--color-accent)] hover:underline">{p.dealName ?? `Сделка #${p.dealId}`}</DealLink>
                    {i === 0 && p.kcCategory && <span className="shrink-0 rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-accent)]">КЦ: {p.kcCategory}</span>}
                    <span className="flex-1" />
                    <span className="whitespace-nowrap text-[12.5px] font-bold tabular-nums">{fmtMoney(p.amount)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.groups.length === 0 ? <span className="text-[11px] text-[var(--color-text-muted)]">{p.headGroup ?? 'Без товарных строк'}</span>
                      : p.groups.map(g => (
                        <span key={g.name ?? '—'} className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px]">
                          {g.name ?? 'Без группы'} <b className="tabular-nums text-[var(--color-text-muted)]">{fmtMoney(g.sum)}</b>
                        </span>
                      ))}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      </Block>
    </div>
  );
}

type CallFilter = 'all' | 'talk' | 'missed' | 'inbound';
const CALL_FILTERS: { key: CallFilter; label: string }[] = [
  { key: 'all', label: 'Все' }, { key: 'talk', label: 'Разговоры' }, { key: 'missed', label: 'Без ответа' }, { key: 'inbound', label: 'Входящие' },
];
const PAGE = 100;
const monthTitle = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });

/** Звонки (аудит 23.10): фильтры, группировка по месяцам, «показать ещё»; менеджер — только при смене. */
export function CallsTab({ qs }: { qs: string }) {
  const { data, isLoading, error, refetch } = useClientHistory(qs);
  const [f, setF] = useState<CallFilter>('all');
  const [limit, setLimit] = useState(PAGE);
  if (isLoading) return <TabLoading text="Загружаем звонки…" />;
  if (error || !data) return <TabError error={error} onRetry={() => void refetch()} />;
  if (!data.calls.length) return <div className="py-6 text-center text-sm text-[var(--color-text-muted)]">Звонков по сделкам клиента не было.</div>;
  const good = (c: ClientHistory['calls'][number]) => !c.missed && c.durationSec > 20;
  const pass = (c: ClientHistory['calls'][number]) => f === 'all' || (f === 'talk' ? good(c) : f === 'missed' ? c.missed : c.direction === 'inbound');
  const list = data.calls.filter(pass);
  const shown = list.slice(0, limit);
  const last = data.calls[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2">
        {[['Всего звонков', String(data.callsTotal)], ['Разговоров > 20 с', String(data.goodCallsTotal)], ['Последний', last ? fmtD(last.calledAt) : '—']].map(([l, v]) => (
          <div key={l} className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
            <div className="text-[12px] text-[var(--color-text-muted)]">{l}</div>
            <div className="mt-0.5 text-[18px] font-bold tabular-nums">{v}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Какие звонки">
        {CALL_FILTERS.map(x => (
          <button key={x.key} type="button" aria-pressed={f === x.key} onClick={() => { setF(x.key); setLimit(PAGE); }}
            className={`min-h-11 rounded-lg border px-3 text-[12.5px] ${f === x.key ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {x.label} <span className="tabular-nums opacity-70">{data.calls.filter(c => x.key === 'all' || (x.key === 'talk' ? good(c) : x.key === 'missed' ? c.missed : c.direction === 'inbound')).length}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-col">
        {shown.map((c, i) => {
          const m = monthTitle(c.calledAt);
          const newMonth = i === 0 || monthTitle(shown[i - 1].calledAt) !== m;
          const mgrChanged = i === 0 || newMonth || shown[i - 1].managerName !== c.managerName;
          return (
            <Fragment key={`${c.calledAt}-${i}`}>
              {newMonth && <div className="mt-2 border-b border-[var(--color-border)] pb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] first:mt-0">{m}</div>}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-[var(--color-border)] py-1.5 text-[12.5px] last:border-0">
                <span className="w-[110px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDT(c.calledAt)}</span>
                <span className={good(c) ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)]'}>{c.missed ? <PhoneMissed size={13} /> : <Phone size={13} />}</span>
                <span className="min-w-0 flex-1">
                  {c.direction === 'inbound' ? 'Входящий' : 'Исходящий'} · {c.missed ? 'без ответа' : `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}`}
                  {!c.missed && !good(c) && <span className="text-[var(--color-text-muted)]"> · короче 20 с</span>}
                  {c.dealId && <> · <DealLink dealId={c.dealId} className="text-[var(--color-accent)] hover:underline">сделка #{c.dealId}</DealLink></>}
                </span>
                {c.managerName && mgrChanged && <span className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{c.managerName}</span>}
              </div>
            </Fragment>
          );
        })}
      </div>
      {list.length > shown.length && (
        <button type="button" onClick={() => setLimit(l => l + PAGE)} className="min-h-11 self-start rounded-lg border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
          Показать ещё · {Math.min(PAGE, list.length - shown.length)} из {list.length - shown.length}
        </button>
      )}
      {data.callsTotal > data.calls.length && limit >= list.length && <div className="text-[11.5px] text-[var(--color-text-muted)]">Показаны последние {data.calls.length} из {data.callsTotal} звонков.</div>}
    </div>
  );
}

export function ManagersBlock({ qs }: { qs: string }) {
  const { data } = useClientHistory(qs);
  if (!data || data.managers.length === 0) return null;
  return (
    <Block title="Кто вёл заказчика" hint="Имена — на момент работы с клиентом, свежие слева">
      <div className="flex flex-wrap gap-2 text-[12.5px]">
        {data.managers.map(m => (
          <span key={m.managerId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1">
            <b>{m.name ?? `Менеджер #${m.managerId}`}</b>
            <span className="text-[var(--color-text-muted)]"> · сделок {m.deals}, продано {m.sold} · {fmtD(m.firstAt)}{m.firstAt.slice(0, 10) !== m.lastAt.slice(0, 10) ? ` — ${fmtD(m.lastAt)}` : ''}</span>
          </span>
        ))}
      </div>
    </Block>
  );
}
