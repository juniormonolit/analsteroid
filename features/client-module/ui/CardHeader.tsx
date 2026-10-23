'use client';
// Закреплённая шапка «Карточки клиента» (аудит Fable 23.10, владелец: «может стоит сделать что-то в виде
// закреплённой инфы в верхней части карточки»). Имя · тип · менеджер, строка статуса (риск/срок, чем кончилась
// последняя сделка, деньги, что предложить) и вкладки остаются наверху, пока листаешь вкладку; после прокрутки
// мимо блока клиента (тип, заметка) статус сворачивается в одну строку. Без JS-скролл-обработчиков: sticky +
// IntersectionObserver на «маячке» под блоком клиента. Во вкладке Битрикса фрейм растягивается под контент
// (BitrixFrameFit) — там sticky не работает, шапка обычная.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Building2, ExternalLink, User } from 'lucide-react';
import { fmtMoney } from '@/features/customers/ui/shared';
import { type ClientModuleData, CLIENT_TYPES, computeStats, isOpenDeal } from '../engine/types';
import { callTiming } from '../engine/callTiming';
import { Chip, fmtD, shortGroup, type Tone } from './parts';

const short = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс` : `${n}`);
const plural = (n: number, a: string, b: string, c: string) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

/** Чипы статуса: риск/срок, последняя сделка, деньги, что предложить. Пустые не рисуем. */
export function statusChips(data: ClientModuleData): { key: string; tone: Tone; text: string; title?: string }[] {
  const out: { key: string; tone: Tone; text: string; title?: string }[] = [];
  const open = data.deals.find(isOpenDeal);
  const t = callTiming(data.deals);
  if (open) out.push({ key: 'risk', tone: 'accent', text: `В работе · ${open.stageName ?? 'сделка'}`, title: 'Есть открытая сделка' });
  else if (t) {
    if (t.state === 'overdue') out.push({ key: 'risk', tone: 'neg', text: `${t.since} дн. без покупок · цикл ${t.cycle}`, title: 'Давно не покупал — риск ухода (медиана интервалов между покупками)' });
    else if (t.state === 'due') out.push({ key: 'risk', tone: 'warn', text: `Пора звонить · цикл ${t.cycle} дн.`, title: `С последней покупки ${t.since} дн.` });
    else out.push({ key: 'risk', tone: 'muted', text: `След. покупка ~${fmtD(t.nextAt)}`, title: `Обычно покупает раз в ${t.cycle} дн.` });
  }
  const d = data.deals[0];
  if (d && d !== open) {
    if (d.stage === 'lost') out.push({ key: 'last', tone: /не дозвон/i.test(d.stageName ?? '') ? 'warn' : 'neg', text: `Отказ ${fmtD(d.lostAt)}${d.stageName ? ` · ${d.stageName}` : ''}`, title: 'Чем кончилась последняя сделка' });
    else if (d.stage === 'shipped') out.push({ key: 'last', tone: 'ok', text: `Отгружена ${fmtD(d.deliveredAt)}`, title: 'Последняя сделка' });
    else if (d.stage === 'sold') out.push({ key: 'last', tone: 'warn', text: `Продана ${fmtD(d.soldAt)}`, title: 'Последняя сделка — ждёт отгрузки' });
  }
  const s = computeStats(data.deals);
  if (s.shipped > 0) out.push({ key: 'money', tone: 'muted', text: `LTV ${short(s.ltv)} ₽ · ${s.shipped} ${plural(s.shipped, 'отгрузка', 'отгрузки', 'отгрузок')}${s.avgCheck ? ` · чек ${short(s.avgCheck)}` : ''}` });
  const rec = data.recommendations.client[0];
  if (rec) out.push({ key: 'next', tone: 'accent', text: `→ предложить: ${shortGroup(rec.group)}`, title: rec.ask ? `Спросить: «${rec.ask}»` : 'Первое в «Предложить клиенту»' });
  return out;
}

export function CardHeader({ data, sticky, tabs, actions, extra, children }: {
  data: ClientModuleData;
  /** Закреплять (выдвижная панель / страница); во вкладке Битрикса — нет. */
  sticky: boolean;
  /** Лента вкладок — часть закреплённого блока. */
  tabs: ReactNode;
  /** Справа в первой строке (Битрикс ↗ и т.п.). Кнопки панели (Ссылка, ✕) — поверх, у ClientCardDrawer. */
  actions?: ReactNode;
  /** Под строкой статуса справа — главное действие раздела, откуда открыли (канбан). */
  extra?: ReactNode;
  /** Блок клиента (тип, заметка) — между шапкой и вкладками, прокручивается. */
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!sticky || !mark.current) return;
    const root = mark.current.closest('[data-card-scroll]') as HTMLElement | null;
    // Верх зоны наблюдения опущен под шапку (~130 px): маячок «ушёл под неё» — сворачиваем.
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 140),
      { root, threshold: 0, rootMargin: '-130px 0px 0px 0px' });
    io.observe(mark.current);
    return () => io.disconnect();
  }, [sticky]);

  const title = data.name ?? (data.clientType === 'contact' ? `Контакт #${data.clientId}` : `Компания #${data.clientId}`);
  const typeLabel = CLIENT_TYPES.find(t => t.value === data.profile.clientType)?.label ?? null;
  const manager = data.deals.find(d => d.managerName)?.managerName ?? null;
  const chips = statusChips(data);
  const shown = collapsed ? chips.filter(c => c.key === 'risk' || c.key === 'next') : chips;

  return (
    <>
      <div className={sticky
        ? `sticky top-0 z-20 -mx-4 bg-[var(--color-bg)] px-4 pt-1 sm:-mx-6 sm:px-6 ${collapsed ? 'shadow-[0_8px_12px_-12px_rgba(0,0,0,0.45)]' : ''}`
        : ''}>
        <div className={`flex min-w-0 items-center gap-2 ${sticky ? 'min-h-11 pr-[150px] sm:pr-[230px]' : ''}`}>
          {data.clientType === 'company' ? <Building2 size={18} className="shrink-0 text-[var(--color-text-muted)]" /> : <User size={18} className="shrink-0 text-[var(--color-text-muted)]" />}
          <h2 className={`min-w-0 font-bold leading-tight ${collapsed ? 'truncate text-[15px]' : 'line-clamp-2 text-[18px]'}`} title={title}>{title}</h2>
          {/* «Битрикс ↗» на телефоне — во второй строке: в первой место нужно имени (кнопки панели справа). */}
          {/* Справа в первой строке — «Битрикс ↗» и главная кнопка канбана (скрин владельца 23.10: кнопка уезжала
              отдельной строкой под статус). На телефоне — во второй строке. */}
          {(actions || extra) && <span className="ml-auto hidden shrink-0 items-center gap-2 sm:inline-flex">{actions}{extra}</span>}
        </div>
        <div className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-[var(--color-text-muted)] ${collapsed ? 'pb-1' : 'pb-1.5'}`}>
          <span className={typeLabel ? 'font-semibold text-[var(--color-accent)]' : 'rounded border border-dashed border-[var(--color-border-strong)] px-1.5'}>{typeLabel ?? 'Тип не указан'}</span>
          {manager && <span className="min-w-0 truncate">· менеджер {manager}</span>}
          {actions && <span className="sm:hidden">{actions}</span>}
          {/* Деньги на телефоне не показываем — они на «Обзоре»; здесь только то, что нужно для звонка. */}
          {shown.map(c => <span key={c.key} className={`max-w-full [&>span]:max-w-full [&>span]:truncate ${c.key === 'money' ? 'hidden sm:inline' : ''}`}><Chip tone={c.tone} title={c.title}>{c.text}</Chip></span>)}
          {extra && <span className="w-full sm:hidden">{extra}</span>}
        </div>
        {tabs}
      </div>
      {children}
      {/* Маячок: ушёл под шапку — статус сворачивается. */}
      <div ref={mark} aria-hidden className="h-px" />
    </>
  );
}

/** Вкладки одной лентой (CLAUDE.md, правило 12: родитель min-w-0, затухание у края, scrollbar-none, активная — в зоне видимости). */
export function TabsRibbon<T extends string>({ tabs, active, onChange }: { tabs: { key: T; label: string; count?: number }[]; active: T; onChange: (t: T) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const measure = () => { const el = ref.current; if (el) setEdge({ l: el.scrollLeft > 2, r: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 }); };
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-tab-key="${active}"]`);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: first.current ? 'auto' : 'smooth' });
    first.current = false;
    measure();
  }, [active]);
  useEffect(() => { measure(); window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }, []);
  return (
    <div className="relative min-w-0 border-b border-[var(--color-border)]">
      <div ref={ref} onScroll={measure} role="tablist" className="scrollbar-none flex min-w-0 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.key} data-tab-key={t.key} type="button" role="tab" aria-selected={active === t.key} onClick={() => onChange(t.key)}
            className={`-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-[13.5px] outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${active === t.key ? 'border-[var(--color-accent)] font-semibold text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {t.label}{t.count !== undefined && <span className="ml-1 tabular-nums opacity-70">{t.count}</span>}
          </button>
        ))}
      </div>
      {edge.l && <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-[var(--color-bg)] to-transparent" />}
      {edge.r && <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--color-bg)] to-transparent" />}
    </div>
  );
}

/** «Битрикс ↗» — не во вкладке Битрикса (там это та же карточка). */
export function BitrixLink({ data }: { data: ClientModuleData }) {
  return (
    <a href={`https://td.monolit-crm.ru/crm/${data.clientType}/details/${data.clientId}/`} target="_blank" rel="noreferrer"
      className="inline-flex min-h-9 shrink-0 items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline">
      Битрикс <ExternalLink size={12} />
    </a>
  );
}

