'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUrlState, stringParam, enumParam } from '@/lib/hooks/useUrlState';

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

// Задача 3029: статусная заливка строки (верно считается/заполняется) + лёгкая зебра
// (чередование интенсивности ТОЙ ЖЕ семантической заливки, не отдельный серый слой —
// иначе статус-цвет и зебра спорят за внимание на 439 строках). odd-строки на пару
// пунктов насыщеннее, этого достаточно, чтобы взгляд не терял текущую строку при
// скролле, но статус остаётся главным сигналом.
function rowBg(m: MetricRow, odd: boolean): string {
  const tone = m.calc_ok && m.fill_ok ? 'green' : (m.calc_ok || m.fill_ok) ? 'yellow' : 'red';
  return `bg-${tone}-50/${odd ? 45 : 28}`;
}

const TYPE_LABELS: Record<string, string> = {
  collected: 'collected',
  calculated: 'calculated',
  external: 'external',
};

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
        className="cursor-text min-h-[1.5rem] px-1 py-0.5 rounded hover:bg-[var(--color-bg-hover)] transition-colors text-[var(--color-text)] whitespace-pre-wrap break-words"
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

  // Поиск/фильтр по типу — в URL (replace: донастройка, не шаг истории), задача 3029:
  // 439 строк без единого способа сузить список.
  const [q, setQ] = useUrlState('q', stringParam(''));
  const [typeFilter, setTypeFilter] = useUrlState(
    'type',
    enumParam(['all', 'collected', 'calculated', 'external'], 'all'),
  );

  useEffect(() => {
    fetch('/api/settings/metrics')
      .then(r => r.json())
      .then((rows: MetricRow[]) => {
        setMetrics(rows);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return metrics.filter(m => {
      if (typeFilter !== 'all' && m.metric_type !== typeFilter) return false;
      if (!needle) return true;
      return (
        m.id.toLowerCase().includes(needle) ||
        m.name_ru.toLowerCase().includes(needle) ||
        (m.name_short_ru ?? '').toLowerCase().includes(needle) ||
        (m.description ?? '').toLowerCase().includes(needle)
      );
    });
  }, [metrics, q, typeFilter]);

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
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-[var(--color-text)]">Метрики</h2>
        <p className="text-xs text-[var(--color-text-muted)] whitespace-nowrap">
          {filtered.length === metrics.length
            ? `${metrics.length} метрик`
            : `${filtered.length} из ${metrics.length} метрик`}
        </p>
      </div>

      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Поиск по ID, названию, описанию…"
          className="w-72 max-w-full px-2.5 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]"
        />
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value as typeof typeFilter)}
          className="px-2.5 py-1.5 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
        >
          <option value="all">Все типы</option>
          <option value="collected">collected</option>
          <option value="calculated">calculated</option>
          <option value="external">external</option>
        </select>
        {(q || typeFilter !== 'all') && (
          <button
            onClick={() => { setQ(''); setTypeFilter('all'); }}
            className="text-xs text-[var(--color-accent)] hover:underline"
          >
            Сбросить
          </button>
        )}
      </div>

      <div className="overflow-auto rounded-lg border border-[var(--color-border)] max-h-[calc(100vh-220px)]">
        <table className="text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-[var(--color-table-header)]">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">ID</th>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] max-w-[220px]">Название</th>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] max-w-[150px]">Краткое</th>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] max-w-[380px]">Описание</th>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Тип</th>
              <th className="text-center px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Считается верно</th>
              <th className="text-center px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap">Заполняется верно</th>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-text)] border-b border-[var(--color-border)] whitespace-nowrap w-20">Статус</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                  Ничего не найдено. Измените поиск или фильтр.
                </td>
              </tr>
            )}
            {filtered.map((m, i) => (
              <tr
                key={m.id}
                className={`border-b border-[var(--color-border)] hover:brightness-95 transition-all ${rowBg(m, i % 2 === 1)}`}
              >
                {/* ID — идентификатор читают и копируют, это ОСНОВНОЙ текст, не второстепенный
                    (задача 3029: раньше --color-text-muted на --color-border давал 3.97:1
                    в light / 2.47:1 в dark на реальном рендере, порог 4.5:1). Непрозрачная
                    заливка --color-bg-hover вместо полупрозрачного --color-border — чтобы
                    чип не «плыл» по контрасту от blur стеклянной подложки под ним. */}
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  <code className="text-xs font-mono bg-[var(--color-bg-hover)] px-1.5 py-0.5 rounded text-[var(--color-text)]">
                    m_{m.id}
                  </code>
                </td>

                {/* name_ru */}
                <td className="px-3 py-2 align-top max-w-[220px]">
                  <EditableCell
                    value={m.name_ru}
                    onSave={val => patch(m.id, { name_ru: val })}
                  />
                </td>

                {/* name_short_ru */}
                <td className="px-3 py-2 align-top max-w-[150px]">
                  <EditableCell
                    value={m.name_short_ru}
                    onSave={val => patch(m.id, { name_short_ru: val || null })}
                  />
                </td>

                {/* description */}
                <td className="px-3 py-2 align-top max-w-[380px]">
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
                    {TYPE_LABELS[m.metric_type] ?? m.metric_type}
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
