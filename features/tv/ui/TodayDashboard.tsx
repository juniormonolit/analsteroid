'use client';
// Дашборд «Сегодня по компании» (правка владельца 08.09): отдельный URL /today без меню.
// Вкладки — Итого и филиалы; KPI выбранного узла; дерево департаменты → отделы → менеджеры
// с раскрытием. Данные — /api/tv/dashboard (тот же движок, что у телевизоров), 30 с.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Eye, EyeOff, RefreshCw, Users } from 'lucide-react';
import type { TvDashManager, TvDashNode, TvDashboard as Dash } from '../engine/dashboard';

const fmtMoney = (v: number): string => {
  if (v >= 1e6) return `${(v / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн ₽`;
  if (v >= 1e4) return `${Math.round(v / 1e3).toLocaleString('ru-RU')} тыс ₽`;
  return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
};
const pctOf = (fact: number, plan: number): number | null => (plan > 0 ? Math.round((fact / plan) * 100) : null);

function Pct({ fact, plan }: { fact: number; plan: number }) {
  const p = pctOf(fact, plan);
  if (p == null) return <span className="text-[var(--color-text-muted)]">—</span>;
  return <span className={`font-semibold ${p >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-warning)]'}`}>{p}%</span>;
}
function Pb({ pb, target }: { pb: number; target: number }) {
  const ok = target > 0 && pb >= target;
  return <span className={`font-semibold tabular-nums ${ok ? 'text-[var(--color-positive)]' : target > 0 ? 'text-[var(--color-warning)]' : 'text-[var(--color-text-muted)]'}`}>{pb}<span className="text-[var(--color-text-muted)] font-normal"> / {target}</span></span>;
}

const TH = 'px-2 py-2 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider whitespace-nowrap';
const TD = 'px-2 py-1.5 text-sm whitespace-nowrap tabular-nums';

export function TodayDashboard() {
  const { data, isLoading, error, refetch, isFetching } = useQuery<Dash>({
    queryKey: ['tv-dashboard'],
    queryFn: async () => {
      const r = await fetch('/api/tv/dashboard');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      return j as Dash;
    },
    refetchInterval: 30_000,
  });
  const [tab, setTab] = useState<string>('root');
  const [showIdle, setShowIdle] = useState(false);

  const tabs = useMemo(() => {
    if (!data) return [];
    const root = data.root;
    const kids = root.kind === 'root' ? root.children : [];
    return [{ id: 'root', name: root.kind === 'root' && root.id !== 'scope' ? 'Итого' : root.name, node: root }, ...kids.map(k => ({ id: k.id, name: k.name, node: k }))];
  }, [data]);
  const current = tabs.find(t => t.id === tab)?.node ?? data?.root;

  return (
    <div className="h-dvh overflow-y-auto overflow-x-hidden">
      <div className="p-3 sm:p-6 max-w-7xl mx-auto flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg sm:text-xl font-semibold">Сегодня по компании</h1>
            <div className="text-xs text-[var(--color-text-muted)]">
              {data ? `${data.day} · обновлено ${new Date(data.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : '…'} · продажи и брони за день, план дня по менеджерам
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowIdle(v => !v)} className="inline-flex items-center gap-1.5 min-h-9 px-3 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              {showIdle ? <EyeOff size={14} /> : <Eye size={14} />} {showIdle ? 'Скрыть без движения' : 'Показать всех'}
            </button>
            <button onClick={() => refetch()} className="tap-target p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Обновить">
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--color-bg-hover)] w-fit max-w-full">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`min-h-9 px-3 rounded-md text-sm whitespace-nowrap ${tab === t.id ? 'bg-[var(--color-bg-surface)] font-medium shadow-sm text-[var(--color-text)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {t.name}
              </button>
            ))}
          </div>
        )}

        {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Считаем…</div>}
        {error && <div className="text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}

        {data && current && (
          <>
            <Kpis node={current} />
            <div className="scroll-x rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
              <table className="w-full min-w-[820px] border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left">
                    <th className={TH}>Узел / менеджер</th>
                    <th className={`${TH} text-right`}>План</th>
                    <th className={`${TH} text-right`}>Факт</th>
                    <th className={`${TH} text-right`}>%</th>
                    <th className={`${TH} text-right`}>Продаж</th>
                    <th className={`${TH} text-right`}>Брони</th>
                    <th className={`${TH} text-right`}>Шт</th>
                    <th className={`${TH} text-right`}>Продажеброней</th>
                    <th className={`${TH} text-right`}>Активных</th>
                  </tr>
                </thead>
                <tbody>
                  {current.children.length === 0 && current.directManagerIds.length === 0 && (
                    <tr><td colSpan={9} className={`${TD} text-[var(--color-text-muted)]`}>Нет данных</td></tr>
                  )}
                  {current.children.map(c => <NodeRows key={c.id} node={c} depth={0} managers={data.managers} target={data.dailyTarget} showIdle={showIdle} defaultOpen={false} />)}
                  {current.directManagerIds.length > 0 && (
                    <ManagerRows ids={current.directManagerIds} depth={0} managers={data.managers} target={data.dailyTarget} showIdle={showIdle} />
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              Активный менеджер — была заявка, бронь или продажа сегодня. Цель бронепродаж = активные × {data.dailyTarget}. Без переключателя «Показать всех» менеджеры без движения скрыты.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Kpis({ node }: { node: TvDashNode }) {
  const p = pctOf(node.factDay, node.planDay);
  const items: { l: string; v: React.ReactNode; cls?: string }[] = [
    { l: 'План дня', v: fmtMoney(node.planDay) },
    { l: 'Факт продаж', v: fmtMoney(node.factDay), cls: 'text-[var(--color-positive)]' },
    { l: 'Выполнение', v: p == null ? '—' : `${p}%`, cls: p != null && p >= 100 ? 'text-[var(--color-positive)]' : 'text-[var(--color-warning)]' },
    { l: 'Продаж, шт', v: node.salesCount },
    { l: 'Брони', v: <>{fmtMoney(node.bookSum)} <span className="text-sm font-normal text-[var(--color-text-muted)]">{node.bookCount} шт</span></>, cls: 'text-[var(--color-accent)]' },
    { l: 'Продажеброней', v: <Pb pb={node.pb} target={node.target} /> },
    { l: 'Активных / всего', v: <>{node.activeManagers} <span className="text-sm font-normal text-[var(--color-text-muted)]">/ {node.managerCount}</span></> },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
      {items.map(it => (
        <div key={it.l} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2 min-w-0">
          <div className="text-[11px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider truncate">{it.l}</div>
          <div className={`text-lg font-semibold tabular-nums truncate ${it.cls ?? ''}`}>{it.v}</div>
        </div>
      ))}
    </div>
  );
}

function NodeRows({ node, depth, managers, target, showIdle, defaultOpen }: {
  node: TvDashNode; depth: number; managers: Record<string, TvDashManager>; target: number; showIdle: boolean; defaultOpen: boolean;
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
        <td className={`${TD} text-right`}>{node.salesCount}</td>
        <td className={`${TD} text-right text-[var(--color-accent)]`}>{fmtMoney(node.bookSum)}</td>
        <td className={`${TD} text-right`}>{node.bookCount}</td>
        <td className={`${TD} text-right`}><Pb pb={node.pb} target={node.target} /></td>
        <td className={`${TD} text-right`}>{node.activeManagers}<span className="text-[var(--color-text-muted)]"> / {node.managerCount}</span></td>
      </tr>
      {open && (people || !hasKids
        ? <ManagerRows ids={people ? node.allManagerIds : node.directManagerIds} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} />
        : <>
            {node.children.map(c => <NodeRows key={c.id} node={c} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} defaultOpen={false} />)}
            {node.directManagerIds.length > 0 && <ManagerRows ids={node.directManagerIds} depth={depth + 1} managers={managers} target={target} showIdle={showIdle} />}
          </>
      )}
    </>
  );
}

function ManagerRows({ ids, depth, managers, target, showIdle }: {
  ids: string[]; depth: number; managers: Record<string, TvDashManager>; target: number; showIdle: boolean;
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
                ? <img src={m.avatar} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
                : <span className="w-6 h-6 rounded-full bg-[var(--color-accent-soft)] text-[10px] font-semibold flex items-center justify-center shrink-0">{m.name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join('')}</span>}
              <span className={`truncate ${m.active ? '' : 'text-[var(--color-text-muted)]'}`}>{m.name}</span>
              {m.dealsCount > 0 && <span className="text-[10px] text-[var(--color-text-muted)] shrink-0">заявок {m.dealsCount}</span>}
            </div>
          </td>
          <td className={`${TD} text-right`}>{fmtMoney(m.plan)}</td>
          <td className={`${TD} text-right font-semibold ${m.salesSum > 0 ? 'text-[var(--color-positive)]' : 'text-[var(--color-text-muted)]'}`}>{fmtMoney(m.salesSum)}</td>
          <td className={`${TD} text-right`}><Pct fact={m.salesSum} plan={m.plan} /></td>
          <td className={`${TD} text-right`}>{m.salesCount}</td>
          <td className={`${TD} text-right text-[var(--color-accent)]`}>{fmtMoney(m.bookSum)}</td>
          <td className={`${TD} text-right`}>{m.bookCount}</td>
          <td className={`${TD} text-right`}><Pb pb={m.pb} target={target} /></td>
          <td className={`${TD} text-right text-[var(--color-text-muted)]`}>{m.active ? 'активен' : '—'}</td>
        </tr>
      ))}
      {hidden > 0 && (
        <tr><td colSpan={9} className={`${TD} text-xs text-[var(--color-text-muted)]`} style={{ paddingLeft: 8 + depth * 18 + 19 }}>ещё {hidden} без движения скрыто</td></tr>
      )}
    </>
  );
}
