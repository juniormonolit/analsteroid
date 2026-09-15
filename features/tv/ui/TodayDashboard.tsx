'use client';
// Дашборд «Сегодня по компании» (правка владельца 08.09): отдельный URL /today без меню.
// Вкладки — Итого и филиалы; KPI выбранного узла; дерево департаменты → отделы → менеджеры
// с раскрытием. Данные — /api/tv/dashboard (тот же движок, что у телевизоров), 30 с.
//
// Задача #6446 (14.09): «РОП — сегодня» (/rop) — авторизованная копия с теми же вёрсткой
// и логикой, но данные из /api/rop/dashboard уже урезаны бэкендом по зоне ответственности
// (ropScope). Чтобы не копипастить разметку, вынесена общая `DashboardView` с параметрами
// (эндпоинт, ключ запроса, заголовок, подпись) — `TodayDashboard`/`RopDashboard` ниже её
// просто настраивают под свой URL и текст.
//
// Задача #6465 (14.09, Серёга: «сделай так, чтобы брони и продажи можно было в сделки
// раскрывать»): клик по числу продаж/броней (KPI-плитка, строка узла, строка менеджера)
// открывает список сделок — DashboardDrilldownPanel. Состояние панели живёт в URL
// (?dd=sales|book&node=<id>|&manager=<id>), а не в useState — так ссылку на конкретный
// открытый список можно переслать (правило репозитория «каждое состояние — свой URL»).
import { useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, EyeOff, Moon, RefreshCw, Sun, Users } from 'lucide-react';
import type { TvDashManager, TvDashNode, TvDashboard as Dash } from '../engine/dashboard';
import { DashboardDrilldownPanel, type DashboardDrilldownTarget, type DrilldownKind } from './DashboardDrilldownPanel';

// Неразрывные пробелы: «17,5 млн ₽» не должно переноситься по словам в узкой KPI-карточке
// (правка владельца 08.09: «знак рубля вываливается»).
const NB = '\u00a0';
const fmtMoney = (v: number): string => {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}${NB}млн${NB}₽`;
  if (v >= 1e4) return `${Math.round(v / 1e3).toLocaleString('ru-RU')}${NB}тыс${NB}₽`;
  return `${Math.round(v).toLocaleString('ru-RU')}${NB}₽`;
};
const pctOf = (fact: number, plan: number): number | null => (plan > 0 ? Math.round((fact / plan) * 100) : null);

function Pct({ fact, plan }: { fact: number; plan: number }) {
  const p = pctOf(fact, plan);
  if (p == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  return <span className={`font-semibold ${p >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-warning)]'}`}>{p}%</span>;
}
// onClick (задача #6465) — раскрыть число в список сделок за сегодня: KPI-плитка,
// строка узла и строка менеджера передают его одинаково, рендер меняется только
// span→button (тот же текст/цвет, плюс подчёркивание по hover — видно, что кликабельно).
function Pb({ pb, target, onClick }: { pb: number; target: number; onClick?: () => void }) {
  const ok = target > 0 && pb >= target;
  const cls = `font-semibold tabular-nums ${ok ? 'text-[var(--color-positive)]' : target > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`;
  const content = <>{pb}<span className="text-[var(--color-text-muted)] font-normal"> / {target}</span></>;
  if (!onClick) return <span className={cls}>{content}</span>;
  return (
    <button onClick={onClick} className={`${cls} hover:underline underline-offset-2 cursor-pointer`} title="Показать сделки за сегодня">
      {content}
    </button>
  );
}

// Крупная типографика под большой монитор: на десктопе размеры в vw (1.1vw ≈ 21px на 1920),
// на телефоне — обычные rem (правка владельца 08.09: «пожирней, чтобы на весь экран»).
// Палитра телевизора (features/tv/engine/page.ts) поверх токенов приложения — правка
// владельца 09.09: «в той же стилистике, что и ТВ-дашборды, или переключатель темы».
// Переменные переопределяются на обёртке страницы, компоненты ниже читают их как обычно.
// Задача #6465: drill-down переиспользует DealsTable/DealsListBody (features/reports/
// ui/DrilldownDrawer.tsx) — компонент рассчитан на глобальные токены приложения
// (app/globals.css :root), которых наша ЛОКАЛЬНАЯ палитра телевизора не переопределяла:
// --color-table-header/--color-table-stripe/--color-num/--color-mix-base. Без них
// строки таблицы наследовали СВЕТЛЫЕ значения этих токенов с :root (globals.css не
// знает про наш вложенный тёмный style) — зебра рисовалась почти белой, а текст поверх
// нёс уже наш тёмный --color-text (почти белый) → нечитаемые «пустые» строки через одну
// (баг найден живым скриншотом при самопроверке). Добавлены явно в обеих темах.
type Theme = 'dark' | 'light';
const THEMES: Record<Theme, React.CSSProperties> = {
  dark: {
    '--color-bg': '#0B1220', '--color-bg-surface': '#121C2E', '--color-bg-hover': '#1A2740',
    '--color-border': '#243450', '--color-border-strong': '#33507E', '--color-text': '#F2F6FC',
    '--color-text-muted': '#8FA1BD', '--color-positive': '#5BC878', '--color-warning': '#FBBC04',
    '--color-negative': '#EA4335', '--color-accent': '#7FB9E8', '--color-accent-soft': '#1A2740',
    '--color-table-row-border': '#1C2A44', '--color-table-row-hover': '#1A2740', colorScheme: 'dark',
    '--color-table-header': '#16213A', '--color-table-stripe': '#141F35', '--color-num': '#F2F6FC',
    '--color-mix-base': '#121C2E', '--color-highlight-pct': '32%',
  } as React.CSSProperties,
  light: {
    '--color-bg': '#F6F8FA', '--color-bg-surface': '#FFFFFF', '--color-bg-hover': '#EDF5FC',
    '--color-border': '#E5E9EF', '--color-border-strong': '#AFD3F1', '--color-text': '#1A202C',
    '--color-text-muted': '#6B7280', '--color-positive': '#1E8E3E', '--color-warning': '#B26000',
    '--color-negative': '#D93025', '--color-accent': '#0069BE', '--color-accent-soft': '#EDF5FC',
    '--color-table-row-border': '#EEF1F5', '--color-table-row-hover': '#EDF5FC', colorScheme: 'light',
    '--color-table-header': '#EDF1F5', '--color-table-stripe': '#F3F6F9', '--color-num': '#1A202C',
    '--color-mix-base': '#FFFFFF', '--color-highlight-pct': '68%',
  } as React.CSSProperties,
};
const THEME_KEY = 'today-theme';

const TH = 'px-3 py-3 text-xs lg:text-[0.85vw] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider whitespace-nowrap';
const TD = 'px-3 py-2 lg:py-[0.7vw] text-sm lg:text-[1.15vw] whitespace-nowrap tabular-nums';

interface DashboardViewProps {
  /** GET-эндпоинт, отдающий TvDashboard. */
  apiUrl: string;
  /** GET-эндпоинт списка сделок drill-down (задача #6465) — те же права/scope, что у apiUrl. */
  dealsApiUrl: string;
  /** Ключ react-query — разный у /today и /rop, чтобы не делить кэш между разными скоупами. */
  queryKey: string;
  /** Заголовок h1. */
  title: string;
  /** Хвост подписи под датой/временем обновления (после « · »). */
  subtitleSuffix: string;
}

export function TodayDashboard() {
  return (
    <DashboardView
      apiUrl="/api/tv/dashboard"
      dealsApiUrl="/api/tv/dashboard/deals"
      queryKey="tv-dashboard"
      title="Сегодня по компании"
      subtitleSuffix="продажи и брони за день, план дня по менеджерам"
    />
  );
}

/** /rop (задача #6446) — та же вёрстка, что у TodayDashboard, эндпоинт уже режет данные по правам. */
export function RopDashboard() {
  return (
    <DashboardView
      apiUrl="/api/rop/dashboard"
      dealsApiUrl="/api/rop/dashboard/deals"
      queryKey="rop-dashboard"
      title="Сегодня"
      subtitleSuffix="продажи и брони за день, план дня по менеджерам"
    />
  );
}

/** Имя узла дерева дашборда по id (для заголовка drill-down панели) — поиск в уже
 *  загруженных данных, БЕЗ похода на сервер: то же дерево, что рисует таблица. */
function findDashNodeName(node: TvDashNode, id: string): string | null {
  if (node.id === id) return node.name;
  for (const c of node.children) {
    const found = findDashNodeName(c, id);
    if (found) return found;
  }
  return null;
}

function DashboardView({ apiUrl, dealsApiUrl, queryKey, title, subtitleSuffix }: DashboardViewProps) {
  const { data, isLoading, error, refetch, isFetching } = useQuery<Dash>({
    queryKey: [queryKey],
    queryFn: async () => {
      const r = await fetch(apiUrl);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as Dash;
    },
    refetchInterval: 30_000,
  });
  const [tab, setTab] = useState<string>('root');
  const [showIdle, setShowIdle] = useState(false);
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') setTheme(t); } catch { /* приватный режим */ }
  }, []);
  const toggleTheme = () => setTheme(t => { const n: Theme = t === 'dark' ? 'light' : 'dark'; try { localStorage.setItem(THEME_KEY, n); } catch { /* ignore */ } return n; });

  // Drill-down «Продажи»/«Брони» → список сделок (задача #6465). Состояние — в URL
  // (?dd=sales|book&node=<id> ИЛИ &manager=<id>), не в useState: открытую панель
  // можно переслать ссылкой, «назад» браузера закрывает её как обычную навигацию.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const ddKind = searchParams.get('dd');
  const ddNode = searchParams.get('node');
  const ddManager = searchParams.get('manager');
  const openDrill = (kind: DrilldownKind, sel: { node?: string; manager?: string }) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('dd', kind);
    if (sel.manager) { params.set('manager', sel.manager); params.delete('node'); }
    else {
      // sel.node — реальный id узла дерева (TvDashNode.id, uuid/'branch:spb' — НЕ
      // синтетический id вкладки 'root' из tabs выше). Все вызовы ниже (Kpis/
      // NodeRows) передают node.id явно; без него backend САМ трактует отсутствие
      // node как «корень целиком» (resolveDrilldownSelection(dash, null, null)) —
      // подставлять сюда строку-заглушку не нужно и опасно (не совпадёт ни с одним
      // настоящим id дерева, drill вернётся пустым).
      if (sel.node) params.set('node', sel.node); else params.delete('node');
      params.delete('manager');
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const closeDrill = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('dd'); params.delete('node'); params.delete('manager');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const drillTarget: DashboardDrilldownTarget | null = useMemo(() => {
    if (ddKind !== 'sales' && ddKind !== 'book') return null;
    if (!ddNode && !ddManager) return null;
    if (ddManager) return { kind: ddKind, managerId: ddManager, label: data?.managers[ddManager]?.name ?? '…' };
    const id = ddNode ?? 'root';
    return { kind: ddKind, nodeId: id, label: (data && findDashNodeName(data.root, id)) ?? '…' };
  }, [ddKind, ddNode, ddManager, data]);

  const tabs = useMemo(() => {
    if (!data) return [];
    const root = data.root;
    const kids = root.kind === 'root' ? root.children : [];
    return [{ id: 'root', name: root.kind === 'root' && root.id !== 'scope' ? 'Итого' : root.name, node: root }, ...kids.map(k => ({ id: k.id, name: k.name, node: k }))];
  }, [data]);
  const current = tabs.find(t => t.id === tab)?.node ?? data?.root;

  return (
    <div className="h-dvh overflow-y-auto overflow-x-hidden bg-[var(--color-bg)] text-[var(--color-text)]" style={THEMES[theme]}>
      <div className="p-3 sm:p-6 lg:px-[2vw] lg:py-[1.5vw] flex flex-col gap-4 lg:gap-[1.2vw]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg sm:text-xl lg:text-[2vw] font-semibold leading-tight">{title}</h1>
            <div className="text-xs lg:text-[0.9vw] text-[var(--color-text-muted)]">
              {data ? `${data.day} · обновлено ${new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '…'} · {subtitleSuffix}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowIdle(v => !v)} className="inline-flex items-center gap-1.5 min-h-9 lg:min-h-[2.6vw] px-3 lg:px-[1vw] rounded-lg border border-[var(--color-border)] text-sm lg:text-[1vw] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              {showIdle ? <EyeOff size={14} /> : <Eye size={14} />} {showIdle ? 'Скрыть без движения' : 'Показать всех'}
            </button>
            <button onClick={toggleTheme} className="tap-target p-2 lg:p-[0.6vw] rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button onClick={() => refetch()} className="tap-target p-2 lg:p-[0.6vw] rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Обновить">
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--color-bg-hover)] w-fit max-w-full">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`min-h-9 lg:min-h-[2.8vw] px-3 lg:px-[1.4vw] rounded-md text-sm lg:text-[1.15vw] whitespace-nowrap ${tab === t.id ? 'bg-[var(--color-bg-surface)] font-semibold shadow-sm text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {t.name}
              </button>
            ))}
          </div>
        )}

        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Считаем…</div>}
        {error && <div className="text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}

        {data && current && (
          <>
            <Kpis node={current} onDrill={openDrill} />
            <div className="scroll-x rounded-lg lg:rounded-[0.8vw] border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left">
                    <th className={TH}>Узел / менеджер</th>
                    <th className={`${TH} text-right`}>План</th>
                    <th className={`${TH} text-right`}>Факт</th>
                    <th className={`${TH} text-right`}>%</th>
                    <th className={`${TH} text-right`}>Продажи / цель</th>
                    <th className={`${TH} text-right`}>Брони, ₽</th>
                    <th className={`${TH} text-right`}>Брони / цель</th>
                    <th className={`${TH} text-right`}>Активных</th>
                  </tr>
                </thead>
                <tbody>
                  {current.children.length === 0 && current.directManagerIds.length === 0 && (
                    <tr><td colSpan={8} className={`${TD} text-[var(--color-text-muted)]`}>Нет данных</td></tr>
                  )}
                  {current.children.map(c => <NodeRows key={c.id} node={c} depth={0} managers={data.managers} target={data.dailyTarget} showIdle={showIdle} defaultOpen={false} onDrill={openDrill} />)}
                  {current.directManagerIds.length > 0 && (
                    <ManagerRows ids={current.directManagerIds} depth={0} managers={data.managers} target={data.dailyTarget} showIdle={showIdle} onDrill={openDrill} />
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs lg:text-[0.9vw] text-[var(--color-text-muted)]">
              Активный менеджер — была заявка, бронь или продажа сегодня. Цель продаж и цель броней считаются отдельно: {data.dailyTarget} в день на менеджера, для узла — активные × {data.dailyTarget}. Без переключателя «Показать всех» менеджеры без движения скрыты. Клик по числу продаж/броней раскрывает список сделок.
            </div>
          </>
        )}
      </div>
      {drillTarget && <DashboardDrilldownPanel apiUrl={dealsApiUrl} target={drillTarget} onClose={closeDrill} />}
    </div>
  );
}

type DrillOpener = (kind: DrilldownKind, sel: { node?: string; manager?: string }) => void;

function Kpis({ node, onDrill }: { node: TvDashNode; onDrill: DrillOpener }) {
  const p = pctOf(node.factDay, node.planDay);
  const items: { l: string; v: React.ReactNode; cls?: string }[] = [
    { l: 'План дня', v: fmtMoney(node.planDay) },
    { l: 'Факт продаж', v: fmtMoney(node.factDay), cls: 'text-[var(--color-positive)]' },
    { l: 'Выполнение', v: p == null ? '—' : `${p}%`, cls: p != null && p >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-warning)]' },
    { l: 'Продажи, шт / цель', v: <Pb pb={node.salesCount} target={node.target} onClick={() => onDrill('sales', { node: node.id })} /> },
    { l: 'Брони', v: fmtMoney(node.bookSum), cls: 'text-[var(--color-accent)]' },
    { l: 'Брони, шт / цель', v: <Pb pb={node.bookCount} target={node.target} onClick={() => onDrill('book', { node: node.id })} /> },
    { l: 'Активных / всего', v: <>{node.activeManagers} <span className="text-sm lg:text-[1vw] font-normal text-[var(--color-text-muted)]">/ {node.managerCount}</span></> },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2 lg:gap-[0.9vw]">
      {items.map(it => (
        <div key={it.l} className="rounded-lg lg:rounded-[0.8vw] border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 lg:px-[1.3vw] lg:py-[1.1vw] min-w-0 flex flex-col gap-1 lg:gap-[0.5vw]">
          <div className="text-[11px] lg:text-[0.8vw] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider truncate">{it.l}</div>
          <div className={`text-lg lg:text-[1.7vw] font-bold tabular-nums leading-tight whitespace-nowrap ${it.cls ?? ''}`}>{it.v}</div>
        </div>
      ))}
    </div>
  );
}

function NodeRows({ node, depth, managers, target, showIdle, defaultOpen, onDrill }: {
  node: TvDashNode; depth: number; managers: Record<string, TvDashManager>; target: number; showIdle: boolean; defaultOpen: boolean; onDrill: DrillOpener;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [people, setPeople] = useState(false); // «люди узла» на любом уровне
  const hasKids = node.children.length > 0;
  const expandable = hasKids || node.directManagerIds.length > 0;
  return (
    <>
      <tr className="report-row border-b border-[var(--color-table-row-border)] hover:bg-[var(--color-table-row-hover)]">
        <td className={TD} style={{ paddingLeft: 8 + depth * 18 }}>
          <div className="flex items-center gap-1 min-w-0">
            {expandable ? (
              <button onClick={() => setOpen(o => !o)} className="tap-target p-0.5 text-[var(--color-text-muted)]" aria-label={open ? 'Свернуть' : 'Развернуть'}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
            ) : <span className="w-[19px] shrink-0" />}
            <button onClick={() => { if (expandable) setOpen(o => !o); }} className={`truncate text-left ${node.kind === 'dept' ? 'font-medium' : 'font-semibold'}`}>{node.name}</button>
            {hasKids && (
              <button onClick={() => { setPeople(v => !v); setOpen(true); }} title={people ? 'Показать подузлы' : 'Показать менеджеров узла'}
                className={`tap-target ml-1 p-0.5 rounded ${people ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                <Users size={13} />
              </button>
            )}
          </div>
        </td>
        <td className={`${TD} text-right`}>{fmtMoney(node.planDay)}</td>
        <td className={`${TD} text-right font-semibold text-[var(--color-positive)]`}>{fmtMoney(node.factDay)}</td>
        <td className={`${TD} text-right`}><Pct fact={node.factDay} plan={node.planDay} /></td>
        <td className={`${TD} text-right`}><Pb pb={node.salesCount} target={node.target} onClick={() => onDrill('sales', { node: node.id })} /></td>
        <td className={`${TD} text-right text-[var(--color-accent)]`}>{fmtMoney(node.bookSum)}</td>
        <td className={`${TD} text-right`}><Pb pb={node.bookCount} target={node.target} onClick={() => onDrill('book', { node: node.id })} /></td>
        <td className={`${TD} text-right`}>{node.activeManagers}<span className="text-[var(--color-text-muted)]"> / {node.managerCount}</span></td>
      </tr>
      {open && (people || !hasKids
        ? <ManagerRows ids={people ? node.allManagerIds : node.directManagerIds} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} onDrill={onDrill} />
        : <>
            {node.children.map(c => <NodeRows key={c.id} node={c} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} defaultOpen={false} onDrill={onDrill} />)}
            {node.directManagerIds.length > 0 && <ManagerRows ids={node.directManagerIds} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} onDrill={onDrill} />}
          </>
      )}
    </>
  );
}

function ManagerRows({ ids, depth, managers, target, showIdle, onDrill }: {
  ids: string[]; depth: number; managers: Record<string, TvDashManager>; target: number; showIdle: boolean; onDrill: DrillOpener;
}) {
  const rows = ids.map(id => managers[id]).filter((m): m is TvDashManager => !!m)
    .filter(m => showIdle || m.active)
    .sort((a, b) => b.salesSum - a.salesSum || b.bookSum - a.bookSum || a.name.localeCompare(b.name, 'ru'));
  const hidden = ids.length - rows.length;
  return (
    <>
      {rows.map(m => (
        <tr key={m.id} className="border-b border-[var(--color-table-row-border)] hover:bg-[var(--color-table-row-hover)]">
          <td className={TD} style={{ paddingLeft: 8 + depth * 18 + 19 }}>
            <div className="flex items-center gap-2 min-w-0">
              {m.avatar
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={m.avatar} alt="" className="w-6 h-6 lg:w-[1.8vw] lg:h-[1.8vw] rounded-full object-cover shrink-0" />
                : <span className="w-6 h-6 lg:w-[1.8vw] lg:h-[1.8vw] rounded-full bg-[var(--color-accent-soft)] text-[10px] lg:text-[0.7vw] font-semibold flex items-center justify-center shrink-0">{m.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join('')}</span>}
              <span className={`truncate ${m.active ? '' : 'text-[var(--color-text-muted)]'}`}>{m.name}</span>
              {m.dealsCount > 0 && <span className="text-[10px] lg:text-[0.8vw] text-[var(--color-text-muted)] shrink-0">заявок {m.dealsCount}</span>}
            </div>
          </td>
          <td className={`${TD} text-right`}>{fmtMoney(m.plan)}</td>
          <td className={`${TD} text-right font-semibold ${m.salesSum > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)]'}`}>{fmtMoney(m.salesSum)}</td>
          <td className={`${TD} text-right`}><Pct fact={m.salesSum} plan={m.plan} /></td>
          <td className={`${TD} text-right`}><Pb pb={m.salesCount} target={target} onClick={() => onDrill('sales', { manager: m.id })} /></td>
          <td className={`${TD} text-right text-[var(--color-accent)]`}>{fmtMoney(m.bookSum)}</td>
          <td className={`${TD} text-right`}><Pb pb={m.bookCount} target={target} onClick={() => onDrill('book', { manager: m.id })} /></td>
          <td className={`${TD} text-right text-[var(--color-text-muted)]`}>{m.active ? 'активен' : '—'}</td>
        </tr>
      ))}
      {hidden > 0 && (
        <tr><td colSpan={8} className={`${TD} !text-xs lg:!text-[0.85vw] text-[var(--color-text-muted)]`} style={{ paddingLeft: 8 + depth * 18 + 19 }}>ещё {hidden} без движения скрыто</td></tr>
      )}
    </>
  );
}
