'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Search, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { useUnsavedGuard } from '@/lib/hooks/useUnsavedGuard';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';

// Шаблоны карточек — редизайн 30.07 (владелец: «интерфейс этого экрана — пиздец»).
// Было: три несвязные колонки + ДВА вечно открытых каталога-простыни (свой поиск у
// каждого), превью — немой ромб с номерами, шапка — абзац на 5 строк, ссылавшийся
// на уже несуществующий экран «Веса скоринга». Стало:
//  * слева — живое превью: паутина С ПОДПИСЯМИ осей + распределение весов рейтинга;
//  * справа — компактные списки осей и плиток; каталог метрик открывается по кнопке
//    «+ Добавить» в Popover (канон дропдаунов проекта, CLAUDE.md №4) — один общий
//    компонент пикера на оси и плитки, с поиском, категориями и пометками
//    «выбрано» / «вне отчётов» (метрика рабочая, но скрыта из общего каталога —
//    см. pickableMetricIds, задача 30.07);
//  * сохранение — липкая нижняя панель с индикатором несохранённого.
// Контракты хранения не менялись: axes = {metricKey, invert, weight}[] (миграции
// 073/075/107), tiles = string[] (083); гейт несохранённых изменений сохранён.

interface AxisConfig { metricKey: string; invert: boolean; weight: number }
const DEFAULT_AXIS_WEIGHT = 5;
interface CatalogMetric { id: string; nameRu: string; category: string | null; dataType: string; isActive?: boolean }
interface LegacyAxisCatalogEntry { metricKey: string; label: string; defaultInvert: boolean }
interface LegacyTileCatalogEntry { metricKey: string; label: string }
type TemplateKey = 'manager' | 'department';

const TEMPLATES: { key: TemplateKey; label: string }[] = [
  { key: 'manager', label: 'Карточка менеджера' },
  { key: 'department', label: 'Карточка отдела (РОП)' },
];

interface CatalogResponse {
  legacyAxes: LegacyAxisCatalogEntry[];
  legacyTiles: LegacyTileCatalogEntry[];
  metrics: CatalogMetric[];
  maxAxes: number;
}

const LEGACY_CATEGORY = 'Классические (карточка)';

// ── Превью паутины с подписями осей (было: голые номера 1..n — владелец не видел,
// ЧТО выбрано, пока не посмотрит в список). Та же угловая формула, что и настоящий
// радар (ManagerCardRadar.tsx::axisAngle): 1-я ось вверху, дальше по часовой. ─────
function PreviewRadar({ labels }: { labels: string[] }) {
  const n = Math.max(labels.length, 1);
  const W = 300, H = 232, CX = 150, CY = 116, R = 74;
  function point(i: number, r: number) {
    const a = (-90 + i * (360 / n)) * (Math.PI / 180);
    return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a), cos: Math.cos(a), sin: Math.sin(a) };
  }
  const pts = Array.from({ length: n }, (_, i) => point(i, R));
  const poly = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const rings = [0.5, 1];
  const short = (s: string) => (s.length > 20 ? `${s.slice(0, 19)}…` : s);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="block select-none">
      {rings.map(t => (
        <polygon
          key={t}
          points={Array.from({ length: n }, (_, i) => { const p = point(i, R * t); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ')}
          fill="none" stroke="var(--color-border)" strokeWidth={1} strokeDasharray={t === 1 ? undefined : '3 3'}
        />
      ))}
      {pts.map((p, i) => (
        <line key={i} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="var(--color-border)" strokeWidth={1} />
      ))}
      {labels.length > 0 && (
        <polygon points={poly} fill="var(--color-accent)" fillOpacity={0.14} stroke="var(--color-accent)" strokeWidth={1.5} />
      )}
      {pts.map((p, i) => {
        const lbl = labels[i];
        const anchor = p.cos > 0.35 ? 'start' : p.cos < -0.35 ? 'end' : 'middle';
        const lx = p.x + p.cos * 9;
        const ly = p.y + p.sin * 12 + (Math.abs(p.cos) > 0.9 ? 3 : p.sin > 0 ? 8 : -4);
        return (
          <g key={i} className={labels.length === 0 ? 'opacity-30' : ''}>
            <circle cx={p.x} cy={p.y} r={8.5} fill={lbl ? 'var(--color-accent)' : 'var(--color-border)'} />
            <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--color-text-inverse)">{i + 1}</text>
            {lbl && (
              <text x={lx} y={ly} textAnchor={anchor} fontSize={10} fill="var(--color-text-muted)">
                {short(lbl)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── Распределение весов рейтинга: стек-бар + легенда с долями. Ровно та же
// нормировка, что в движке (ratingFor: вес / сумма весов выбранных осей). ─────────
function segColor(i: number): string {
  return `color-mix(in srgb, var(--color-accent) ${Math.max(30, 100 - i * 14)}%, var(--color-mix-base, white))`;
}

function WeightBar({ items }: { items: { label: string; weight: number }[] }) {
  const sum = items.reduce((s, x) => s + x.weight, 0);
  if (items.length === 0) return null;
  return (
    <div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-[var(--color-border)]">
        {sum > 0 && items.map((x, i) => (
          <div key={i} style={{ width: `${(x.weight / sum) * 100}%`, backgroundColor: segColor(i) }} />
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-0.5">
        {items.map((x, i) => (
          <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
            <span className="w-2 h-2 rounded-full shrink-0 self-center" style={{ backgroundColor: segColor(i) }} />
            <span className="flex-1 min-w-0 truncate text-[var(--color-text-muted)]" title={x.label}>{x.label}</span>
            <span className="tabular-nums font-semibold text-[var(--color-text)]">
              {sum > 0 ? `${Math.round((x.weight / sum) * 100)}%` : '—'}
            </span>
          </div>
        ))}
      </div>
      {sum === 0 && (
        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">Все веса нулевые — рейтинг считается простым средним.</p>
      )}
    </div>
  );
}

// ── Пикер метрик: кнопка «+ Добавить» → Popover с поиском и категориями.
// ОДИН компонент на оси и плитки (раньше на странице висели два независимых
// каталога-простыни со своими поисками). ──────────────────────────────────────────
interface PickerEntry {
  key: string;
  label: string;
  category: string;
  selected: boolean;
  /** Метрика рабочая, но скрыта из общего каталога отчётов (is_active=false). */
  inactive: boolean;
  defaultInvert?: boolean;
}

function MetricPickerButton({ entries, disabled, disabledHint, onPick }: {
  entries: PickerEntry[];
  disabled?: boolean;
  disabledHint?: string;
  onPick: (e: PickerEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { if (!open) setQ(''); }, [open]);

  const query = q.trim().toLowerCase();
  const grouped = useMemo(() => {
    const map = new Map<string, PickerEntry[]>();
    for (const e of entries) {
      if (query && !e.label.toLowerCase().includes(query) && !e.key.toLowerCase().includes(query) && !e.category.toLowerCase().includes(query)) continue;
      if (!map.has(e.category)) map.set(e.category, []);
      map.get(e.category)!.push(e);
    }
    // «Классические» — первыми, остальное по алфавиту (как в старом каталоге).
    return [...map.entries()].sort((a, b) => {
      if (a[0] === LEGACY_CATEGORY) return -1;
      if (b[0] === LEGACY_CATEGORY) return 1;
      return a[0].localeCompare(b[0], 'ru');
    });
  }, [entries, query]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[340px] max-w-[94vw] flex flex-col overflow-hidden"
      trigger={
        <button
          disabled={disabled}
          title={disabled ? disabledHint : undefined}
          className="tap-target inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold rounded-lg border border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-border-focus)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Plus size={14} />
          Добавить
        </button>
      }
    >
      <div className="p-2 border-b border-[var(--color-border)]">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            autoFocus
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Метрика или категория…"
            className="w-full pl-8 pr-3 py-1.5 text-base sm:text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
      </div>
      <div className="max-h-[46vh] overflow-y-auto">
        {grouped.length === 0 && (
          <div className="px-3 py-4 text-sm text-[var(--color-text-muted)]">Ничего не найдено</div>
        )}
        {grouped.map(([cat, ms]) => (
          <div key={cat}>
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg)] sticky top-0 z-[1]">
              {cat}
            </div>
            {ms.map(e => (
              <button
                key={e.key}
                onClick={() => { if (!e.selected) { onPick(e); setOpen(false); } }}
                disabled={e.selected}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                  e.selected ? 'text-[var(--color-text-muted)] bg-[var(--color-bg)] cursor-default' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                }`}
              >
                <span className="flex-1 min-w-0 truncate" title={e.label}>{e.label}</span>
                {e.inactive && !e.selected && (
                  <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)]" title="Метрика считается, но скрыта из общего каталога отчётов">
                    вне отчётов
                  </span>
                )}
                {e.selected && <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">выбрано</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
    </Popover>
  );
}

// ── Строка оси: номер · имя (+чип «меньше — лучше») · порядок · вес · удалить.
// На телефоне контролы переносятся на вторую строку (flex-wrap), имя — всегда
// первая строка целиком. ──────────────────────────────────────────────────────────
function AxisRow({ index, total, axis, label, weightShare, onMove, onInvert, onWeight, onRemove }: {
  index: number; total: number; axis: AxisConfig; label: string; weightShare: number | null;
  onMove: (dir: -1 | 1) => void; onInvert: (v: boolean) => void; onWeight: (v: number) => void; onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 border border-[var(--color-border)] rounded-xl bg-[var(--color-bg-surface)]">
      <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)] text-[11px] font-bold flex items-center justify-center">
        {index + 1}
      </span>
      <span className="basis-[calc(100%-4.5rem)] sm:basis-auto sm:flex-1 min-w-0 text-sm font-medium text-[var(--color-text)] truncate" title={label}>
        {label}
      </span>

      <div className="flex items-center gap-0.5 sm:ml-0 ml-8">
        <button
          onClick={() => onMove(-1)} disabled={index === 0}
          className="tap-target p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
          title="Выше" aria-label="Переместить выше"
        ><ArrowUp size={14} /></button>
        <button
          onClick={() => onMove(1)} disabled={index === total - 1}
          className="tap-target p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
          title="Ниже" aria-label="Переместить ниже"
        ><ArrowDown size={14} /></button>
      </div>

      <label
        className="flex items-center gap-1.5 pl-2 border-l border-[var(--color-border)]"
        title="Вес оси в рейтинге (0–10). Процент — доля среди выбранных осей."
      >
        <span className="text-[11px] text-[var(--color-text-muted)]">вес</span>
        <input
          type="number" min={0} max={10} step={0.5}
          value={axis.weight}
          onChange={e => onWeight(Number(e.target.value))}
          className="w-14 px-1.5 py-0.5 text-base sm:text-sm text-right tabular-nums border border-[var(--color-border)] rounded-md bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
        />
        <span className="w-9 text-[11px] tabular-nums font-semibold text-[var(--color-text)]">
          {weightShare === null ? '—' : `${Math.round(weightShare * 100)}%`}
        </span>
      </label>

      <button
        onClick={() => onInvert(!axis.invert)}
        title="«Меньше — лучше»: инвертировать шкалу (например, скорость касания или доля отказов)"
        className={`px-2 py-1 rounded-full text-[10.5px] font-semibold border transition-colors whitespace-nowrap ${
          axis.invert
            ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)] border-transparent'
            : 'text-[var(--color-text-muted)] border-[var(--color-border)] hover:text-[var(--color-text)] hover:border-[var(--color-border-focus)]'
        }`}
      >
        меньше — лучше
      </button>

      <button
        onClick={onRemove}
        className="tap-target ml-auto sm:ml-0 w-6 h-6 rounded-full hover:bg-[var(--color-negative)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center transition-colors"
        aria-label="Убрать ось"
      ><X size={13} /></button>
    </div>
  );
}

function TileRow({ index, total, label, onMove, onRemove }: {
  index: number; total: number; label: string;
  onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border border-[var(--color-border)] rounded-xl bg-[var(--color-bg-surface)]">
      <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)] text-[11px] font-bold flex items-center justify-center">
        {index + 1}
      </span>
      <span className="flex-1 min-w-0 text-sm font-medium text-[var(--color-text)] truncate" title={label}>{label}</span>
      <button
        onClick={() => onMove(-1)} disabled={index === 0}
        className="tap-target p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
        title="Выше" aria-label="Переместить выше"
      ><ArrowUp size={14} /></button>
      <button
        onClick={() => onMove(1)} disabled={index === total - 1}
        className="tap-target p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
        title="Ниже" aria-label="Переместить ниже"
      ><ArrowDown size={14} /></button>
      <button
        onClick={onRemove}
        className="tap-target w-6 h-6 rounded-full hover:bg-[var(--color-negative)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center transition-colors"
        aria-label="Убрать плитку"
      ><X size={13} /></button>
    </div>
  );
}

function SectionCard({ title, count, right, children, hint }: {
  title: string; count?: string; right?: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">
          {title}{count && <span className="ml-1.5 font-semibold normal-case tracking-normal">· {count}</span>}
        </div>
        {right}
      </div>
      {children}
      {hint && <div className="mt-2.5 text-[11px] text-[var(--color-text-muted)]">{hint}</div>}
    </section>
  );
}

function labelFor(metricKey: string, legacyAxes: LegacyAxisCatalogEntry[], metrics: CatalogMetric[]): string {
  const legacy = legacyAxes.find(a => a.metricKey === metricKey);
  if (legacy) return legacy.label;
  const m = metrics.find(x => x.id === metricKey);
  return m?.nameRu ?? metricKey;
}

function labelForTile(metricKey: string, legacyTiles: LegacyTileCatalogEntry[], metrics: CatalogMetric[]): string {
  const legacy = legacyTiles.find(a => a.metricKey === metricKey);
  if (legacy) return legacy.label;
  const m = metrics.find(x => x.id === metricKey);
  return m?.nameRu ?? metricKey;
}

export default function CardTemplatesPage() {
  const [templateKey, setTemplateKey] = useState<TemplateKey>('manager');
  const [axes, setAxes] = useState<AxisConfig[] | null>(null);
  const [tiles, setTiles] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // ── Гейт несохранённых изменений (правило DESIGN_GUIDELINES.md) — без изменений ──
  const savedSnapshotRef = useRef<{ axes: AxisConfig[]; tiles: string[] } | null>(null);
  const { dialogOpen, requestGuardedClose, confirmDiscard, confirmSave, cancel } = useUnsavedGuard();

  const isDirty = axes !== null && tiles !== null && savedSnapshotRef.current !== null && (
    JSON.stringify(axes) !== JSON.stringify(savedSnapshotRef.current.axes) ||
    JSON.stringify(tiles) !== JSON.stringify(savedSnapshotRef.current.tiles)
  );

  function loadTemplate(key: TemplateKey) {
    setAxes(null);
    setTiles(null);
    setMessage(null);
    fetch(`/api/settings/card-templates?key=${key}`)
      .then(r => r.json())
      .then(d => {
        const loadedAxes: AxisConfig[] = d.axes ?? [];
        const loadedTiles: string[] = d.tiles ?? [];
        setAxes(loadedAxes);
        setTiles(loadedTiles);
        setCatalog(d.catalog);
        savedSnapshotRef.current = { axes: loadedAxes, tiles: loadedTiles };
      })
      .catch(() => {
        setAxes([]);
        setTiles([]);
      });
  }

  useEffect(() => { loadTemplate(templateKey); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [templateKey]);

  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (isDirty) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  function handleTemplateSwitch(key: TemplateKey) {
    if (key === templateKey) return;
    requestGuardedClose(isDirty, () => setTemplateKey(key));
  }

  const maxAxes = catalog?.maxAxes ?? 6;
  const weightSum = (axes ?? []).reduce((s, a) => s + (Number.isFinite(a.weight) ? a.weight : 0), 0);

  function addAxis(metricKey: string, defaultInvert: boolean) {
    if (!axes || axes.length >= maxAxes || axes.some(a => a.metricKey === metricKey)) return;
    setAxes([...axes, { metricKey, invert: defaultInvert, weight: DEFAULT_AXIS_WEIGHT }]);
  }
  function removeAxis(metricKey: string) {
    if (!axes) return;
    setAxes(axes.filter(a => a.metricKey !== metricKey));
  }
  function moveAxis(index: number, dir: -1 | 1) {
    if (!axes) return;
    const j = index + dir;
    if (j < 0 || j >= axes.length) return;
    const next = [...axes];
    [next[index], next[j]] = [next[j], next[index]];
    setAxes(next);
  }
  function setAxisInvert(index: number, invert: boolean) {
    if (!axes) return;
    const next = [...axes];
    next[index] = { ...next[index], invert };
    setAxes(next);
  }
  function setAxisWeight(index: number, weight: number) {
    if (!axes) return;
    const clamped = Number.isFinite(weight) ? Math.min(10, Math.max(0, weight)) : DEFAULT_AXIS_WEIGHT;
    const next = [...axes];
    next[index] = { ...next[index], weight: clamped };
    setAxes(next);
  }

  function addTile(metricKey: string) {
    if (!tiles || tiles.includes(metricKey)) return;
    setTiles([...tiles, metricKey]);
  }
  function removeTile(metricKey: string) {
    if (!tiles) return;
    setTiles(tiles.filter(t => t !== metricKey));
  }
  function moveTile(index: number, dir: -1 | 1) {
    if (!tiles) return;
    const j = index + dir;
    if (j < 0 || j >= tiles.length) return;
    const next = [...tiles];
    [next[index], next[j]] = [next[j], next[index]];
    setTiles(next);
  }

  async function doSave(): Promise<boolean> {
    if (!axes || !tiles) return false;
    if (axes.length === 0) {
      setMessage({ type: 'error', text: 'Выберите хотя бы одну ось' });
      return false;
    }
    if (tiles.length === 0) {
      setMessage({ type: 'error', text: 'Выберите хотя бы одну плитку' });
      return false;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings/card-templates', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: templateKey, axes, tiles }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Ошибка сохранения' });
        return false;
      }
      savedSnapshotRef.current = { axes, tiles };
      setMessage({ type: 'success', text: 'Сохранено — применится ко всем карточкам этого типа' });
      return true;
    } catch {
      setMessage({ type: 'error', text: 'Сетевая ошибка' });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() { await doSave(); }

  async function handleDialogSave() {
    const ok = await doSave();
    if (ok) confirmSave(() => { /* сохранение уже выполнено выше */ });
    else cancel();
  }

  // ── Единый список записей для пикеров (оси и плитки) ─────────────────────────────
  const selectedAxisKeys = useMemo(() => new Set((axes ?? []).map(a => a.metricKey)), [axes]);
  const selectedTileKeys = useMemo(() => new Set(tiles ?? []), [tiles]);

  const axisPickerEntries = useMemo<PickerEntry[]>(() => {
    if (!catalog) return [];
    return [
      ...catalog.legacyAxes.map(a => ({
        key: a.metricKey, label: a.label, category: LEGACY_CATEGORY,
        selected: selectedAxisKeys.has(a.metricKey), inactive: false, defaultInvert: a.defaultInvert,
      })),
      ...catalog.metrics.map(m => ({
        key: m.id, label: m.nameRu, category: m.category ?? 'Прочее',
        selected: selectedAxisKeys.has(m.id), inactive: m.isActive === false, defaultInvert: false,
      })),
    ];
  }, [catalog, selectedAxisKeys]);

  const tilePickerEntries = useMemo<PickerEntry[]>(() => {
    if (!catalog) return [];
    return [
      ...catalog.legacyTiles.map(a => ({
        key: a.metricKey, label: a.label, category: LEGACY_CATEGORY,
        selected: selectedTileKeys.has(a.metricKey), inactive: false,
      })),
      ...catalog.metrics.map(m => ({
        key: m.id, label: m.nameRu, category: m.category ?? 'Прочее',
        selected: selectedTileKeys.has(m.id), inactive: m.isActive === false,
      })),
    ];
  }, [catalog, selectedTileKeys]);

  const atMaxAxes = (axes?.length ?? 0) >= maxAxes;
  const axisLabels = (axes ?? []).map(a => (catalog ? labelFor(a.metricKey, catalog.legacyAxes, catalog.metrics) : ''));

  return (
    <div className="p-3 sm:p-6 max-w-6xl">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Шаблоны карточек</h1>
        <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm w-fit">
          {TEMPLATES.map(t => (
            <button
              key={t.key}
              onClick={() => handleTemplateSwitch(t.key)}
              className={`px-3.5 py-2 transition-colors whitespace-nowrap ${
                templateKey === t.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] mb-5">
        Оси паутины (и их веса в рейтинге) и плитки итогов. Изменения применяются сразу
        ко всем карточкам этого типа.
      </p>

      {axes === null || tiles === null || catalog === null ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-16 bg-[var(--color-border)] rounded-2xl animate-pulse" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5 items-start">
            {/* ── Слева: живое превью (липнет при скролле на десктопе) ── */}
            <div className="lg:sticky lg:top-4 flex flex-col gap-4">
              <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">Паутина</div>
                <PreviewRadar labels={axisLabels} />
              </section>
              <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4">
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2.5">Вес в рейтинге</div>
                <WeightBar items={(axes ?? []).map((a, i) => ({ label: axisLabels[i], weight: a.weight }))} />
              </section>
            </div>

            {/* ── Справа: оси и плитки ── */}
            <div className="flex flex-col gap-5 min-w-0">
              <SectionCard
                title="Оси паутины"
                count={`${axes.length}/${maxAxes}`}
                right={
                  <MetricPickerButton
                    entries={axisPickerEntries}
                    disabled={atMaxAxes}
                    disabledHint={`Максимум ${maxAxes} осей — уберите одну, чтобы добавить другую`}
                    onPick={e => addAxis(e.key, e.defaultInvert ?? false)}
                  />
                }
                hint={
                  <>Рейтинг = средневзвешенное баллов (0–10) по осям. Оси без данных за период
                  исключаются, их вес перераспределяется на остальные.</>
                }
              >
                <div className="flex flex-col gap-1.5">
                  {axes.length === 0 && (
                    <div className="text-sm text-[var(--color-text-muted)] px-1 py-2">Добавьте оси из каталога метрик</div>
                  )}
                  {axes.map((a, i) => (
                    <AxisRow
                      key={a.metricKey}
                      index={i} total={axes.length} axis={a}
                      label={axisLabels[i]}
                      weightShare={weightSum > 0 ? a.weight / weightSum : null}
                      onMove={dir => moveAxis(i, dir)}
                      onInvert={v => setAxisInvert(i, v)}
                      onWeight={v => setAxisWeight(i, v)}
                      onRemove={() => removeAxis(a.metricKey)}
                    />
                  ))}
                </div>
              </SectionCard>

              <SectionCard
                title="Плитки итогов"
                count={String(tiles.length)}
                right={<MetricPickerButton entries={tilePickerEntries} onPick={e => addTile(e.key)} />}
                hint="Порядок плиток — как в карточке. Количество не ограничено."
              >
                <div className="flex flex-col gap-1.5">
                  {tiles.length === 0 && (
                    <div className="text-sm text-[var(--color-text-muted)] px-1 py-2">Добавьте плитки из каталога метрик</div>
                  )}
                  {tiles.map((key, i) => (
                    <TileRow
                      key={key}
                      index={i} total={tiles.length}
                      label={labelForTile(key, catalog.legacyTiles, catalog.metrics)}
                      onMove={dir => moveTile(i, dir)}
                      onRemove={() => removeTile(key)}
                    />
                  ))}
                </div>
              </SectionCard>
            </div>
          </div>

          {/* ── Липкая панель сохранения ── */}
          <div className="sticky bottom-0 mt-5 -mx-3 sm:-mx-6 px-3 sm:px-6 py-3 bg-[var(--color-bg)] border-t border-[var(--color-border)] flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-40 transition-opacity"
            >
              {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
            {isDirty && !saving && (
              <span className="text-xs font-medium text-[var(--color-accent)]">● Есть несохранённые изменения</span>
            )}
            {message && (
              <span className={`text-sm ${message.type === 'success' ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}`}>
                {message.text}
              </span>
            )}
          </div>
        </>
      )}

      <UnsavedChangesDialog
        open={dialogOpen}
        onSave={handleDialogSave}
        onDiscard={confirmDiscard}
        onCancel={cancel}
      />
    </div>
  );
}
