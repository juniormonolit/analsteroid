'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Box, CalendarDays, ExternalLink, Moon, RotateCcw, ShoppingCart, Sun, Target, Wallet, X } from 'lucide-react';
import type { DashTestManager, DashTestNode, DashTestResponse } from '../engine/build';
import type { DashTestDeal, DashTestDealsResponse } from '../engine/deals';
import { MONTHS_NOM, MONTHS_SHORT, WEEKDAYS_SHORT, isDashPeriod, periodRange, weekdayIndex, type DashPeriod } from '../shared';
import { DatePicker, PeriodView, scopeDeptLabels, shortRange, useDashPeriod, type ScopeTree } from './PeriodView';
import { C, FONT, FONT_FACES, THEME_CSS, readTheme, subscribeTheme, writeTheme, type ThemeName } from './theme';

// «Дашборд тест» — черновик дашборда директора по продажам (задача владельца 08.10).
//
// ОКНО «МЕНЕДЖЕРЫ» (правка владельца 08.10): нажатие на продажи или брони в любой
// карточке (и на плитки «Продажи, шт» / «Брони, шт» в итоге) открывает окно с менеджерами
// этого узла: продажи, брони, план и % плана по каждому. Закрытие — крестик, фон, Esc.
// Нажатие на продажи или брони менеджера в этом окне раскрывает их списком сделок
// (время, воронка, группа, сумма, товары сделки; нажатие на сделку открывает её в Битриксе);
// «← Менеджеры» или Esc возвращают к списку менеджеров.
//
// ПЕРИОД (правка владельца 08.10) — главный переключатель сверху: «Сегодня» (по
// умолчанию; всё, что описано ниже) и «Неделя / Месяц / Год» — другой вид: выбор даты и
// график «Сделки по дням» (./PeriodView.tsx). Вкладки городов общие для всех периодов.
// Период хранится в адресе (?period=week|month|year).
//
// ФИЛЬТР «ДЕПАРТАМЕНТ» (правки владельца 08–09.10) — рядом с фильтром «Филиал», только на
// периодах «Неделя / Месяц / Год» (на «Сегодня» его нет): НЦ, ОС, ЖБИ… Департаменты разных
// филиалов с одним названием — один пункт: «НЦ» при филиале «Все» — это НЦ всех филиалов
// вместе, при выбранном городе — НЦ этого города. Хранится в адресе (?dept=…).
//
// ВКЛАДКИ (правки владельца 08.10): «Все» — итого и блок на каждый город: карточка
// города, под ней колонки отделов, под каждым отделом его команды; дальше по вкладке на
// город — только этот город с отделами и командами. Вкладки городов строятся из данных:
// появится филиал — появится вкладка. Выбранная вкладка хранится в адресе (?tab=…),
// чтобы не слетала при обновлении страницы. (Первая вкладка «Все» — итого, города,
// отделы без команд — убрана по решению владельца; её место заняла бывшая «Подробно».)
//
// ОФОРМЛЕНИЕ — стиль сайта monolit.shop по макетам владельца
// (docs/design/monolitika-redesign-monolitshop-20261006, токены — 00-stil.html):
// светлый фон, белые плоские карточки, Montserrat, синий #005CA9, зелёный успеха.
// Палитра, шрифт и выбранная тема страницы — в ./theme.ts (общие с видом периодов).

// Окно «Менеджеры» открывается нажатием на продажи или брони в любой карточке.
type Metric = 'sales' | 'book';
const OpenManagersCtx = createContext<(nodeId: string, metric: Metric) => void>(() => {});

// Цвет кольца по выполнению плана дня (решение владельца 08.10):
// меньше 70% — красное, от 70% до 99% — жёлтое, от 100% — зелёное.
function ringColor(pct: number): string {
  if (pct >= 100) return C.success;
  if (pct >= 70) return C.warn;
  return C.error;
}
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}
const nf = new Intl.NumberFormat('ru-RU');

// Короткие подписи городов, как в наброске: «СПБ», «МСК». Незнакомое имя — как есть.
const BRANCH_SHORT: Record<string, string> = {
  'Санкт-Петербург': 'СПБ', 'Москва': 'МСК', 'Краснодар': 'КРД', 'Екатеринбург': 'ЕКБ',
};
const deptLabel = (name: string) => name.replace(/^(Департамент|СПБ|МСК|КРД|ЕКБ)\s+/i, '');

/** Кольцо выполнения плана; цвет — по порогам ringColor(). */
function Ring({ pct }: { pct: number | null }) {
  const R = 41, circ = 2 * Math.PI * R;
  const frac = pct == null ? 0 : Math.max(0, Math.min(pct, 100)) / 100;
  const text = pct == null ? '—' : `${pct}%`;
  const color = pct == null ? C.track : ringColor(pct);
  return (
    <svg viewBox="0 0 100 100" className="block h-auto w-full" role="img" aria-label={`${text} плана на день`}>
      <circle cx="50" cy="50" r={R} fill="none" style={{ stroke: C.track }} strokeWidth="10" />
      {frac > 0 && (
        <circle cx="50" cy="50" r={R} fill="none" style={{ stroke: color }} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${circ * frac} ${circ}`} transform="rotate(-90 50 50)" />
      )}
      <text x="50" y="53" textAnchor="middle" fontSize={text.length > 4 ? 15 : 19} fontWeight="700" style={{ fill: C.text }}>{text}</text>
      <text x="50" y="64" textAnchor="middle" fontSize="6.4" fontWeight="500" style={{ fill: C.muted }}>плана на день</text>
    </svg>
  );
}

/** Сумма в рублях: число жирно, знак рубля мельче и приглушённо — как .kpi-val в макете. */
function Money({ value }: { value: number }) {
  return <>{nf.format(Math.round(value))}<span className="ml-[0.25em] text-[0.72em] font-medium opacity-70">₽</span></>;
}

const card = { background: C.surface, borderRadius: 10 } as const;

/** Подпись уровня: «1 Итого», «2 Города и отделы». */
function LevelLabel({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]" style={{ background: C.primary, color: C.onPrimary }}>{n}</span>
      {children}
    </div>
  );
}

/** Счётчик в карточке: значок и число (продажи — зелёные, брони — синие).
 *  Нажатие открывает окно «Менеджеры» этого узла. */
function Count({ kind, value, onClick }: { kind: Metric; value: number; onClick: () => void }) {
  const color = kind === 'sales' ? C.successText : C.primary;
  const Icon = kind === 'sales' ? ShoppingCart : Box;
  const label = kind === 'sales' ? 'Продажи, шт' : 'Брони, шт';
  return (
    <button type="button" onClick={onClick} title={`${label} — показать менеджеров`} aria-label={`${label}: ${value}. Показать менеджеров`}
      className="dt-click flex items-center gap-1 rounded-lg px-1.5 py-1.5 @md:gap-1.5 @md:px-2.5" style={{ background: C.mutedBg, color }}>
      <Icon size={14} className="shrink-0" />
      <span className="text-[18px] font-bold leading-none tabular-nums @md:text-[22px]">{value}</span>
    </button>
  );
}

/** Строка «План / Факт / Брони» в карточке: подпись приглушённая, сумма жирная цветная. */
function Line({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 @md:gap-2.5">
      <span className="w-[42px] shrink-0 text-[12px] font-medium @md:w-[50px] @md:text-[14px]" style={{ color: C.muted }}>{label}</span>
      <span className="min-w-0 truncate text-[14px] font-bold tabular-nums @sm:text-[16px] @lg:text-[19px]" style={{ color }}><Money value={value} /></span>
    </div>
  );
}

/** Карточка города или отдела. Содержимое подрастает вместе с шириной карточки
 *  (контейнерные запросы), поэтому на широком экране нет пустот, а на узком ничего
 *  не обрезается. */
function NodeCard({ node, level }: { node: DashTestNode; level: 'city' | 'deptHead' | 'team' }) {
  const city = level === 'city';
  const short = BRANCH_SHORT[node.name];
  const openManagers = useContext(OpenManagersCtx);
  return (
    <div className="@container min-w-0">
      <div className={city ? 'px-4 pb-4 pt-3' : 'px-3.5 pb-3.5 pt-2.5'} style={card}>
        <div className="mb-3 flex min-w-0 items-center gap-2.5">
          {city ? (
            <>
              <span className="shrink-0 text-[16px] font-bold leading-snug" style={{ background: C.primary, color: C.onPrimary, borderRadius: 8, padding: '2px 14px' }}>
                {short ?? node.name}
              </span>
              {short && <span className="min-w-0 truncate text-[13px] font-medium" style={{ color: C.muted }}>{node.name}</span>}
            </>
          ) : level === 'deptHead' ? (
            // отдел как «глава» колонки: под ним идут его команды
            <span className="min-w-0 truncate text-[15px] font-bold leading-snug" style={{ background: C.primarySoft, color: C.primary, borderRadius: 8, padding: '2px 12px' }} title={node.name}>
              {deptLabel(node.name)}
            </span>
          ) : (
            <span className="min-w-0 truncate text-[15px] font-bold" style={{ color: C.text }} title={node.name}>{deptLabel(node.name)}</span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 @md:gap-4">
          <div className="flex shrink-0 flex-col gap-2">
            <Count kind="sales" value={node.salesCount} onClick={() => openManagers(node.id, 'sales')} />
            <Count kind="book" value={node.bookCount} onClick={() => openManagers(node.id, 'book')} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Line label="План" value={node.plan} color={C.text} />
            <Line label="Факт" value={node.fact} color={C.successText} />
            <Line label="Брони" value={node.bookSum} color={C.primary} />
          </div>
          <div className="w-[60px] shrink-0 @xs:w-[72px] @sm:w-[84px] @lg:w-[104px]">
            <Ring pct={node.pct} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Плитка полосы «Итого» — как KPI в макете: подпись со значком, под ней крупное число.
 *  С onClick плитка становится кнопкой (продажи и брони в штуках открывают «Менеджеров»). */
function TotalTile({ icon, label, color, onClick, children }: { icon: ReactNode; label: string; color: string; onClick?: () => void; children: ReactNode }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-[13px] font-medium" style={{ color: C.muted }}>
        <span style={{ color: C.primary }}>{icon}</span>{label}
      </div>
      <div className="mt-1 truncate text-[28px] font-bold leading-tight tabular-nums" style={{ color }}>{children}</div>
    </>
  );
  if (!onClick) return <div className="min-w-0 rounded-[10px] px-4 py-3" style={{ background: C.mutedBg }}>{body}</div>;
  return (
    <button type="button" onClick={onClick} title={`${label} — показать менеджеров`}
      className="dt-click min-w-0 rounded-[10px] px-4 py-3 text-left" style={{ background: C.mutedBg }}>
      {body}
    </button>
  );
}

function TotalBand({ node }: { node: DashTestNode }) {
  const openManagers = useContext(OpenManagersCtx);
  return (
    <div className="@container min-w-0">
      <div className="flex flex-col gap-4 p-5 @2xl:flex-row @2xl:items-center @2xl:gap-6" style={card}>
        <div className="mx-auto w-[190px] shrink-0 @2xl:mx-0 @2xl:w-[170px]"><Ring pct={node.pct} /></div>
        <div className="grid min-w-0 flex-1 gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <TotalTile icon={<Target size={16} />} label="План" color={C.text}><Money value={node.plan} /></TotalTile>
          <TotalTile icon={<Wallet size={16} />} label="Факт" color={C.successText}><Money value={node.fact} /></TotalTile>
          <TotalTile icon={<Box size={16} />} label="Брони, сумма" color={C.primary}><Money value={node.bookSum} /></TotalTile>
          <TotalTile icon={<ShoppingCart size={16} />} label="Продажи, шт" color={C.successText} onClick={() => openManagers(node.id, 'sales')}>{node.salesCount}</TotalTile>
          <TotalTile icon={<Box size={16} />} label="Брони, шт" color={C.primary} onClick={() => openManagers(node.id, 'book')}>{node.bookCount}</TotalTile>
        </div>
      </div>
    </div>
  );
}

/** Отделы города колонками: сверху отдел, под ним (с отступом и линией) его команды. */
function DeptColumns({ city, min }: { city: DashTestNode; min: number }) {
  return (
    <div className="grid items-start gap-x-4 gap-y-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${min}px), 1fr))` }}>
      {city.children.map(dept => (
        <div key={dept.id} className="flex min-w-0 flex-col gap-2.5">
          <NodeCard node={dept} level="deptHead" />
          {dept.children.length > 0 && (
            <div className="ml-2 flex min-w-0 flex-col gap-2.5 pl-2.5" style={{ borderLeft: `2px solid ${C.line}` }}>
              {dept.children.map(team => <NodeCard key={team.id} node={team} level="team" />)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const EMPTY = 'За этот день нет ни плана, ни продаж.';

/** Вкладка «Все»: итого → блок на каждый город: город, его отделы и команды отделов. */
function ViewAll({ root }: { root: DashTestNode }) {
  return (
    <>
      <LevelLabel n={1}>Итого — все филиалы</LevelLabel>
      <TotalBand node={root} />
      <div className="mt-6">
        <LevelLabel n={2}>Города: отделы и их команды</LevelLabel>
        {root.children.length === 0 && <div className="text-sm" style={{ color: C.muted }}>{EMPTY}</div>}
        {/* Блок города не уже 720px — в него встают два отдела рядом, как в наброске. */}
        <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 720px), 1fr))' }}>
          {root.children.map(cityNode => (
            <div key={cityNode.id} className="flex min-w-0 flex-col gap-3 rounded-[14px] p-2 sm:p-3" style={{ background: C.group }}>
              <NodeCard node={cityNode} level="city" />
              <DeptColumns city={cityNode} min={340} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** Вкладка города: только этот город — итог, отделы и команды. */
function ViewCity({ city }: { city: DashTestNode }) {
  return (
    <>
      <LevelLabel n={1}>Итого — {city.name}</LevelLabel>
      <TotalBand node={city} />
      <div className="mt-6">
        <LevelLabel n={2}>Отделы, под каждым — его команды</LevelLabel>
        {city.children.length === 0 && <div className="text-sm" style={{ color: C.muted }}>{EMPTY}</div>}
        <DeptColumns city={city} min={340} />
      </div>
    </>
  );
}

/** Ключ вкладки города для адреса: «spb», «msk»… (для незнакомого филиала — его id). */
const BRANCH_KEY: Record<string, string> = {
  'Санкт-Петербург': 'spb', 'Москва': 'msk', 'Краснодар': 'krd', 'Екатеринбург': 'ekb',
};
const cityKey = (n: DashTestNode) => BRANCH_KEY[n.name] ?? n.id;

function findNode(n: DashTestNode, id: string): DashTestNode | null {
  if (n.id === id) return n;
  for (const c of n.children) { const hit = findNode(c, id); if (hit) return hit; }
  return null;
}

/** % плана менеджера: рамка того же цвета, что кольцо (пороги ringColor). */
function PctPill({ pct }: { pct: number | null }) {
  return (
    <span className="inline-flex min-w-[56px] justify-center rounded-full px-2 py-0.5 text-[13px] font-bold tabular-nums"
      style={{ border: `2px solid ${pct == null ? C.track : ringColor(pct)}`, color: pct == null ? C.muted : C.text }}>
      {pct == null ? '—' : `${pct}%`}
    </span>
  );
}

// Колонки строки менеджера на широком окне: имя | продажи | брони | план | %.
const MGR_COLS = '@2xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_84px]';

/** Ячейка «штуки + сумма». На узком окне над ней подпись, на широком подписи — в шапке.
 *  С onClick ячейка — кнопка: раскрывает продажи или брони менеджера списком сделок. */
function MgrCell({ label, kind, count, sum, color, onClick }: { label: string; kind?: Metric; count?: number; sum: number; color: string; onClick?: () => void }) {
  const Icon = kind === 'sales' ? ShoppingCart : Box;
  const body = (
    <>
      <div className="text-[11px] font-medium @2xl:hidden" style={{ color: C.muted }}>{label}</div>
      <div className="flex min-w-0 flex-col tabular-nums @2xl:flex-row @2xl:items-baseline @2xl:gap-2.5" style={{ color }}>
        {kind && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[14px] font-bold @2xl:w-[46px]">
            <Icon size={13} className="shrink-0" />{count}
          </span>
        )}
        <span className="min-w-0 truncate text-[13px] font-bold @2xl:text-[15px]"><Money value={sum} /></span>
      </div>
    </>
  );
  if (!onClick) return <div className="min-w-0">{body}</div>;
  return (
    <button type="button" onClick={onClick} title={`${label} — показать сделки`}
      className="dt-click -mx-1.5 -my-1 min-w-0 rounded-lg px-1.5 py-1 text-left">
      {body}
    </button>
  );
}

function ManagerRow({ m, onDeals }: { m: DashTestManager; onDeals: (kind: Metric) => void }) {
  // раскрывать нечего — ячейка остаётся обычным текстом
  const hasSales = m.salesCount > 0 || m.fact > 0;
  const hasBook = m.bookCount > 0 || m.bookSum > 0;
  return (
    <div className={`grid grid-cols-3 items-start gap-x-3 gap-y-1.5 rounded-[10px] px-3.5 py-2.5 @2xl:items-center ${MGR_COLS}`} style={{ background: C.surface }}>
      <div className="col-span-2 min-w-0 truncate text-[15px] font-bold @2xl:col-span-1" title={m.name}>{m.name}</div>
      <div className="justify-self-end @2xl:order-last"><PctPill pct={m.pct} /></div>
      <MgrCell label="Продажи" kind="sales" count={m.salesCount} sum={m.fact} color={C.successText} onClick={hasSales ? () => onDeals('sales') : undefined} />
      <MgrCell label="Брони" kind="book" count={m.bookCount} sum={m.bookSum} color={C.primary} onClick={hasBook ? () => onDeals('book') : undefined} />
      <MgrCell label="План" sum={m.plan} color={C.text} />
    </div>
  );
}

// Сделка открывается в Битриксе — тот же адрес, что в списках сделок отчётов.
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const qf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const MAX_PRODUCTS = 8;

/** Сделка менеджера: название, время, воронка, группа, стадия, сумма и под чертой —
 *  товары сделки: что продано, сколько и на какую сумму. Вся карточка — ссылка:
 *  нажатие открывает сделку в Битриксе в новой вкладке (правка владельца 08.10). */
function DealCard({ deal, kind }: { deal: DashTestDeal; kind: Metric }) {
  const shown = deal.products.slice(0, MAX_PRODUCTS);
  const rest = deal.products.length - shown.length;
  const meta = [timeLabel(deal.at), `№ ${deal.id}`, deal.funnel, deal.group, deal.stage].filter((x): x is string => !!x);
  return (
    <a href={dealUrl(deal.id)} target="_blank" rel="noreferrer" title="Открыть сделку в Битриксе"
      className="dt-click block rounded-[10px] px-3.5 py-3" style={{ background: C.surface, color: C.text }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="break-words text-[15px] font-bold">
            {deal.name}
            <ExternalLink size={14} className="ml-1.5 inline-block align-[-1px]" style={{ color: C.primary }} aria-hidden />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] font-medium tabular-nums" style={{ color: C.muted }}>
            {meta.map((t, i) => <span key={i}>{t}{i < meta.length - 1 && <span className="ml-2">·</span>}</span>)}
          </div>
        </div>
        <div className="shrink-0 text-[17px] font-bold tabular-nums" style={{ color: kind === 'sales' ? C.successText : C.primary }}><Money value={deal.amount} /></div>
      </div>
      {shown.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-1 pt-2.5 text-[13px]" style={{ borderTop: `1px solid ${C.track}` }}>
          {shown.map((p, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3">
              <span className="min-w-0 break-words">{p.name}</span>
              <span className="whitespace-nowrap tabular-nums" style={{ color: C.muted }}>× {qf.format(p.quantity)}</span>
              <span className="min-w-[84px] whitespace-nowrap text-right font-bold tabular-nums"><Money value={p.sum} /></span>
            </div>
          ))}
          {rest > 0 && <div style={{ color: C.muted }}>и ещё {rest} поз.</div>}
        </div>
      )}
    </a>
  );
}

/** Список сделок менеджера за день дашборда (продажи или брони). */
function DealsList({ manager, kind, day }: { manager: DashTestManager; kind: Metric; day: string }) {
  const { data, isLoading, isError } = useQuery<DashTestDealsResponse>({
    queryKey: ['dashboard-test-deals', day, manager.id, kind],
    queryFn: async () => {
      const res = await fetch(`/api/dashboard-test/deals?manager=${encodeURIComponent(manager.id)}&type=${kind}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });
  if (isLoading) return <div className="px-1 py-4 text-sm" style={{ color: C.muted }}>Загружаем сделки…</div>;
  if (isError || !data) return <div className="px-1 py-4 text-sm" style={{ color: C.error }}>Не удалось загрузить сделки. Закройте окно и откройте снова.</div>;
  if (data.deals.length === 0) {
    return <div className="px-1 py-4 text-sm" style={{ color: C.muted }}>{kind === 'sales' ? 'За этот день продаж нет.' : 'За этот день броней нет.'}</div>;
  }
  return (
    <>
      {data.deals.map(d => <DealCard key={d.id} deal={d} kind={kind} />)}
      {data.totalCount > data.deals.length && (
        <div className="px-1 text-[13px]" style={{ color: C.muted }}>Показаны первые {data.deals.length} из {data.totalCount}.</div>
      )}
    </>
  );
}

type DealsTarget = { managerId: string; kind: Metric };

/** Окно «Менеджеры»: менеджеры узла с их цифрами за день. Открывается нажатием на
 *  продажи или брони; чем открыли — по тому и отсортировано (можно переключить).
 *  Нажатие на продажи или брони менеджера показывает в этом же окне его сделки. */
function ManagersModal({ node, managers, day, sort, onSort, deals, onDeals, onClose }: {
  node: DashTestNode; managers: Record<string, DashTestManager>; day: string;
  sort: Metric; onSort: (m: Metric) => void;
  deals: DealsTarget | null; onDeals: (t: DealsTarget | null) => void; onClose: () => void;
}) {
  const dealsManager = deals ? managers[deals.managerId] ?? null : null;
  const inDeals = !!deals && !!dealsManager;
  useEffect(() => {
    // Esc: из сделок — назад к менеджерам, из менеджеров — закрыть окно
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (inDeals) onDeals(null); else onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inDeals, onDeals, onClose]);

  const byName = (a: DashTestManager, b: DashTestManager) => a.name.localeCompare(b.name, 'ru');
  const rows = node.managerIds.map(id => managers[id]).filter((m): m is DashTestManager => !!m).sort(sort === 'sales'
    ? (a, b) => b.fact - a.fact || b.salesCount - a.salesCount || b.bookSum - a.bookSum || byName(a, b)
    : (a, b) => b.bookSum - a.bookSum || b.bookCount - a.bookCount || b.fact - a.fact || byName(a, b));
  const title = node.kind === 'root' ? 'Все филиалы' : node.kind === 'branch' ? node.name : deptLabel(node.name);
  const closeBtn = (
    <button type="button" onClick={onClose} aria-label="Закрыть" className="dt-click inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px]" style={{ background: C.mutedBg, color: C.text }}>
      <X size={20} />
    </button>
  );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={inDeals && dealsManager ? `Сделки — ${dealsManager.name}` : `Менеджеры — ${title}`}>
      <button type="button" aria-label="Закрыть окно" onClick={onClose} className="absolute inset-0 cursor-default" style={{ background: 'rgba(8, 12, 18, 0.6)' }} />
      <div className="@container relative flex max-h-[86dvh] w-full max-w-[920px] flex-col overflow-hidden rounded-[14px]" style={{ background: C.bg, color: C.text, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        {inDeals && deals && dealsManager ? (
          <>
            <div className="px-4 pb-3 pt-3.5 @2xl:px-5" style={{ background: C.surface }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button type="button" onClick={() => onDeals(null)} className="dt-click -ml-2 inline-flex min-h-[32px] items-center gap-1.5 rounded-lg px-2 text-[12px] font-bold uppercase tracking-wide" style={{ color: C.primary }}>
                    <ArrowLeft size={15} />Менеджеры · {title}
                  </button>
                  <div className="truncate text-[22px] font-bold leading-tight">{dealsManager.name}</div>
                </div>
                {closeBtn}
              </div>
              <div role="tablist" aria-label="Что показать" className="mt-3 inline-flex max-w-full flex-wrap gap-1 rounded-[10px] p-1" style={{ background: C.mutedBg }}>
                <TabButton active={deals.kind === 'sales'} onClick={() => onDeals({ managerId: deals.managerId, kind: 'sales' })}>
                  Продажи · {dealsManager.salesCount} шт · <Money value={dealsManager.fact} />
                </TabButton>
                <TabButton active={deals.kind === 'book'} onClick={() => onDeals({ managerId: deals.managerId, kind: 'book' })}>
                  Брони · {dealsManager.bookCount} шт · <Money value={dealsManager.bookSum} />
                </TabButton>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 @2xl:p-4">
              <DealsList manager={dealsManager} kind={deals.kind} day={day} />
            </div>
          </>
        ) : (
          <>
            <div className="px-4 pb-3 pt-3.5 @2xl:px-5" style={{ background: C.surface }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>Менеджеры · {rows.length}</div>
                  <div className="truncate text-[22px] font-bold leading-tight">{title}</div>
                </div>
                {closeBtn}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[14px] font-bold tabular-nums">
                <span style={{ color: C.successText }}><span className="font-medium" style={{ color: C.muted }}>Продажи </span>{node.salesCount} шт · <Money value={node.fact} /></span>
                <span style={{ color: C.primary }}><span className="font-medium" style={{ color: C.muted }}>Брони </span>{node.bookCount} шт · <Money value={node.bookSum} /></span>
                <span><span className="font-medium" style={{ color: C.muted }}>План </span><Money value={node.plan} /></span>
                <PctPill pct={node.pct} />
              </div>
              <div role="tablist" aria-label="Сортировка" className="mt-3 inline-flex gap-1 rounded-[10px] p-1" style={{ background: C.mutedBg }}>
                <TabButton active={sort === 'sales'} onClick={() => onSort('sales')}>По продажам</TabButton>
                <TabButton active={sort === 'book'} onClick={() => onSort('book')}>По броням</TabButton>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 @2xl:p-4">
              {rows.length === 0 && <div className="px-1 py-4 text-sm" style={{ color: C.muted }}>За этот день здесь нет менеджеров с планом, продажами или бронями.</div>}
              {rows.length > 0 && (
                <div className={`hidden gap-x-3 px-3.5 text-[12px] font-bold uppercase tracking-wide @2xl:grid ${MGR_COLS}`} style={{ color: C.muted }}>
                  <span>Менеджер</span><span>Продажи</span><span>Брони</span><span>План</span><span className="whitespace-nowrap text-center">% плана</span>
                </div>
              )}
              {rows.map(m => <ManagerRow key={m.id} m={m} onDeals={kind => onDeals({ managerId: m.id, kind })} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Кнопка-вкладка. tone — цвет выбранной: синий (по умолчанию) или жёлтый акцент
 *  (фильтр «Департамент», чтобы два фильтра различались цветом). */
function TabButton({ active, onClick, tone = 'primary', children }: { active: boolean; onClick: () => void; tone?: 'primary' | 'accent'; children: ReactNode }) {
  const on = tone === 'accent' ? { background: C.accent, color: C.onAccent } : { background: C.primary, color: C.onPrimary };
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick}
      className="min-h-[36px] cursor-pointer rounded-lg px-4 text-[14px] font-bold leading-none transition-colors"
      style={active ? on : { background: 'transparent', color: C.text }}>
      {children}
    </button>
  );
}

const subscribeNever = () => () => {};
const PERIOD_TABS: { key: 'today' | DashPeriod; label: string }[] = [
  { key: 'today', label: 'Сегодня' }, { key: 'week', label: 'Неделя' }, { key: 'month', label: 'Месяц' }, { key: 'year', label: 'Год' },
];

export function DashboardTestPage() {
  const { data, isLoading, isError } = useQuery<DashTestResponse>({
    queryKey: ['dashboard-test'],
    queryFn: async () => {
      const res = await fetch('/api/dashboard-test');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 60_000,
  });

  // Вкладка: 'all' | ключ города. Начальное значение — из адреса (?tab=…).
  const [tab, setTab] = useState<string>(() =>
    typeof window === 'undefined' ? 'all' : new URLSearchParams(window.location.search).get('tab') ?? 'all');
  const pickTab = (t: string) => {
    setTab(t);
    const u = new URL(window.location.href);
    if (t === 'all') u.searchParams.delete('tab'); else u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u);
  };
  // Период: 'today' | 'week' | 'month' | 'year' (из адреса ?period=…), offset — на сколько
  // периодов назад ушли в «Выборе даты» (0 — текущий).
  const [periodState, setPeriod] = useState<'today' | DashPeriod>(() => {
    const p = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('period');
    return isDashPeriod(p) ? p : 'today';
  });
  // Переключатель периода рисуется и на сервере, а период из адреса знает только браузер:
  // пока страница «оживает», показываем «Сегодня», как отдал сервер, и сразу после —
  // период из адреса. Иначе React ругается на расхождение разметки.
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const period: 'today' | DashPeriod = hydrated ? periodState : 'today';
  const [offset, setOffset] = useState(0);
  const pickPeriod = (p: 'today' | DashPeriod) => {
    setPeriod(p); setOffset(0);
    const u = new URL(window.location.href);
    if (p === 'today') u.searchParams.delete('period'); else u.searchParams.set('period', p);
    window.history.replaceState(null, '', u);
  };
  const periodQ = useDashPeriod(period === 'today' ? null : period, offset);
  const periodData = period !== 'today' && periodQ.data?.period === period ? periodQ.data : null;
  const theme = useSyncExternalStore<ThemeName>(subscribeTheme, readTheme, () => 'light');
  const dark = theme === 'dark';
  const updatedAt = period === 'today' ? data?.generatedAt : periodData?.generatedAt;
  // Вторая строка вкладки периода — её даты: «9 окт, пт», «5–11 окт», «октябрь», «2026».
  const periodSub = (p: 'today' | DashPeriod, off: number): string => {
    if (!data) return '';
    if (p === 'today') {
      const [, m, d] = data.day.split('-').map(Number);
      return `${d} ${MONTHS_SHORT[m - 1]}, ${WEEKDAYS_SHORT[weekdayIndex(data.day)]}`;
    }
    const r = periodRange(p, off, data.today);
    if (p === 'week') return shortRange(r.from, r.to);
    if (p === 'year') return r.from.slice(0, 4);
    const sameYear = r.from.slice(0, 4) === data.today.slice(0, 4);
    return `${MONTHS_NOM[Number(r.from.slice(5, 7)) - 1].toLowerCase()}${sameYear ? '' : ` ${r.from.slice(0, 4)}`}`;
  };
  // Окно «Менеджеры»: храним id узла, а не сам узел — цифры в открытом окне обновляются
  // вместе со страницей.
  const [modal, setModal] = useState<{ nodeId: string; sort: Metric; deals: DealsTarget | null } | null>(null);
  const openManagers = (nodeId: string, metric: Metric) => setModal({ nodeId, sort: metric, deals: null });
  const closeManagers = () => setModal(null);
  const cities = data?.root.children ?? [];
  const city = cities.find(c => cityKey(c) === tab);
  const view = city ? 'city' : 'all';

  // Фильтр «Департамент»: пункты — названия департаментов выбранного города (или всех городов).
  const [dept, setDept] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('dept'));
  const pickDept = (d: string | null) => {
    setDept(d);
    const u = new URL(window.location.href);
    if (d) u.searchParams.set('dept', d); else u.searchParams.delete('dept');
    window.history.replaceState(null, '', u);
  };
  const cityShort = (c: DashTestNode) => BRANCH_SHORT[c.name] ?? c.name;
  // периоды: оргструктура для фильтров графиков (у каждого графика есть свои — см. PeriodView)
  const scopeTree: ScopeTree = {
    rootId: data?.root.id ?? '',
    cities: cities.map(c => ({ id: c.id, name: c.name, short: cityShort(c), depts: c.children.map(d => ({ id: d.id, name: d.name, label: deptLabel(d.name) })) })),
  };
  // «ЖБИ» в списке есть, только когда выбрана Москва; без филиала ЖБИ входит в НЦ (правило — в PeriodView)
  const deptLabels = scopeDeptLabels(scopeTree, city?.id ?? null);
  // На «Сегодня» фильтра нет (решение владельца 09.10) — он только у недели, месяца и года;
  // выбранный департамент при этом помнится и вернётся, когда снова откроют период.
  const activeDept = period !== 'today' && dept && deptLabels.includes(dept) ? dept : null;
  // «Сбросить все фильтры» (владелец 09.10): филиал и департамент страницы — на «Все», свои
  // фильтры блоков — тоже. Период и выбранная дата не трогаются: это не фильтры, а что смотрим.
  const [blocksOwn, setBlocksOwn] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const canReset = view !== 'all' || !!activeDept || (period !== 'today' && blocksOwn);
  const resetAll = () => { pickTab('all'); pickDept(null); setResetKey(k => k + 1); };
  const modalNode = data && modal ? findNode(data.root, modal.nodeId) : null;

  return (
    <div className="dt-root flex h-full flex-col overflow-auto" data-dt-theme={theme} style={{ background: C.bg, color: C.text, fontFamily: FONT }}>
      <style>{FONT_FACES + THEME_CSS}</style>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pt-5">
        <h1 className="text-[28px] font-bold leading-tight">Дашборд тест</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {updatedAt && (
            <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: C.muted }}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.success }} />
              Обновлено {timeLabel(updatedAt)}
            </span>
          )}
          <button type="button" onClick={() => writeTheme(dark ? 'light' : 'dark')} aria-pressed={dark}
            className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-[10px] px-3.5 text-[14px] font-bold leading-none"
            style={{ background: C.surface, color: C.text }}>
            {dark ? <Sun size={16} style={{ color: C.primary }} /> : <Moon size={16} style={{ color: C.primary }} />}
            {dark ? 'Светлая тема' : 'Тёмная тема'}
          </button>
        </div>
      </div>

      {/* Полоса периода (переделана по просьбе владельца 09.10 — прежняя плашка по центру висела
          отдельно от всего). Одна полоса во всю ширину, вкладки — по центру; у каждой вкладки второй
          строкой её даты, выбранная — синяя. По умолчанию «Сегодня». Выбор даты стоит ниже, в ряду
          фильтров, у правого края (сначала был в этой же полосе справа — владелец попросил вынести). */}
      <div className="px-6 pt-3">
        <div className="flex justify-center rounded-[14px] p-1.5" style={{ background: C.surface }}>
          <div role="tablist" aria-label="Период" className="grid w-full min-w-0 max-w-[600px] grid-cols-4 gap-1">
            {PERIOD_TABS.map(p => {
              const on = period === p.key;
              const sub = periodSub(p.key, on ? offset : 0);
              return (
                <button key={p.key} type="button" role="tab" aria-selected={on} onClick={() => pickPeriod(p.key)}
                  className="dt-tab flex min-h-[56px] min-w-0 cursor-pointer flex-col items-center justify-center rounded-[10px] px-2.5 text-center transition-colors sm:px-4"
                  style={on ? { background: C.primary, color: C.onPrimary } : { color: C.text }}>
                  <span className="text-[15px] font-bold leading-tight sm:text-[17px]">{p.label}</span>
                  <span className="mt-0.5 max-w-full truncate text-[11px] font-medium leading-tight tabular-nums sm:text-[13px]" style={{ color: on ? C.onPrimary : C.muted, opacity: on ? 0.85 : 1 }}>{sub || ' '}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {data && (
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 px-6 pt-3">
          {/* Два отдельных фильтра (правки владельца 09.10): у каждого своя подпись сверху, своя
              плашка и свой цвет — «Филиал» синий, «Департамент» жёлтый (акцент сайта); раньше
              читались как один ряд кнопок. Оба стоят слева, рядом (владелец 09.10 попробовал
              «Департамент» у правого края и вернул к левому). */}
          <div className="flex min-w-0 max-w-full flex-wrap items-end gap-x-7 gap-y-3">
            <div className="flex min-w-0 max-w-full flex-col gap-1">
              <div className="flex items-center gap-1.5 px-1 text-[12px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: C.primary }} />Филиал
              </div>
              <div role="tablist" aria-label="Филиал" className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-[10px] p-1" style={{ background: C.surface }}>
                <TabButton active={view === 'all'} onClick={() => pickTab('all')}>Все</TabButton>
                {cities.map(c => (
                  <TabButton key={c.id} active={view === 'city' && city?.id === c.id} onClick={() => pickTab(cityKey(c))}>
                    {BRANCH_SHORT[c.name] ?? c.name}
                  </TabButton>
                ))}
              </div>
            </div>
            {period !== 'today' && deptLabels.length > 0 && (
              <div className="flex min-w-0 max-w-full flex-col gap-1">
                <div className="flex items-center gap-1.5 px-1 text-[12px] font-bold uppercase tracking-wide" style={{ color: C.muted }}>
                  <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: C.accent }} />Департамент
                </div>
                <div role="tablist" aria-label="Департамент" className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-[10px] p-1" style={{ background: C.surface }}>
                  <TabButton tone="accent" active={!activeDept} onClick={() => pickDept(null)}>Все</TabButton>
                  {deptLabels.map(l => <TabButton key={l} tone="accent" active={activeDept === l} onClick={() => pickDept(l)}>{l}</TabButton>)}
                </div>
              </div>
            )}
            {/* появляется, когда есть что сбрасывать: выбран филиал / департамент или у блока свои фильтры */}
            {canReset && (
              <button type="button" onClick={resetAll} title="Филиал и департамент — «Все», у блоков — тоже"
                className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-[10px] px-3 text-[14px] font-bold leading-none" style={{ color: C.muted }}>
                <RotateCcw size={16} className="shrink-0" />Сбросить все фильтры
              </button>
            )}
          </div>
          {/* Выбор даты — на одной высоте с плашками фильтров, у правого края. */}
          <div className="ml-auto flex min-h-[44px] min-w-0 max-w-full items-center rounded-[10px] px-1 py-1" style={{ background: C.surface }}>
            {period === 'today' ? (
              <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 text-[14px] font-bold">
                <CalendarDays size={16} className="shrink-0" style={{ color: C.primary }} />{dayLabel(data.day)}
                {!data.isToday && <span className="font-medium" style={{ color: C.muted }}>последний день с продажами</span>}
              </span>
            ) : periodData ? (
              <DatePicker key={period} period={period} offset={offset} maxOffset={periodData.maxOffset} today={periodData.today} onChange={setOffset} />
            ) : <span className="px-2.5 text-[14px]" style={{ color: C.muted }}>…</span>}
          </div>
        </div>
      )}

      <div className="flex-1 px-6 pb-6 pt-4">
        {isLoading && <div className="text-sm" style={{ color: C.muted }}>Считаем показатели…</div>}
        {isError && <div className="text-sm" style={{ color: C.error }}>Не удалось загрузить дашборд. Обновите страницу.</div>}
        {period === 'today' ? (
          <OpenManagersCtx.Provider value={openManagers}>
            {data && view === 'all' && <ViewAll root={data.root} />}
            {data && view === 'city' && city && <ViewCity city={city} />}
          </OpenManagersCtx.Provider>
        ) : data && (
          <PeriodView period={period} offset={offset} tree={scopeTree} sel={{ cityId: city?.id ?? null, dept: activeDept }}
            // нажали на филиал / департамент в графике — включаем те же фильтры, что вверху страницы
            onFilter={(cityId, d) => { const c = cities.find(x => x.id === cityId); pickTab(c ? cityKey(c) : 'all'); pickDept(d); }}
            resetKey={resetKey} onOwnFilters={setBlocksOwn} />
        )}
      </div>
      {/* Окно внутри .dt-root — чтобы на него действовала выбранная тема страницы. */}
      {data && modal && modalNode && (
        <ManagersModal node={modalNode} managers={data.managers} day={data.day} sort={modal.sort}
          onSort={m => setModal({ ...modal, sort: m })}
          deals={modal.deals} onDeals={t => setModal({ ...modal, deals: t })} onClose={closeManagers} />
      )}
    </div>
  );
}
