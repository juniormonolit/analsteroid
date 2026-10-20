'use client';
// Вкладки единой «Карточки клиента» (20.10), перенесённые из карточки «Моих заказчиков»:
// «Покупки» (путь клиента по отгрузкам), «Звонки» (лента по всем сделкам клиента) и блок
// «Кто вёл заказчика». Данные — /api/modules/client-card/history: тот же доступ, что у
// модуля, поэтому работает и в приложении, и во вкладке Битрикса. Отметок «Отложить/
// Не звонить/Связался» нет намеренно: «Мои заказчики» упраздняются, весь движ — через
// сделки и задачи (владелец 20.10).
import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone, PhoneMissed } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { fmtMoney } from '@/features/customers/ui/shared';
import type { ClientHistory } from '../engine/history';
import { DealLink } from './dealLink';
import { fmtD } from './parts';

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
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {hint && <div className="text-[11.5px] text-[var(--color-text-muted)]">{hint}</div>}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2" title={hint}>
      <div className="text-[12px] text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 text-[16px] font-bold tabular-nums">{value}</div>
    </div>
  );
}

const fmtGap = (d: number) => (d < 1 ? 'в тот же день' : d < 60 ? `через ${Math.round(d)} дн.` : `через ${(d / 30.44).toFixed(1)} мес.`);
const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });

export function PurchasesTab({ qs }: { qs: string }) {
  const { data, isLoading, error } = useClientHistory(qs);
  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Собираем путь клиента…</div>;
  if (error || !data) return <div className="text-sm text-[var(--color-negative)]">{error instanceof Error ? error.message : 'Ошибка'}</div>;
  const ps = data.purchases;
  if (!ps.length) return <div className="text-sm text-[var(--color-text-muted)]">Отгрузок ещё не было — путь начнётся с первой покупки.</div>;

  const first = ps[0];
  const last = ps[ps.length - 1];
  const ltv = ps.reduce((s, p) => s + p.amount, 0);
  const firstMs = new Date(first.deliveredAt).getTime();
  const lastMs = new Date(last.deliveredAt).getTime();
  const freq = ps.length >= 2 ? (lastMs - firstMs) / DAY_MS / (ps.length - 1) : null;
  const since = (Date.now() - lastMs) / DAY_MS;
  const churn = freq && freq > 0 ? Math.round((since / freq) * 100) : null;
  const groups = new Set(ps.flatMap(p => p.groups.map(g => g.name ?? 'Без группы'))).size;

  return (
    <div className="flex flex-col gap-4">
      <Block title="Как зашёл" hint="Категория КЦ первой сделки — по чему пришёл; группы по позициям — что реально продали">
        <div className="flex flex-col gap-0.5 text-[12.5px]">
          <div>Зашёл по КЦ: <b>{first.kcCategory ?? '—'}</b></div>
          <div>Продали: <b>{first.groups.map(g => g.name ?? 'Без группы').join(', ') || first.headGroup || '—'}</b></div>
        </div>
      </Block>

      <Block title="Показатели клиента" hint="По цепочке отгрузок ниже">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
          <Tile label="Покупок" value={String(ps.length)} />
          <Tile label="Категорий куплено" value={String(groups)} />
          <Tile label="Частота заказов" value={freq ? `${Math.round(freq)} дн.` : '—'} hint="Средний интервал между отгрузками" />
          <Tile label="Дней с последней" value={String(Math.round(since))} />
          <Tile label="Время жизни" value={(lastMs - firstMs) / DAY_MS / 30.44 >= 1 ? `${((lastMs - firstMs) / DAY_MS / 30.44).toFixed(1)} мес.` : '< месяца'} />
          <Tile label="Риск ухода" value={churn !== null ? `${churn}%` : '—'} hint="Дней с последней ÷ частота × 100: больше 100% — пора звонить" />
          <Tile label="LTV" value={fmtMoney(ltv)} />
        </div>
      </Block>

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
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-text-muted)]">{fmtD(p.deliveredAt)}</span>
                    <DealLink dealId={p.dealId} className="shrink-0 font-mono text-[11px] text-[var(--color-accent)] hover:underline">#{p.dealId}</DealLink>
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

export function CallsTab({ qs }: { qs: string }) {
  const { data, isLoading, error } = useClientHistory(qs);
  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загружаем звонки…</div>;
  if (error || !data) return <div className="text-sm text-[var(--color-negative)]">{error instanceof Error ? error.message : 'Ошибка'}</div>;
  if (!data.calls.length) return <div className="text-sm text-[var(--color-text-muted)]">Звонков по сделкам клиента не было.</div>;
  return (
    <Block title={`Звонки · ${data.callsTotal}`} hint={`По всем сделкам клиента, свежие сверху. Успешных (дольше 20 с) — ${data.goodCallsTotal}.${data.callsTotal > data.calls.length ? ` Показаны последние ${data.calls.length}.` : ''}`}>
      <div className="flex flex-col divide-y divide-[var(--color-border)]">
        {data.calls.map((c, i) => {
          const good = !c.missed && c.durationSec > 20;
          return (
            <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-[12.5px]">
              <span className="w-[110px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDT(c.calledAt)}</span>
              <span className={good ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)]'}>{c.missed ? <PhoneMissed size={13} /> : <Phone size={13} />}</span>
              <span className="min-w-0 flex-1">
                {c.direction === 'inbound' ? 'Входящий' : 'Исходящий'} · {c.missed ? 'без ответа' : `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}`}
                {!c.missed && !good && <span className="text-[var(--color-text-muted)]"> · короче 20 с</span>}
                {c.dealId && <> · <DealLink dealId={c.dealId} className="text-[var(--color-accent)] hover:underline">#{c.dealId}</DealLink></>}
              </span>
              {c.managerName && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{c.managerName}</span>}
            </div>
          );
        })}
      </div>
    </Block>
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
