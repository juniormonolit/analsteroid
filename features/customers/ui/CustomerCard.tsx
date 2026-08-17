'use client';
// Карточка клиента (фича Серёги 01.08): широкий drawer поверх «Моих заказчиков»
// (паттерн DrilldownDrawer — панель справа с подложкой). Шапка/активные сделки/
// рекомендации приходят из уже посчитанной строки списка (ApiRow), остальное
// (таймлайн покупок, звонки, отказы, история отметок) — /api/customers/card.
// ПДн: телефонов нет by construction — звонить менеджер идёт в Битрикс по ссылке.

import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import dynamic from 'next/dynamic';
import { X, ExternalLink } from 'lucide-react';

// DealCard — динамически: карточки ссылаются друг на друга (сделка → заказчик →
// сделка, задача 17.08), статический импорт в обе стороны дал бы цикл модулей.
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });
import type { CustomerCardData } from '@/features/customers/engine/card';
import {
  type ApiRow, REASON_LABELS, fmtMoney, fmtDate, daysAgo,
  clientBitrixUrl, dealBitrixUrl, clientDisplayName,
  CATEGORY_LABELS, CATEGORY_STYLE, MODIFIER_LABELS,
} from './shared';

const DAY_MS = 86_400_000;

function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'neg' | 'warn' | 'ok'; title?: string }) {
  const style = tone === 'neg'
    ? { color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' }
    : tone === 'warn'
      ? { color: 'var(--color-warning, #e8590c)', backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 10%, transparent)' }
      : tone === 'ok'
        ? { color: 'var(--color-positive, #2f9e44)', backgroundColor: 'color-mix(in srgb, var(--color-positive, #2f9e44) 10%, transparent)' }
        : { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' };
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-semibold" style={style} title={title}>
      {children}
    </span>
  );
}

// Полиш 01.08 (правка владельца через Серёгу «наведи порядок»): секции — карточки
// с фоном/отступами (та же оболочка, что везде в ЛК — ManagerTabs.tsx), а не голый
// капс-заголовок + текст встык с предыдущим блоком. hintIcon — маленькая «ⓘ» с
// тултипом вместо приписки текстом в заголовке (пример: «цикл повторки… (по базе)»).
function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        {title}
        {hint && <span title={hint} className="cursor-help normal-case tracking-normal opacity-70">ⓘ</span>}
      </div>
      {children}
    </section>
  );
}

// Плашка ключевой цифры шапки (сетка 2×2/4, вместо строки-простыни «покупок N из
// M сделок на сумму… средний чек…»): крупное число, мелкая серая подпись.
function StatTile({ label, value, sub, hint }: { label: string; value: React.ReactNode; sub?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5" title={hint}>
      <div className="text-[10px] leading-tight text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[14px] font-bold leading-tight text-[var(--color-text)] tabular-nums whitespace-nowrap">{value}</div>
      {sub && <div className="text-[10px] leading-tight text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  snooze: '⏸ Отложен', no_call: '🚫 Не звонить', wake: '⏰ Возвращён из спящих', clear: '↩ Отметка снята',
};

export function CustomerCard({ row, managerId, isSelf, onClose, markControls, zIndex }: {
  row: ApiRow;
  managerId: string;
  isSelf: boolean;
  onClose: () => void;
  /** Кнопки «Отложить»/«Не звонить»/«Вернуть» — те же контролы, что в списке. */
  markControls: React.ReactNode;
  /** Поверх чего открылись: из карточки сделки (z-70) нужен z выше её дефолтных 50. */
  zIndex?: number;
}) {
  const [openDealId, setOpenDealId] = useState<number | null>(null);

  // «Сделки» клиента (задача 17.08: из карточки заказчика — в карточку сделки).
  // Окно широкое (вся история): раздел про навигацию, не про период отчёта.
  // Юрлицо (clientKey k<id>) фильтруется по company_id, остальное — по contact_id
  // (ключ x<id> — юр.сделка без карточки компании, клиент определён по контакту).
  const dealsQs = new URLSearchParams({
    from: '2015-01-01T00:00:00.000Z',
    to: new Date().toISOString(),
    scope: 'all',
    ...(row.clientKey.startsWith('k') ? { companyId: String(row.clientId) } : { contactId: String(row.clientId) }),
  }).toString();
  const { data: dealsData } = useQuery<{ deals: { deal_id: number; deal_name: string | null; amount: number | string | null; created_at: string | null; stage_name: string | null }[]; total_count: number }>({
    queryKey: ['customer-deals', row.clientKey],
    queryFn: () => fetch(`/api/reports/deals?${dealsQs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const clientDeals = dealsData?.deals ?? [];
  const { data, isLoading, isError } = useQuery<CustomerCardData>({
    queryKey: ['customer-card', row.clientKey, isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = new URLSearchParams({ clientKey: row.clientKey });
      if (!isSelf) qs.set('bitrixId', managerId);
      const res = await fetch(`/api/customers/card?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const status = row.mark?.kind === 'no_call' ? { label: '🚫 отказался', tone: 'neg' as const }
    : row.bucket === 'sleeping' ? { label: '💤 спящий', tone: 'muted' as const }
    : row.section === 'regular' ? { label: row.atRisk ? '⚠ постоянник под угрозой' : '★ постоянник', tone: row.atRisk ? 'neg' as const : 'ok' as const }
    : row.section === 'once' ? { label: 'купил один раз', tone: 'muted' as const }
    : { label: 'ещё не купил', tone: 'muted' as const };

  const avgCheck = row.dealsSold > 0 ? Math.round(row.sumSold / row.dealsSold) : null;
  const currentManager = row.managerHistory.find(m => String(m.managerId) === managerId)
    ?? row.managerHistory[0] ?? null;

  // Интервалы между покупками — по таймлайну (видно ритм клиента).
  const timeline = data?.timeline ?? [];
  const gaps: (number | null)[] = timeline.map((d, i) =>
    i === 0 ? null : Math.round((new Date(d.soldAt).getTime() - new Date(timeline[i - 1].soldAt).getTime()) / DAY_MS));

  return (
    <div className="fixed inset-0 z-50 flex" style={zIndex ? { zIndex } : undefined}>
      <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40 cursor-pointer" onClick={onClose} />
      <div className="w-full sm:w-[720px] sm:max-w-[85vw] shrink-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden">
        {/* Шапка — полиш 01.08 (правка владельца через Серёгу): имя+статусные чипы в
            ОДНУ строку в логичном порядке (тип → категория → модификаторы →
            статус → Битрикс), менеджер отдельной строкой, метрики покупок —
            сеткой плашек вместо строки-простыни. */}
        <div className="px-4 sm:px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h2 className="text-base font-bold text-[var(--color-text)] truncate max-w-[320px]" title={clientDisplayName(row)}>
                  {clientDisplayName(row)}
                </h2>
                <Chip title={row.clientKey.startsWith('x')
                  ? 'Юр.сделка без карточки компании в CRM — клиент определён по контакту-представителю (задача 2776, фикс «k0»)'
                  : undefined}>{row.clientType === 'contact' ? 'физ' : 'юр'}</Chip>
                {row.category && row.category !== 'none' && (
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-[12px] font-bold"
                    style={{ color: CATEGORY_STYLE[row.category].color, backgroundColor: CATEGORY_STYLE[row.category].bg }}
                    title={`Отгрузок ${row.dealsDelivered} на ${fmtMoney(row.sumDelivered)}, разных групп: ${row.distinctGroups}. Пороги — Настройки → Категории клиентов`}>
                    {row.category === 'key' && '🔑 '}{CATEGORY_LABELS[row.category]}
                  </span>
                )}
                {(row.modifiers ?? []).map(mod => (
                  <Chip key={mod} title={MODIFIER_LABELS[mod].hint}>{MODIFIER_LABELS[mod].icon} {MODIFIER_LABELS[mod].label}</Chip>
                ))}
                <Chip tone={status.tone}>{status.label}</Chip>
                {row.snoozedActive && row.mark && (
                  <Chip title={`Отметил(а): ${row.mark.createdBy}, ${fmtDate(row.mark.createdAt)}`}>⏸ до {fmtDate(row.mark.snoozeUntil)}</Chip>
                )}
                {row.refusedNoCall && <Chip tone="neg" title="У клиента есть сделка, закрытая в отказ без единого звонка">🚫 отказ без звонка</Chip>}
                <a href={clientBitrixUrl(row)} target="_blank" rel="noreferrer"
                  className="ml-auto inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] hover:underline whitespace-nowrap">
                  <ExternalLink size={12} /> Битрикс
                </a>
              </div>
              <div className="mt-1 text-[12px] text-[var(--color-text-muted)] truncate">
                Менеджер: <b className="text-[var(--color-text)]">{currentManager?.name ?? `#${managerId}`}</b>
                {row.prevManagerNames.length > 0 && (
                  <span title={`Ранее вёл(а): ${row.prevManagerNames.join(', ')}`}> · ранее: {row.prevManagerNames.join(', ')}</span>
                )}
              </div>
              <div className="mt-2 grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                <StatTile label="Покупок" value={`${row.dealsSold} из ${row.dealsTotal}`} />
                <StatTile label="Сумма покупок" value={row.sumSold > 0 ? fmtMoney(row.sumSold) : '—'} />
                <StatTile label="Средний чек" value={avgCheck !== null && avgCheck > 0 ? fmtMoney(avgCheck) : '—'} />
                <StatTile label="Цикл повторки" value={`${row.cycleDays} дн.`}
                  hint={row.cycleSource === 'own' ? 'Медиана интервалов между его покупками' : 'По базе — своих покупок у клиента мало, взята медиана по всей базе (16 дн.)'} />
                <StatTile label="Отгружено" value={row.dealsDelivered > 0 ? `${row.dealsDelivered} / ${fmtMoney(row.sumDelivered)}` : '—'}
                  hint="Отгрузки (delivered) — база категорий «Ключевой»/«Крупный»" />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {markControls}
              <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]" title="Закрыть">
                <X size={16} />
              </button>
            </div>
          </div>
        </div>

        {/* Тело */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 flex flex-col gap-5">
          {isError && <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить карточку клиента.</div>}

          {/* Активные сделки — из строки списка. Пустая секция целиком не рендерим
              (правка владельца 01.08) — сводится в одну строку ниже вместе с
              «Отказов не было», если и то, и другое пусто. */}
          {row.activeDeals.length > 0 && (
            <Section title={`Активные сделки · ${row.activeDeals.length}`}>
              <div className="scroll-x">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {row.activeDeals.map(d => {
                    const daysInWork = Math.floor((Date.now() - new Date(d.createdAt).getTime()) / DAY_MS);
                    return (
                      <tr key={d.dealId} className="border-t border-[var(--color-border)] first:border-t-0">
                        <td className="py-1 pr-3 whitespace-nowrap">
                          <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline font-semibold">#{d.dealId}</a>
                        </td>
                        <td className="py-1 pr-3 max-w-[200px] truncate text-[var(--color-text-muted)]" title={d.name ?? undefined}>{d.name ?? '—'}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{d.stage ?? '?'}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{d.amount !== null && d.amount > 0 ? fmtMoney(d.amount) : '—'}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]">{daysInWork} дн. в работе</td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap font-semibold"
                          style={d.daysSilent > 7 ? { color: 'var(--color-negative, #e03131)' } : { color: 'var(--color-text-muted)' }}>
                          🔇 {Math.floor(d.daysSilent)} дн. без звонка
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </Section>
          )}

          {/* Таймлайн покупок — сведён в строку-таблицу (дата · #сделка · группа ·
              сумма), интервал между покупками — компактная серая метка МЕЖДУ
              строками таблицы (не отдельная болтающаяся строка-текст). */}
          <Section title={`Покупки · ${timeline.length}`} hint="Все проданные сделки клиента хронологически; между покупками — интервал в днях">
            {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загружаем…</div>
              : timeline.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">Покупок ещё не было.</div> : (
              <div className="scroll-x">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {timeline.map((d, i) => (
                    <Fragment key={d.dealId}>
                      {gaps[i] !== null && (
                        <tr>
                          <td colSpan={4} className="pt-0.5 pb-1">
                            <span className="inline-flex items-center rounded bg-[var(--color-bg-hover)] px-1.5 py-px text-[10px] font-semibold text-[var(--color-text-muted)]">
                              ↓ {gaps[i]} дн.
                            </span>
                          </td>
                        </tr>
                      )}
                      <tr className={i > 0 && gaps[i] === null ? 'border-t border-[var(--color-border)]' : ''}>
                        <td className="py-1 pr-3 w-[76px] whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">{fmtDate(d.soldAt)}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">
                          <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">#{d.dealId}</a>
                        </td>
                        <td className="py-1 pr-3 truncate" title={[...d.groups, d.name ?? ''].filter(Boolean).join(' · ')}>
                          {d.groups.length > 0 ? d.groups.join(', ') : (d.name ?? 'без товарных групп')}
                        </td>
                        <td className="py-1 text-right font-semibold tabular-nums whitespace-nowrap">
                          {d.amount !== null && d.amount > 0 ? fmtMoney(d.amount) : '—'}
                        </td>
                      </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </Section>

          {/* Звонки */}
          {/* «Сделки» — ВСЕ сделки клиента за историю, включая непроданные (задача
              17.08: сквозная навигация заказчик → сделка). Не путать с «Покупками»
              выше (там только проданные, из движка карточки) и «Активными» (текущие
              открытые). Клик — карточка сделки прямо поверх этой. */}
          <Section title={`Сделки · ${dealsData?.total_count ?? '…'}`} hint="Все сделки клиента за всю историю; клик открывает карточку сделки">
            {clientDeals.length === 0 ? (
              <div className="text-[12px] text-[var(--color-text-muted)]">Сделок не найдено.</div>
            ) : (
              <div className="flex flex-col">
                {clientDeals.map(d => (
                  <button
                    key={d.deal_id}
                    onClick={() => setOpenDealId(d.deal_id)}
                    className="flex items-center gap-2 py-1 text-left rounded hover:bg-[var(--color-bg-hover)] transition-colors"
                  >
                    <span className="shrink-0 w-[72px] text-[11px] text-[var(--color-text-muted)] tabular-nums">
                      {d.created_at ? format(new Date(d.created_at), 'd MMM yy', { locale: ru }) : '—'}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-[var(--color-accent)]">#{d.deal_id}</span>
                    <span className="flex-1 min-w-0 text-[12px] text-[var(--color-text)] truncate">{d.deal_name ?? '—'}</span>
                    {d.stage_name && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)] truncate max-w-[140px]">{d.stage_name}</span>}
                    <span className="shrink-0 text-[12px] text-[var(--color-text)] tabular-nums whitespace-nowrap">{fmtMoney(Number(d.amount ?? 0))}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section title="Звонки">
            {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загружаем…</div> : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] tabular-nums">
                <span>всего <b>{data?.calls.total ?? 0}</b></span>
                <span>последний: <b>{data?.calls.lastAt ? `${fmtDate(data.calls.lastAt)} (${daysAgo(data.calls.lastAt)})` : '—'}</b></span>
                {(data?.calls.byYear ?? []).map(y => <Chip key={y.year}>{y.year}: {y.count}</Chip>)}
              </div>
            )}
          </Section>

          {/* Что предложить */}
          <Section title="Что предложить" hint="Матрица переходов «купил X → следом покупают Y» по истории продаж">
            {!row.recommend || row.recommend.items.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">—</div> : (
              <div className="flex flex-col gap-1">
                {row.recommend.fallback && <div className="text-[11px] text-[var(--color-text-muted)]">по группе клиента мало статистики — общий топ по базе</div>}
                {row.recommend.items.slice(0, 3).map(it => (
                  <div key={it.group} className="flex items-center gap-2 text-[12.5px]">
                    <span className="font-semibold tabular-nums text-[var(--color-accent)] w-10 shrink-0">{it.pct}%</span>
                    <span className="truncate">{it.group}</span>
                    {it.badge && (
                      <span className="text-[11px] text-[var(--color-text-muted)] truncate" title="Бейдж и MLT за такую допродажу">
                        → {it.badge.icon} «{it.badge.name}»{it.badge.price > 0 && <b className="ml-1 text-[var(--color-positive,#2f9e44)]">+{it.badge.price}</b>}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Отказы — как активные сделки, пустая секция целиком не рендерим. */}
          {!isLoading && (data?.refused.length ?? 0) > 0 && (
            <Section title={`Отказы · ${data!.refused.length}`} hint="Сделки клиента, закрытые в отказ; отмечено, были ли по ним звонки">
              <div className="scroll-x">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {data!.refused.map(d => (
                    <tr key={d.dealId} className="border-t border-[var(--color-border)] first:border-t-0">
                      <td className="py-1 pr-3 whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">{fmtDate(d.lostAt)}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">#{d.dealId}</a>
                      </td>
                      <td className="py-1 pr-3 max-w-[220px] truncate text-[var(--color-text-muted)]" title={d.name ?? undefined}>{d.name ?? '—'}</td>
                      <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap">{d.amount !== null && d.amount > 0 ? fmtMoney(d.amount) : '—'}</td>
                      <td className="py-1 text-right whitespace-nowrap">
                        {d.hasCall ? <span className="text-[11px] text-[var(--color-text-muted)]">звонки были</span>
                          : <Chip tone="neg" title="По сделке нет ни одного звонка в va.calls">без звонка</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Section>
          )}

          {/* Сводка «пусто» (правка владельца 01.08): вместо двух раздутых секций
              «АКТИВНЫЕ СДЕЛКИ · 0 —» и «ОТКАЗЫ · 0 —» — одна тихая строка, и то
              только когда ОБЕ секции пусты (если хоть одна не пуста — молча
              опускаем вторую, above). */}
          {!isLoading && row.activeDeals.length === 0 && (data?.refused.length ?? 0) === 0 && (
            <div className="-mt-2 text-[12px] text-[var(--color-text-muted)]">Активных сделок нет · Отказов не было</div>
          )}

          {/* История менеджеров */}
          {row.managerHistory.length > 0 && (
            <Section title="История менеджеров" hint="Имена — на момент работы с клиентом (на логине люди меняются)">
              <div className="scroll-x">
              <table className="text-[12.5px]">
                <tbody>
                  {row.managerHistory.map(m => (
                    <tr key={m.managerId}>
                      <td className="py-0.5 pr-4 font-semibold">{m.name ?? `Менеджер #${m.managerId}`}</td>
                      <td className="py-0.5 pr-4 tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">сделок {m.deals} / продано <b className="text-[var(--color-text)]">{m.sold}</b></td>
                      <td className="py-0.5 tabular-nums text-[var(--color-text-muted)] whitespace-nowrap">
                        {fmtDate(m.firstAt)}{m.firstAt.slice(0, 10) !== m.lastAt.slice(0, 10) ? ` — ${fmtDate(m.lastAt)}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </Section>
          )}

          {/* История отметок */}
          <Section title="История отметок" hint="Снузы / «не звонить» / возвраты: кто и когда">
            {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загружаем…</div>
              : (data?.markHistory.length ?? 0) === 0 ? <div className="text-[11px] text-[var(--color-text-muted)]">Отметок не было.</div> : (
              <div className="flex flex-col gap-0.5 text-[12.5px]">
                {data!.markHistory.map((h, i) => (
                  <div key={i} className="flex items-baseline gap-2">
                    <span className="w-[76px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDate(h.createdAt)}</span>
                    <span className="font-semibold whitespace-nowrap">{ACTION_LABELS[h.action] ?? h.action}</span>
                    {h.action === 'snooze' && h.snoozeUntil && <span className="text-[var(--color-text-muted)]">до {fmtDate(h.snoozeUntil)}</span>}
                    {h.reason && <span className="text-[var(--color-text-muted)]">{REASON_LABELS[h.reason]}</span>}
                    {h.comment && <span className="text-[var(--color-text-muted)] truncate" title={h.comment}>«{h.comment}»</span>}
                    <span className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)]">{h.createdBy}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>
  );
}
