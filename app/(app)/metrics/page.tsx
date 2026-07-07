'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, BarChart2, FlaskConical, Copy } from 'lucide-react';
import { MetricEditor, type MetricDraft } from './MetricEditor';

interface MetricRow {
  id: string;
  name_ru: string;
  name_short_ru: string | null;
  description: string | null;
  metric_type: string;
  data_type: string;
  category: string | null;
  source: string;
  agg_fn: string | null;
  agg_field: string | null;
  date_field: string | null;
  filters: unknown[];
  tags: string[];
  formula: string | null;
  dependencies: string[];
  decimal_places: number;
  aggregation_fn: string;
  sort_order: number;
  is_core: boolean;
  is_active: boolean;
  is_hidden_in_ui: boolean;
  is_test: boolean;
  is_collect_ok: boolean;
  is_calc_ok: boolean;
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      title={label}
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${ok ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-border)]'}`}
    />
  );
}

export default function MetricsAdminPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<MetricDraft> | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('');

  const { data, isLoading, error } = useQuery<{ metrics: MetricRow[] }>({
    queryKey: ['admin-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/admin/metrics');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 30_000,
  });

  const metrics = data?.metrics ?? [];
  const existingIds = metrics.map(m => m.id);

  const filtered = metrics.filter(m => {
    const q = search.toLowerCase();
    const matchSearch = !q || m.name_ru.toLowerCase().includes(q) || m.id.includes(q) || (m.tags ?? []).some((t: string) => t.toLowerCase().includes(q));
    const matchType = !filterType || m.metric_type === filterType;
    return matchSearch && matchType;
  });

  async function handleSave(d: MetricDraft) {
    const isNew = !editing?.id;
    const url  = isNew ? '/api/admin/metrics' : `/api/admin/metrics/${editing!.id}`;
    const method = isNew ? 'POST' : 'PUT';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...d,
        filters: d.filters,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    qc.invalidateQueries({ queryKey: ['admin-metrics'] });
    setEditing(null);
  }

  async function handleDelete(id: string) {
    if (!confirm(`Удалить метрику "${id}"?`)) return;
    await fetch(`/api/admin/metrics/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['admin-metrics'] });
  }

  function openNew() {
    setEditing({});
  }

  function openEdit(m: MetricRow) {
    setEditing({
      id: m.id,
      name_ru: m.name_ru,
      name_short_ru: m.name_short_ru ?? '',
      description: m.description ?? '',
      category: m.category ?? '',
      metric_type: m.metric_type as MetricDraft['metric_type'],
      data_type: m.data_type as MetricDraft['data_type'],
      decimal_places: m.decimal_places,
      aggregation_fn: m.aggregation_fn,
      sort_order: m.sort_order,
      source: (m.source ?? 'deals') as MetricDraft['source'],
      agg_fn: (m.agg_fn ?? '') as MetricDraft['agg_fn'],
      agg_field: m.agg_field ?? 'deal_id',
      date_field: m.date_field ?? '',
      filters: (m.filters ?? []) as MetricDraft['filters'],
      formula: m.formula ?? '',
      dependencies: m.dependencies ?? [],
      is_core: m.is_core,
      is_active: m.is_active,
      is_hidden_in_ui: m.is_hidden_in_ui,
      is_test: m.is_test,
      is_collect_ok: m.is_collect_ok,
      is_calc_ok: m.is_calc_ok,
      tags: m.tags ?? [],
    });
  }

  function openDuplicate(m: MetricRow) {
    const newId = `${m.id}_copy`;
    setEditing({
      id: newId,
      name_ru: m.name_ru,
      name_short_ru: m.name_short_ru ?? '',
      description: m.description ?? '',
      category: m.category ?? '',
      metric_type: m.metric_type as MetricDraft['metric_type'],
      data_type: m.data_type as MetricDraft['data_type'],
      decimal_places: m.decimal_places,
      aggregation_fn: m.aggregation_fn,
      sort_order: m.sort_order,
      source: (m.source ?? 'deals') as MetricDraft['source'],
      agg_fn: (m.agg_fn ?? '') as MetricDraft['agg_fn'],
      agg_field: m.agg_field ?? 'deal_id',
      date_field: m.date_field ?? '',
      filters: (m.filters ?? []) as MetricDraft['filters'],
      formula: m.formula ?? '',
      dependencies: m.dependencies ?? [],
      is_core: false,
      is_active: false,
      is_hidden_in_ui: false,
      is_test: false,
      is_collect_ok: false,
      is_calc_ok: false,
      tags: m.tags ?? [],
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-3 sm:px-6 pt-4 pb-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <BarChart2 size={18} className="text-[var(--color-accent)]" />
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Метрики</h1>
          <span className="text-sm text-[var(--color-text-muted)] ml-1">({metrics.length})</span>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            className="px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-base sm:text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)] w-52"
            placeholder="Поиск по названию, id, тегу…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
          >
            <option value="">Все типы</option>
            <option value="collected">Собираемые</option>
            <option value="calculated">Вычисляемые</option>
          </select>
          <button
            onClick={openNew}
            className="flex items-center gap-2 px-3 py-1.5 rounded bg-[var(--color-accent)] text-white text-sm hover:opacity-90"
          >
            <Plus size={14} /> Новая метрика
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="p-6 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-8 bg-[var(--color-border)] rounded animate-pulse" />
            ))}
          </div>
        )}
        {error && (
          <div className="p-6 text-[var(--color-negative)] text-sm">
            Ошибка: {error instanceof Error ? error.message : 'Неизвестная ошибка'}
          </div>
        )}
        {!isLoading && !error && (
          // min-w: на телефоне таблица скроллится в overflow-auto, а не сжимает колонки в кашу
          <table className="w-full min-w-[720px] text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-48">ID</th>
                <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] flex-1">Название</th>
                <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-20">Тип</th>
                <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-32">Категория</th>
                <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-56">Теги</th>
                <th className="text-center px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] w-20">С/В/О</th>
                <th className="border-b border-[var(--color-border)] w-20" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-[var(--color-text-muted)] text-sm">
                    {metrics.length === 0 ? 'Метрик нет. Создайте первую!' : 'Ничего не найдено'}
                  </td>
                </tr>
              )}
              {filtered.map((m, i) => (
                <tr
                  key={m.id}
                  className={`border-b border-[var(--color-border)] hover:bg-[var(--color-table-row-hover)] ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}
                >
                  <td className="px-4 py-2 font-mono text-xs text-[var(--color-text-muted)]">
                    <div className="flex items-center gap-1.5">
                      {m.is_test && <span title="Тест"><FlaskConical size={11} className="text-amber-500 flex-shrink-0" /></span>}
                      {m.id}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-[var(--color-text)]">
                      {m.name_ru}
                      {m.is_test && <span className="ml-1 text-xs text-amber-500">(тест)</span>}
                    </div>
                    {m.name_short_ru && <div className="text-xs text-[var(--color-text-muted)]">{m.name_short_ru}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${m.metric_type === 'collected' ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'}`}>
                      {m.metric_type === 'collected' ? 'Сбор' : 'Расчёт'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{m.category ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {(m.tags ?? []).map((t: string) => (
                        <span key={t} className="px-1.5 py-0.5 rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)] text-xs">{t}</span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1.5" title="Собирается / Считается / Доступна">
                      <StatusDot ok={m.is_collect_ok} label="Собирается правильно" />
                      <StatusDot ok={m.is_calc_ok} label="Считается правильно" />
                      <StatusDot ok={m.is_active} label="Доступна в отчёте" />
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openEdit(m)}
                        className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-border)]"
                        title="Редактировать"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        onClick={() => openDuplicate(m)}
                        className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-border)]"
                        title="Дублировать"
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(m.id)}
                        className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)] hover:bg-[var(--color-border)]"
                        title="Удалить"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Editor drawer */}
      {editing !== null && (
        <MetricEditor
          initial={editing}
          existingIds={existingIds}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
