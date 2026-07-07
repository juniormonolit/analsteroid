'use client';
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus } from 'lucide-react';
import type { Metric } from '@/lib/metrics/types';

interface Rule { scope: 'category' | 'metric'; key: string; color: string }

const PRESET_COLORS = ['#3b82f6', '#93c5fd', '#22d3ee', '#22c55e', '#a3e635', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];

function ColorCell({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <input type="color" value={value} onChange={e => onChange(e.target.value)}
             className="w-7 h-7 rounded cursor-pointer border border-[var(--color-border)] bg-transparent p-0" />
      <span className="flex gap-1">
        {PRESET_COLORS.map(c => (
          <button key={c} onClick={() => onChange(c)} title={c}
                  className="w-4 h-4 rounded-full hover:scale-125 transition-transform"
                  style={{ backgroundColor: c, outline: value.toLowerCase() === c ? '2px solid var(--color-text)' : 'none', outlineOffset: 1 }} />
        ))}
      </span>
    </span>
  );
}

export default function MetricColorsPage() {
  const qc = useQueryClient();
  const [rules, setRules] = useState<Rule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [newMetric, setNewMetric] = useState('');

  const { data } = useQuery({
    queryKey: ['metric-colors'],
    queryFn: () => fetch('/api/settings/metric-colors').then(r => r.json()) as Promise<{ rules: Rule[]; categories: string[] }>,
  });
  const { data: catalog } = useQuery({
    queryKey: ['metrics-catalog'],
    queryFn: () => fetch('/api/catalog/metrics').then(r => r.json()) as Promise<{ metrics: Metric[] }>,
    staleTime: 5 * 60 * 1000,
  });
  const metrics = catalog?.metrics ?? [];

  useEffect(() => { if (data) setRules(data.rules); }, [data]);

  const categories = data?.categories ?? [];
  const catRules = new Map(rules.filter(r => r.scope === 'category').map(r => [r.key, r.color]));
  const metricRules = rules.filter(r => r.scope === 'metric');

  function setRule(scope: 'category' | 'metric', key: string, color: string | null) {
    setRules(prev => {
      const next = prev.filter(r => !(r.scope === scope && r.key === key));
      if (color) next.push({ scope, key, color });
      return next;
    });
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    const res = await fetch('/api/settings/metric-colors', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    setSaving(false);
    if (res.ok) {
      setDirty(false);
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['metrics-catalog'] });
      qc.invalidateQueries({ queryKey: ['metric-colors'] });
    } else {
      alert((await res.json()).error ?? 'Ошибка сохранения');
    }
  }

  function addMetricOverride() {
    const m = metrics.find(x => x.nameRu === newMetric.trim() || x.id === newMetric.trim());
    if (!m) return;
    setRule('metric', m.id, catRules.get(m.category ?? '') ?? PRESET_COLORS[0]);
    setNewMetric('');
  }

  const nameOf = (id: string) => metrics.find(m => m.id === id)?.nameRu ?? id;

  return (
    <div className="p-3 sm:p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Цвета метрик</h1>
        <div className="flex items-center gap-3">
          {savedAt && !dirty && <span className="text-xs text-[var(--color-positive,#16a34a)]">Сохранено</span>}
          <button onClick={save} disabled={!dirty || saving}
                  className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40">
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Бейджи показателей в отчётах красятся по этим правилам (тумблер «Выделять показатели
        цветом» — в «Вид»). Переопределение по метрике сильнее правила категории.
      </p>

      {/* Категории */}
      <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Правила по категориям</div>
      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)] mb-8">
        {categories.map(cat => {
          const color = catRules.get(cat);
          return (
            <div key={cat} className="flex items-center gap-3 px-4 py-2.5">
              <span className="text-sm text-[var(--color-text)] w-40 flex items-center gap-2">
                {color && <span className="w-3 h-3 rounded-full inline-block" style={{ backgroundColor: color }} />}
                {cat}
              </span>
              {color ? (
                <>
                  <ColorCell value={color} onChange={c => setRule('category', cat, c)} />
                  <button onClick={() => setRule('category', cat, null)} title="Убрать цвет"
                          className="tap-target ml-auto p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </>
              ) : (
                <button onClick={() => setRule('category', cat, PRESET_COLORS[0])}
                        className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
                  <Plus size={12} /> задать цвет
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Переопределения по метрикам */}
      <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Переопределения по метрикам</div>
      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)]">
        {metricRules.length === 0 && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-muted)]">Нет переопределений</div>
        )}
        {metricRules.map(r => (
          <div key={r.key} className="flex items-center gap-3 px-4 py-2.5">
            <span className="text-sm text-[var(--color-text)] w-72 truncate flex items-center gap-2" title={nameOf(r.key)}>
              <span className="w-3 h-3 rounded-full inline-block shrink-0" style={{ backgroundColor: r.color }} />
              {nameOf(r.key)}
            </span>
            <ColorCell value={r.color} onChange={c => setRule('metric', r.key, c)} />
            <button onClick={() => setRule('metric', r.key, null)} title="Удалить переопределение"
                    className="tap-target ml-auto p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 px-4 py-2.5">
          <input
            value={newMetric}
            onChange={e => setNewMetric(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addMetricOverride()}
            placeholder="Название метрики…"
            list="metric-color-list"
            className="flex-1 text-sm border border-[var(--color-border)] rounded-lg px-3 py-1.5 bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <datalist id="metric-color-list">
            {metrics.filter(m => !metricRules.some(r => r.key === m.id)).map(m => <option key={m.id} value={m.nameRu} />)}
          </datalist>
          <button onClick={addMetricOverride} disabled={!newMetric.trim()}
                  className="px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg hover:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-40 flex items-center gap-1">
            <Plus size={13} /> Добавить
          </button>
        </div>
      </div>
    </div>
  );
}
