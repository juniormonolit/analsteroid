'use client';
import { useEffect, useRef, useState } from 'react';

interface MetricRow {
  id: string;
  name_ru: string;
  name_short_ru: string | null;
  description: string | null;
  calc_ok: boolean;
  fill_ok: boolean;
  metric_type: string;
  data_type: string;
  formula: string | null;
  sort_order: number;
  is_core: boolean;
  is_hidden_in_ui: boolean;
  is_active: boolean;
}

type SavedState = Record<string, boolean>; // metricId -> shown

function rowBg(m: MetricRow): string {
  if (m.calc_ok && m.fill_ok) return 'bg-green-50/30';
  if (m.calc_ok || m.fill_ok) return 'bg-yellow-50/30';
  return 'bg-red-50/30';
}

function EditableCell({
  value,
  multiline = false,
  onSave,
}: {
  value: string | null;
  multiline?: boolean;
  onSave: (val: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && ref.current) ref.current.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== (value ?? '')) onSave(draft);
  }

  if (!editing) {
    return (
      <div
        className="cursor-text min-h-[1.5rem] px-1 py-0.5 rounded hover:bg-[var(--color-border)] transition-colors text-[var(--color-text)] whitespace-pre-wrap"
        onClick={() => { setDraft(value ?? ''); setEditing(true); }}
        title="Нажмите для редактирования"
      >
        {value || <span className="text-[var(--color-text-muted)] italic">—</span>}
      </div>
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={ref as React.Ref<HTMLTextAreaElement>}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full px-1 py-0.5 rounded border border-[var(--color-accent)] bg-transparent text-[var(--color-text)] text-sm resize-none focus:outline-none min-h-[3rem]"
        rows={3}
      />
    );
  }

  return (
    <input
      ref={ref as React.Ref<HTMLInputElement>}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      className="w-full px-1 py-0.5 rounded border border-[var(--color-accent)] bg-transparent text-[var(--color-text)] text-sm focus:outline-none"
    />
  );
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<SavedState>({});

  useEffect(() => {
    fetch('/api/settings/metrics')
      .then(r => r.json())
      .then((rows: MetricRow[]) => {
        setMetrics(rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function showSaved(id: string) {
    setSaved(prev => ({ ...prev, [id]: true }));
    setTimeout(() => setSaved(prev => ({ ...prev, [id]: false })), 2000);
  }

  async function patch(id: string, fields: Partial<Omit<MetricRow, 'id'>>) {
    // Optimistic update
    setMetrics(prev => prev.map(m => m.id === id ? { ...m, ...fields } : m));
    try {
      const res = await fetch(`/api/settings/metrics/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (res.ok) showSaved(id);
      else {
        // Revert on failure
        const data = await res.json();
        console.error('Save failed:', data);
      }
    } catch (e) {
      console.error('Save error:', e);
    }
  }

  if (loading) {
    return (
      <div className="p-6 space-y-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="h-9 rounded bg-[var(--color-border)] animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--color-text)]">Метрики</h2>
        <p className="text-xs text-[var(--color-text-muted)]">{metrics.length} метрик</p>
      </div>

      <div className="overflow-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
            <tr>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">ID</th>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] min-w-[180px]">Название</th>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] min-w-[120px]">Краткое</th>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] min-w-[200px]">Описание</th>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Тип</th>
              <th className="text-center px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Считается верно</th>
              <th className="text-center px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Заполняется верно</th>
              <th className="text-left px-3 py-2.5 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap w-20">Статус</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m, i) => (
              <tr
                key={m.id}
                className={`border-b border-[var(--color-border)] hover:brightness-95 transition-all ${rowBg(m)}`}
              >
                {/* ID */}
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <code className="text-xs font-mono bg-[var(--color-border)] px-1.5 py-0.5 rounded text-[var(--color-text-muted)]">
                    m_{m.id}
                  </code>
                </td>

                {/* name_ru */}
                <td className="px-3 py-2 align-top">
                  <EditableCell
                    value={m.name_ru}
                    onSave={val => patch(m.id, { name_ru: val })}
                  />
                </td>

                {/* name_short_ru */}
                <td className="px-3 py-2 align-top">
                  <EditableCell
                    value={m.name_short_ru}
                    onSave={val => patch(m.id, { name_short_ru: val || null })}
                  />
                </td>

                {/* description */}
                <td className="px-3 py-2 align-top">
                  <EditableCell
                    value={m.description}
                    multiline
                    onSave={val => patch(m.id, { description: val || null })}
                  />
                </td>

                {/* metric_type */}
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${
                    m.metric_type === 'collected'
                      ? 'bg-blue-100 text-blue-700'
                      : m.metric_type === 'calculated'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-orange-100 text-orange-700'
                  }`}>
                    {m.metric_type}
                  </span>
                </td>

                {/* calc_ok */}
                <td className="px-3 py-2 align-top text-center">
                  <input
                    type="checkbox"
                    checked={m.calc_ok}
                    onChange={e => patch(m.id, { calc_ok: e.target.checked })}
                    className="w-4 h-4 cursor-pointer accent-[var(--color-accent)]"
                  />
                </td>

                {/* fill_ok */}
                <td className="px-3 py-2 align-top text-center">
                  <input
                    type="checkbox"
                    checked={m.fill_ok}
                    onChange={e => patch(m.id, { fill_ok: e.target.checked })}
                    className="w-4 h-4 cursor-pointer accent-[var(--color-accent)]"
                  />
                </td>

                {/* Save indicator */}
                <td className="px-3 py-2 align-top">
                  <span
                    className={`text-xs text-green-600 transition-opacity duration-500 ${
                      saved[m.id] ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    Сохранено ✓
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
