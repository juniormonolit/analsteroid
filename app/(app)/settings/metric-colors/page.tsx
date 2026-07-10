'use client';
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus } from 'lucide-react';
import type { Metric } from '@/lib/metrics/types';
import { GOOGLE_SHEETS_PALETTE_GRID } from '@/lib/colors/google-sheets-palette';
import { GsColorPickerButton as ColorPickerButton } from '@/components/ui/GsColorPicker';
import type { CategoryColorPreview } from '@/lib/metrics/entity-colors';

interface Rule { scope: 'category' | 'metric'; key: string; color: string }

// Дефолт для нового переопределения, если больше не от чего оттолкнуться —
// первый насыщенный цвет строки палитры Google Sheets.
const FALLBACK_START_COLOR = GOOGLE_SHEETS_PALETTE_GRID[1][6];

// Пикер (Swatch/GsPalettePopover/ColorPickerButton) вынесен в
// components/ui/GsColorPicker.tsx — переиспользуется в HighlightEditor (п.9 спеки).

function autoPreviewLabel(auto: CategoryColorPreview | undefined): string {
  if (!auto) return '';
  if (auto.kind === 'color') return `авто: ${auto.color}`;
  if (auto.kind === 'neutral') return 'авто: без цвета';
  return 'авто: по метрике (числитель)';
}

function autoPreviewDot(auto: CategoryColorPreview | undefined): string {
  if (auto?.kind === 'color') return auto.color;
  return 'var(--color-border-strong)';
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
    queryFn: () => fetch('/api/settings/metric-colors').then(r => r.json()) as Promise<{
      rules: Rule[]; categories: string[]; autoCategoryColors: Record<string, CategoryColorPreview>;
    }>,
  });
  const { data: catalog } = useQuery({
    queryKey: ['metrics-catalog'],
    queryFn: () => fetch('/api/catalog/metrics').then(r => r.json()) as Promise<{ metrics: Metric[] }>,
    staleTime: 5 * 60 * 1000,
  });
  const metrics = catalog?.metrics ?? [];

  useEffect(() => { if (data) setRules(data.rules); }, [data]);

  const categories = data?.categories ?? [];
  const autoCategoryColors = data?.autoCategoryColors ?? {};
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
    // Стартовый цвет: текущее ручное правило категории > уже резолвнутый автоцвет
    // метрики (из каталога) > нейтральный дефолт палитры.
    const start = catRules.get(m.category ?? '') ?? m.color ?? FALLBACK_START_COLOR;
    setRule('metric', m.id, start);
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
                  className="px-4 py-1.5 text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40">
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-6">
        Бейджи показателей в отчётах красятся автоматически по сущности метрики (отказы —
        красный, продажи — синий, отгрузки — зелёный, брони — голубой и т.д.). Здесь можно
        переопределить цвет конкретной категории или метрики — выбор из палитры Google Sheets.
        Переопределение по метрике сильнее правила категории, оба сильнее автоцвета.
      </p>

      {/* Категории */}
      <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Правила по категориям</div>
      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)] bg-[var(--color-bg-surface)] mb-8">
        {categories.map((cat, i) => {
          const color = catRules.get(cat);
          const auto = autoCategoryColors[cat];
          return (
            <div key={cat} className={`flex items-center gap-3 px-4 py-3 ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
              <span className="text-sm text-[var(--color-text)] w-44 shrink-0 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ backgroundColor: color ?? autoPreviewDot(auto) }} />
                {cat}
              </span>
              {color ? (
                <>
                  <ColorPickerButton value={color} onChange={c => setRule('category', cat, c)} />
                  <span className="text-xs text-[var(--color-text-muted)]">переопределено вручную</span>
                  <button onClick={() => setRule('category', cat, null)} title="Вернуть автоцвет"
                          className="tap-target ml-auto p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] transition-colors">
                    <Trash2 size={14} />
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-[var(--color-text-muted)]">{autoPreviewLabel(auto)}</span>
                  <button
                    onClick={() => setRule('category', cat, auto?.kind === 'color' ? auto.color : FALLBACK_START_COLOR)}
                    className="ml-auto text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1"
                  >
                    <Plus size={12} /> переопределить
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Переопределения по метрикам */}
      <div className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Переопределения по метрикам</div>
      <div className="border border-[var(--color-border)] rounded-lg divide-y divide-[var(--color-border)] bg-[var(--color-bg-surface)]">
        {metricRules.length === 0 && (
          <div className="px-4 py-3 text-sm text-[var(--color-text-muted)]">Нет переопределений — все метрики красятся автоцветом по сущности</div>
        )}
        {metricRules.map((r, i) => (
          <div key={r.key} className={`flex items-center gap-3 px-4 py-3 ${i % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
            <span className="text-sm text-[var(--color-text)] w-52 shrink-0 truncate flex items-center gap-2" title={nameOf(r.key)}>
              <span className="w-2.5 h-2.5 rounded-full inline-block shrink-0" style={{ backgroundColor: r.color }} />
              {nameOf(r.key)}
            </span>
            <ColorPickerButton value={r.color} onChange={c => setRule('metric', r.key, c)} />
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
