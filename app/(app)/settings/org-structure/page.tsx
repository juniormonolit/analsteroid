'use client';
import { useState, useEffect, useCallback } from 'react';

// Раздел «Оргструктура» (задача Серёги 13.07): кто в каком отделе (дерево sa.departments
// + сотрудники) и кто чем руководит (sa.user_departments). Плюс кнопка ручного синка
// из Битрикса. Только админ. Данные читаются из схемы sa (независимость от system).

interface Employee { id: string; name: string; login: string | null; branch: string | null }
interface DeptNode {
  id: string; bitrixId: string; name: string; parentBitrixId: string | null;
  employees: Employee[]; children: DeptNode[];
}
interface Supervisor { userId: string; userName: string; departments: { id: string; name: string }[] }
interface Branch { code: string; short_name: string; full_name: string; sort_order: number }
interface OrgData {
  branches: Branch[];
  tree: DeptNode[];
  noDept: Employee[];
  supervisors: Supervisor[];
  stats: { departments: number; employees: number; supervisors: number };
}

function countSubtree(node: DeptNode): number {
  return node.employees.length + node.children.reduce((acc, c) => acc + countSubtree(c), 0);
}

function DeptTree({ node, depth, branchFull }: { node: DeptNode; depth: number; branchFull: Map<string, string> }) {
  const [open, setOpen] = useState(depth < 1);
  const total = countSubtree(node);
  const hasChildren = node.children.length > 0 || node.employees.length > 0;

  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 14 }} className={depth === 0 ? '' : 'border-l border-[var(--color-border)] pl-3'}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full text-left py-1 group"
      >
        <span className="text-[var(--color-text-muted)] w-3 shrink-0 text-xs">{hasChildren ? (open ? '▾' : '▸') : '·'}</span>
        <span className="text-sm font-medium text-[var(--color-text)]">{node.name}</span>
        <span className="text-xs text-[var(--color-text-muted)]">{total > 0 ? `${total}` : ''}</span>
      </button>
      {open && (
        <div>
          {node.employees.map(e => (
            <div key={e.id} style={{ marginLeft: 14 }} className="flex items-center gap-2 py-0.5 pl-3 border-l border-[var(--color-border)]">
              <span className="text-sm text-[var(--color-text)]">{e.name}</span>
              {e.login && <span className="text-xs text-[var(--color-text-muted)]">{e.login}</span>}
              {e.branch && branchFull.has(e.branch) && (
                <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{branchFull.get(e.branch)}</span>
              )}
            </div>
          ))}
          {node.children
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
            .map(c => <DeptTree key={c.id} node={c} depth={depth + 1} branchFull={branchFull} />)}
        </div>
      )}
    </div>
  );
}

export default function OrgStructurePage() {
  const [data, setData] = useState<OrgData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch('/api/admin/org-structure')
      .then(r => r.json())
      .then((d: OrgData) => setData(d))
      .catch(() => setMessage({ type: 'error', text: 'Не удалось загрузить оргструктуру' }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runSync() {
    setSyncing(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/org-sync', { method: 'POST' });
      const d = await res.json();
      if (!res.ok || d.ok === false) {
        setMessage({ type: 'error', text: d.error ?? 'Синхронизация не удалась' });
      } else {
        setMessage({
          type: 'success',
          text: `Синхронизировано: отделов ${d.departments}, сотрудников ${d.managers}` +
            (d.renamed ? `, переименований ${d.renamed}` : '') + `, за ${(d.ms / 1000).toFixed(1)} с`,
        });
        load();
      }
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
    } finally {
      setSyncing(false);
    }
  }

  // raw branch label ('СПб', 'Москва/МО', ...) → полное имя (для дашборда — полное).
  const branchFull = new Map<string, string>();
  const rawToFull: Record<string, string> = {
    'СПб': 'Санкт-Петербург', 'Москва/МО': 'Москва', 'Краснодар': 'Краснодар', 'Екатеринбург': 'Екатеринбург',
  };
  for (const k of Object.keys(rawToFull)) branchFull.set(k, rawToFull[k]);

  return (
    <div className="p-3 sm:p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Оргструктура</h1>
        <button
          onClick={runSync}
          disabled={syncing}
          className="px-4 py-1.5 text-sm rounded bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {syncing ? 'Синхронизация…' : 'Синхронизировать'}
        </button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">
        Данные сотрудников и отделов тянутся из Битрикса в базу sa. «Синхронизировать» обновляет их вручную (та же
        логика, что и ночной автосинк).
      </p>

      {message && (
        <p className={`mb-4 text-sm ${message.type === 'success' ? 'text-green-600' : 'text-red-500'}`}>{message.text}</p>
      )}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">Загрузка…</p>
      ) : !data ? (
        <p className="text-sm text-[var(--color-text-muted)]">Нет данных.</p>
      ) : (
        <div className="space-y-6">
          <div className="text-xs text-[var(--color-text-muted)]">
            Отделов: {data.stats.departments} · Сотрудников: {data.stats.employees} · Руководителей: {data.stats.supervisors}
          </div>

          {/* Филиалы: короткое имя = метка, полное — рядом (в дашборде используем полное). */}
          {data.branches.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Филиалы</h2>
              <div className="flex flex-wrap gap-2">
                {data.branches.map(b => (
                  <span key={b.code} className="text-xs rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)]">
                    <span className="font-medium text-[var(--color-text)]">{b.short_name}</span> — {b.full_name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Кто в каком отделе. */}
          <section>
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Кто в каком отделе</h2>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 space-y-1">
              {data.tree
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
                .map(n => <DeptTree key={n.id} node={n} depth={0} branchFull={branchFull} />)}
              {data.noDept.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
                  <div className="text-sm font-medium text-[var(--color-text-muted)] mb-1">Без отдела ({data.noDept.length})</div>
                  {data.noDept.map(e => (
                    <div key={e.id} className="flex items-center gap-2 py-0.5 pl-3">
                      <span className="text-sm text-[var(--color-text)]">{e.name}</span>
                      {e.login && <span className="text-xs text-[var(--color-text-muted)]">{e.login}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Кто чем руководит (user_departments, «Руководит»). */}
          <section>
            <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">Кто чем руководит</h2>
            {data.supervisors.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Назначений пока нет. Задаются в разделе «Пользователи» → «Руководит».</p>
            ) : (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] divide-y divide-[var(--color-border)]">
                {data.supervisors.map(s => (
                  <div key={s.userId} className="px-4 py-2">
                    <div className="text-sm font-medium text-[var(--color-text)]">{s.userName}</div>
                    <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      {s.departments.map(d => d.name).join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
