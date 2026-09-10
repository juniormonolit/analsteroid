'use client';
// Фаза 0 движка диагностики — экран проверок данных (ТЗ №1 §12). Запуск по одной или
// всех, таблицы результатов, копирование JSON. Только супер-админ.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Copy, Check, AlertTriangle, XCircle, CheckCircle2, Loader2 } from 'lucide-react';

interface CheckResult { key: string; title: string; status: 'ok' | 'warn' | 'error'; note: string; rows: Record<string, unknown>[]; ms: number }

const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const STATUS = {
  ok:    { Icon: CheckCircle2, cls: 'text-[var(--color-positive)]', label: 'ок' },
  warn:  { Icon: AlertTriangle, cls: 'text-[var(--color-warning)]', label: 'внимание' },
  error: { Icon: XCircle, cls: 'text-[var(--color-negative)]', label: 'ошибка' },
};

export function DiagChecksPage() {
  const { data: list } = useQuery<{ checks: { key: string; title: string }[] }>({
    queryKey: ['diag-checks-list'], queryFn: () => fetch('/api/diag/checks?list=1').then(r => r.json()), staleTime: Infinity,
  });
  const [results, setResults] = useState<Record<string, CheckResult>>({});
  // Последние сохранённые результаты — чтобы экран не был пустым при повторном открытии.
  useQuery<{ results: CheckResult[] }>({
    queryKey: ['diag-checks-last'], staleTime: Infinity, refetchOnWindowFocus: false,
    queryFn: async () => {
      const body = await fetch('/api/diag/checks?last=1').then(r => r.json()) as { results: CheckResult[] };
      setResults(prev => { const next = { ...prev }; for (const r of body.results ?? []) if (!next[r.key]) next[r.key] = r; return next; });
      return body;
    },
  });
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const run = async (keys: string[]) => {
    setRunning(prev => new Set([...prev, ...keys]));
    try {
      const res = await fetch(`/api/diag/checks?only=${keys.join(',')}`);
      const body = await res.json() as { results?: CheckResult[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setResults(prev => { const next = { ...prev }; for (const r of body.results ?? []) next[r.key] = r; return next; });
    } catch (e) {
      setResults(prev => { const next = { ...prev }; for (const k of keys) next[k] = { key: k, title: list?.checks.find(c => c.key === k)?.title ?? k, status: 'error', note: e instanceof Error ? e.message : String(e), rows: [], ms: 0 }; return next; });
    } finally { setRunning(prev => { const next = new Set(prev); keys.forEach(k => next.delete(k)); return next; }); }
  };
  const runAll = async () => { for (const c of list?.checks ?? []) await run([c.key]); }; // последовательно — SA-БД не любит параллельные тяжёлые запросы

  const copyAll = () => {
    void navigator.clipboard.writeText(JSON.stringify(Object.values(results), null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="p-3 sm:p-6 max-w-6xl flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-[var(--color-text)]">Диагностика · фаза 0: проверки данных</h1>
          <p className="text-[12px] text-[var(--color-text-muted)]">ТЗ №1 §12. Каждая проверка — живой запрос к sa/va, может идти до минуты. Результат копируется целиком кнопкой справа и дублируется в лог сервера.</p>
        </div>
        <div className="flex gap-2">
          <button className={btnCls} onClick={copyAll} disabled={!Object.keys(results).length}>{copied ? <Check size={14} /> : <Copy size={14} />} Скопировать JSON</button>
          <button className={btnPrimaryCls} onClick={runAll} disabled={running.size > 0 || !list}><Play size={14} /> Запустить все</button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {list?.checks.map(c => {
          const r = results[c.key];
          const isRunning = running.has(c.key);
          const st = r ? STATUS[r.status] : null;
          return (
            <section key={c.key} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                {isRunning ? <Loader2 size={16} className="animate-spin text-[var(--color-text-muted)]" /> : st ? <st.Icon size={16} className={st.cls} /> : <span className="h-4 w-4 rounded-full border border-[var(--color-border)]" />}
                <h2 className="text-sm font-bold text-[var(--color-text)]">{c.title}</h2>
                {r && <span className="text-[11px] text-[var(--color-text-muted)]">{(r.ms / 1000).toFixed(1)} с · строк {r.rows.length}</span>}
                <button className={`${btnCls} ml-auto !min-h-9`} onClick={() => run([c.key])} disabled={isRunning}><Play size={13} /> {r ? 'Повторить' : 'Запустить'}</button>
              </div>
              {r && <p className={`mt-2 text-sm leading-relaxed ${r.status === 'error' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>{r.note}</p>}
              {r && r.rows.length > 0 && <RowsTable rows={r.rows} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function RowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [open, setOpen] = useState(rows.length <= 40);
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach(k => s.add(k)); return s; }, new Set<string>()));
  return (
    <div className="mt-2">
      {!open ? <button className="text-[12px] text-[var(--color-accent)] hover:underline" onClick={() => setOpen(true)}>Показать {rows.length} строк</button> : (
        <div className="scroll-x max-h-[480px] overflow-y-auto rounded-xl border border-[var(--color-border)]">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-[var(--color-bg-hover)] text-[10.5px] uppercase tracking-wide text-[var(--color-text-muted)]">
              <tr>{cols.map(c => <th key={c} className="px-2 py-1.5 text-left whitespace-nowrap">{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-[var(--color-border)]">
                  {cols.map(c => <td key={c} className="px-2 py-1 whitespace-nowrap tabular-nums text-[var(--color-text)]">{r[c] === null || r[c] === undefined ? '—' : String(r[c])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
