'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowUp, ArrowDown, ChevronsUpDown, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';

const BITRIX_BASE = 'https://td.monolit-crm.ru/crm/deal/details';

const DEFAULT_SORT: Record<string, { col: string; dir: 'asc' | 'desc' }> = {
  deals:       { col: 'deal_id',  dir: 'desc' },
  deal_events: { col: 'event_at', dir: 'desc' },
};

interface TableMeta { name: string; count: number; }
interface TableData {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  sortCol: string;
  sortDir: 'asc' | 'desc';
}

export default function TablesPage() {
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [data, setData] = useState<TableData | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [sortCol, setSortCol] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const filterTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const limit = 50;

  useEffect(() => {
    fetch('/api/settings/tables')
      .then(r => r.json())
      .then((rows: TableMeta[]) => { setTables(rows); setTablesLoading(false); })
      .catch(() => setTablesLoading(false));
  }, []);

  const loadData = useCallback(
    (name: string, p: number, sc: string, sd: 'asc' | 'desc', f: Record<string, string>) => {
      setDataLoading(true);
      const params = new URLSearchParams({ page: String(p), limit: String(limit) });
      if (sc) { params.set('sortBy', sc); params.set('sortDir', sd); }
      for (const [col, val] of Object.entries(f)) {
        if (val.trim()) params.set(`filter_${col}`, val.trim());
      }
      fetch(`/api/settings/tables/${name}?${params}`)
        .then(r => r.json())
        .then((d: TableData) => { setData(d); setDataLoading(false); })
        .catch(() => setDataLoading(false));
    },
    []
  );

  function selectTable(name: string) {
    const def = DEFAULT_SORT[name] ?? { col: '', dir: 'desc' as const };
    setSelected(name);
    setSortCol(def.col);
    setSortDir(def.dir);
    setFilters({});
    setPage(1);
    loadData(name, 1, def.col, def.dir, {});
  }

  function handleSort(col: string) {
    if (!selected) return;
    const newDir: 'asc' | 'desc' = sortCol === col && sortDir === 'desc' ? 'asc' : 'desc';
    setSortCol(col);
    setSortDir(newDir);
    setPage(1);
    loadData(selected, 1, col, newDir, filters);
  }

  function handleFilter(col: string, val: string) {
    const next = { ...filters, [col]: val };
    setFilters(next);
    // Debounce 400ms
    if (filterTimers.current[col]) clearTimeout(filterTimers.current[col]);
    filterTimers.current[col] = setTimeout(() => {
      if (!selected) return;
      setPage(1);
      loadData(selected, 1, sortCol, sortDir, next);
    }, 400);
  }

  function handlePage(newPage: number) {
    if (!selected) return;
    setPage(newPage);
    loadData(selected, newPage, sortCol, sortDir, filters);
  }

  const totalPages = data ? Math.ceil(data.total / limit) : 0;

  function renderCell(col: string, row: Record<string, unknown>) {
    const val = row[col];

    // Bitrix deal link: deal_name in deals, deal_id in deal_events
    if (selected === 'deals' && col === 'deal_name' && row['deal_id'] != null) {
      return (
        <a
          href={`${BITRIX_BASE}/${row['deal_id']}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[var(--color-accent)] hover:underline"
        >
          <span className="truncate">{String(val ?? '')}</span>
          <ExternalLink size={11} className="shrink-0 opacity-70" />
        </a>
      );
    }
    if (selected === 'deal_events' && col === 'deal_id' && val != null) {
      return (
        <a
          href={`${BITRIX_BASE}/${val}/`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[var(--color-accent)] hover:underline"
        >
          {String(val)}
          <ExternalLink size={11} className="shrink-0 opacity-70" />
        </a>
      );
    }

    if (val === null || val === undefined)
      return <span className="text-[var(--color-text-muted)] italic text-xs">null</span>;
    if (typeof val === 'object')
      return <span className="font-mono text-xs">{JSON.stringify(val)}</span>;
    return String(val);
  }

  return (
    // Телефон: список таблиц — прокручиваемый блок сверху; md+: рейл слева
    <div className="flex flex-col md:flex-row h-full overflow-hidden">
      {/* Table list */}
      <div className="md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-[var(--color-border)] overflow-y-auto max-h-44 md:max-h-none bg-[var(--color-bg-surface)]">
        <div className="px-3 py-2.5 border-b border-[var(--color-border)]">
          <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Таблицы SA</p>
        </div>
        {tablesLoading ? (
          <div className="p-3 space-y-1.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-6 rounded bg-[var(--color-border)] animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="py-1">
            {tables.map(t => (
              <button
                key={t.name}
                onClick={() => selectTable(t.name)}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors text-left ${
                  selected === t.name
                    ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium'
                    : 'text-[var(--color-text)] hover:bg-[var(--color-border)]'
                }`}
              >
                <span className="truncate">{t.name}</span>
                <span className="text-xs ml-2 shrink-0 px-1.5 py-0.5 rounded-full bg-[var(--color-border)] text-[var(--color-text-muted)]">
                  {t.count >= 0 ? t.count.toLocaleString('ru-RU') : '—'}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Table viewer */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-[var(--color-text-muted)] text-sm">
            Выберите таблицу
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
              <h3 className="text-sm font-semibold text-[var(--color-text)]">{selected}</h3>
              {Object.values(filters).some(v => v.trim()) && (
                <button
                  onClick={() => {
                    setFilters({});
                    setPage(1);
                    loadData(selected, 1, sortCol, sortDir, {});
                  }}
                  className="text-xs text-[var(--color-accent)] hover:underline"
                >
                  Сбросить фильтры
                </button>
              )}
              {data && (
                <span className="text-xs text-[var(--color-text-muted)] ml-auto">
                  {data.total.toLocaleString('ru-RU')} строк
                </span>
              )}
            </div>

            {/* Data grid */}
            <div className="flex-1 overflow-auto">
              {dataLoading && !data ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="h-7 rounded bg-[var(--color-border)] animate-pulse" />
                  ))}
                </div>
              ) : data ? (
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
                    {/* Column names + sort */}
                    <tr>
                      {data.columns.map(col => (
                        <th
                          key={col}
                          className="text-left px-2 py-1.5 font-medium text-[var(--color-text)] border-b border-r border-[var(--color-border)] whitespace-nowrap cursor-pointer hover:bg-[var(--color-border)] select-none"
                          onClick={() => handleSort(col)}
                        >
                          <div className="flex items-center gap-1">
                            <span className="truncate">{col}</span>
                            {sortCol === col
                              ? sortDir === 'desc'
                                ? <ArrowDown size={12} className="shrink-0 text-[var(--color-accent)]" />
                                : <ArrowUp size={12} className="shrink-0 text-[var(--color-accent)]" />
                              : <ChevronsUpDown size={11} className="shrink-0 opacity-30" />
                            }
                          </div>
                        </th>
                      ))}
                    </tr>
                    {/* Filter inputs */}
                    <tr className="bg-[var(--color-bg-surface)]">
                      {data.columns.map(col => (
                        <th key={col} className="px-1 py-1 border-b border-r border-[var(--color-border)]">
                          <input
                            value={filters[col] ?? ''}
                            onChange={e => handleFilter(col, e.target.value)}
                            placeholder="фильтр…"
                            className="w-full px-1.5 py-0.5 text-xs rounded border border-[var(--color-border)] bg-transparent text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:border-[var(--color-accent)] min-w-[60px]"
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={dataLoading ? 'opacity-50' : ''}>
                    {data.rows.map((row, i) => (
                      <tr
                        key={i}
                        className={`border-b border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                      >
                        {data.columns.map(col => (
                          <td
                            key={col}
                            className="px-2 py-1 border-r border-[var(--color-border)] max-w-xs text-[var(--color-text)] overflow-hidden"
                            style={{ maxWidth: '260px' }}
                          >
                            <div className="truncate">
                              {renderCell(col, row)}
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>

            {/* Pagination */}
            {data && totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
                <span className="text-xs text-[var(--color-text-muted)]">
                  Страница {page} из {totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handlePage(Math.max(1, page - 1))}
                    disabled={page <= 1}
                    className="p-1 rounded hover:bg-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-text)]"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="px-2 text-xs text-[var(--color-text-muted)]">{page}</span>
                  <button
                    onClick={() => handlePage(Math.min(totalPages, page + 1))}
                    disabled={page >= totalPages}
                    className="p-1 rounded hover:bg-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-text)]"
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
