'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { useUnsavedGuard } from '@/lib/hooks/useUnsavedGuard';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';

// Задача 10.07 (пакет «шаблоны карточек v2»), п.2: было — выбор из 8 зашитых осей
// (checkbox-список); стало — ЛЮБАЯ метрика полного каталога (~195 видимых), с
// превью-паутиной (номера позиций, 1 вверху → по часовой), изменяемым порядком
// (стрелки вверх/вниз) и тумблером «меньше — лучше» НА КАЖДОЙ оси (не хардкод в
// коде, как было). Хранение — {metricKey, invert}[] (миграция 075).
//
// Карточка v4 (задача 10.07, п.1): «Плитки итогов» — БЫЛО чекбокс-список из 6
// зашитых ключей («показывать/нет», порядок фиксирован); СТАЛО — ТОТ ЖЕ паттерн,
// что и оси выше: выбор из ВСЕГО каталога метрик, порядок настраивается стрелками,
// БЕЗ ограничения количества (в отличие от осей — там до maxAxes=6). Плиткам не
// нужен тумблер «меньше — лучше» (не участвуют в скоринге/перцентиле, только
// значение + Δ% к периоду сравнения) — поэтому SelectedTileRow проще SelectedAxisRow
// (нет invert-переключателя). Хранение — string[] (легаси-ключи с префиксом
// «legacy:» либо голый id каталога), миграция 083.

interface AxisConfig { metricKey: string; invert: boolean }
interface CatalogMetric { id: string; nameRu: string; category: string | null; dataType: string }
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

// ── Превью-паутина (задача 10.07, п.2): шестиугольник с номерами позиций,
// 1 вверху, дальше по часовой — та же угловая формула, что и настоящий радар
// карточки (ManagerCardRadar.tsx::axisAngle), обновляется живьём при
// добавлении/удалении/переупорядочивании осей. ──────────────────────────────
function AxisPreviewHexagon({ count }: { count: number }) {
  const n = Math.max(count, 1);
  const W = 240, H = 220, CX = 120, CY = 110, R = 78;
  function point(i: number) {
    const a = (-90 + i * (360 / n)) * (Math.PI / 180);
    return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
  }
  const pts = Array.from({ length: n }, (_, i) => point(i));
  const poly = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="mx-auto">
      {count > 0 && (
        <polygon points={poly} fill="var(--color-accent)" fillOpacity={0.12} stroke="var(--color-accent)" strokeWidth={1.5} />
      )}
      {pts.map((p, i) => (
        <g key={i} className={count === 0 ? 'opacity-30' : ''}>
          <line x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="var(--color-border)" strokeWidth={1} />
          <circle cx={p.x} cy={p.y} r={12} fill="var(--color-accent)" />
          <text x={p.x} y={p.y + 4.5} textAnchor="middle" fontSize={12} fontWeight={700} fill="var(--color-text-inverse)">{i + 1}</text>
        </g>
      ))}
    </svg>
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

// ── Строка выбранной оси: номер, имя, стрелки, тумблер invert, удаление ─────
function SelectedAxisRow({ index, total, axis, label, onMove, onInvert, onRemove }: {
  index: number; total: number; axis: AxisConfig; label: string;
  onMove: (dir: -1 | 1) => void; onInvert: (v: boolean) => void; onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)]">
      <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)] text-[11px] font-bold flex items-center justify-center">
        {index + 1}
      </span>
      <span className="flex-1 min-w-0 text-sm text-[var(--color-text)] truncate" title={label}>{label}</span>
      <button
        onClick={() => onMove(-1)}
        disabled={index === 0}
        className="p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Переместить выше"
        aria-label="Переместить выше"
      >
        <ArrowUp size={14} />
      </button>
      <button
        onClick={() => onMove(1)}
        disabled={index === total - 1}
        className="p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Переместить ниже"
        aria-label="Переместить ниже"
      >
        <ArrowDown size={14} />
      </button>
      <label className="flex items-center gap-1.5 pl-1.5 ml-1 border-l border-[var(--color-border)] cursor-pointer select-none" title="Меньше — лучше (инверсия рейтинга/шкалы)">
        <input type="checkbox" checked={axis.invert} onChange={e => onInvert(e.target.checked)} className="accent-[var(--color-accent)]" />
        <span className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">меньше — лучше</span>
      </label>
      <button onClick={onRemove} className="w-5 h-5 rounded-full hover:bg-[var(--color-negative)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center transition-colors" aria-label="Убрать ось">
        <X size={13} />
      </button>
    </div>
  );
}

// ── Строка выбранной плитки: номер, имя, стрелки, удаление (карточка v4, п.1 —
// БЕЗ тумблера invert, плиткам он не нужен, см. комментарий в шапке файла). ────
function SelectedTileRow({ index, total, label, onMove, onRemove }: {
  index: number; total: number; label: string;
  onMove: (dir: -1 | 1) => void; onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)]">
      <span className="w-6 h-6 shrink-0 rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)] text-[11px] font-bold flex items-center justify-center">
        {index + 1}
      </span>
      <span className="flex-1 min-w-0 text-sm text-[var(--color-text)] truncate" title={label}>{label}</span>
      <button
        onClick={() => onMove(-1)}
        disabled={index === 0}
        className="p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Переместить выше"
        aria-label="Переместить выше"
      >
        <ArrowUp size={14} />
      </button>
      <button
        onClick={() => onMove(1)}
        disabled={index === total - 1}
        className="p-1 rounded hover:bg-[var(--color-bg-hover)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        title="Переместить ниже"
        aria-label="Переместить ниже"
      >
        <ArrowDown size={14} />
      </button>
      <button onClick={onRemove} className="w-5 h-5 rounded-full hover:bg-[var(--color-negative)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center transition-colors" aria-label="Убрать плитку">
        <X size={13} />
      </button>
    </div>
  );
}

export default function CardTemplatesPage() {
  const [templateKey, setTemplateKey] = useState<TemplateKey>('manager');
  const [axes, setAxes] = useState<AxisConfig[] | null>(null);
  const [tiles, setTiles] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [axisSearch, setAxisSearch] = useState('');
  const [tileSearch, setTileSearch] = useState('');

  // ── Снимок последнего загруженного/сохранённого состояния — для гейта
  // несохранённых изменений (правило из DESIGN_GUIDELINES.md: любое закрытие с
  // несохранённым — диалог «Сохранить / Не сохранять / Отмена»). ───────────────
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
    setAxisSearch('');
    setTileSearch('');
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

  // Несохранённые изменения при закрытии вкладки/окна браузера (правило из
  // DESIGN_GUIDELINES.md — «при ЛЮБОМ закрытии с несохранённым — диалог», для
  // полностраничной настройки это beforeunload; переключение табов шаблона —
  // отдельный, явный триггер того же гейта, см. handleTemplateSwitch ниже).
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

  function addAxis(metricKey: string, defaultInvert: boolean) {
    if (!axes || axes.length >= maxAxes || axes.some(a => a.metricKey === metricKey)) return;
    setAxes([...axes, { metricKey, invert: defaultInvert }]);
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

  // ── Плитки итогов (карточка v4, п.1) — тот же приём, что оси, БЕЗ maxTiles
  // (количество не ограничено) и БЕЗ invert. ──────────────────────────────────
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
      setMessage({ type: 'success', text: 'Сохранено — изменения применятся ко всем карточкам этого типа' });
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

  // ── Каталог для пикера осей: легаси-оси (карточка, знакомые 8) + полный каталог,
  // сгруппированный по категории; фильтр по поисковой строке (id/имя/категория). ──
  const selectedAxisKeys = useMemo(() => new Set((axes ?? []).map(a => a.metricKey)), [axes]);
  const aq = axisSearch.trim().toLowerCase();
  const legacyAxesFiltered = useMemo(() => {
    if (!catalog) return [];
    return catalog.legacyAxes.filter(a => !aq || a.label.toLowerCase().includes(aq));
  }, [catalog, aq]);
  const axisCatalogByCategory = useMemo(() => {
    if (!catalog) return [] as [string, CatalogMetric[]][];
    const map = new Map<string, CatalogMetric[]>();
    for (const m of catalog.metrics) {
      if (aq && !m.nameRu.toLowerCase().includes(aq) && !m.id.toLowerCase().includes(aq) && !(m.category ?? '').toLowerCase().includes(aq)) continue;
      const cat = m.category ?? 'Прочее';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [catalog, aq]);

  // ── Каталог для пикера плиток (карточка v4, п.1): тот же принцип, что и оси —
  // легаси-6 + полный каталог по категориям; отдельная поисковая строка, т.к.
  // это независимая секция страницы (не связана с осями паутины). ────────────
  const selectedTileKeys = useMemo(() => new Set(tiles ?? []), [tiles]);
  const tq = tileSearch.trim().toLowerCase();
  const legacyTilesFiltered = useMemo(() => {
    if (!catalog) return [];
    return catalog.legacyTiles.filter(a => !tq || a.label.toLowerCase().includes(tq));
  }, [catalog, tq]);
  const tileCatalogByCategory = useMemo(() => {
    if (!catalog) return [] as [string, CatalogMetric[]][];
    const map = new Map<string, CatalogMetric[]>();
    for (const m of catalog.metrics) {
      if (tq && !m.nameRu.toLowerCase().includes(tq) && !m.id.toLowerCase().includes(tq) && !(m.category ?? '').toLowerCase().includes(tq)) continue;
      const cat = m.category ?? 'Прочее';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(m);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru'));
  }, [catalog, tq]);

  const atMaxAxes = (axes?.length ?? 0) >= maxAxes;

  return (
    <div className="p-3 sm:p-6 max-w-5xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Шаблоны карточек</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-5">
        Что показывать в карточке менеджера (профиль + ФИФА-сетка «Мой отдел») и в
        карточке отдела (РОП) — до {maxAxes} осей паутины из полного каталога метрик
        (продажи, конверсии, активность, звонки — не только исходные 8), порядок и
        «меньше — лучше» настраиваются на каждой оси, плюс плитки итогов — тоже из
        полного каталога метрик, без ограничения количества, порядок настраивается
        так же. Рейтинг считается по весам со страницы «Веса скоринга» — для осей
        без сохранённого веса вес по умолчанию 5. Изменение применяется сразу ко
        всем карточкам этого типа.
      </p>

      <div className="flex border border-[var(--color-border)] rounded-lg overflow-hidden text-sm mb-6 w-fit">
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

      {axes === null || tiles === null || catalog === null ? (
        <div className="text-sm text-[var(--color-text-muted)]">Загрузка...</div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr_1fr] gap-6 mb-8">
            {/* Превью-паутина */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
                Превью паутины
              </div>
              <div className="border border-[var(--color-border)] rounded-xl py-2">
                <AxisPreviewHexagon count={axes.length} />
              </div>
            </div>

            {/* Выбранные оси */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
                Оси паутины ({axes.length}/{maxAxes})
              </div>
              <div className="flex flex-col gap-1.5">
                {axes.length === 0 && (
                  <div className="text-sm text-[var(--color-text-muted)] px-1 py-2">Выберите оси из каталога справа</div>
                )}
                {axes.map((a, i) => (
                  <SelectedAxisRow
                    key={a.metricKey}
                    index={i} total={axes.length} axis={a}
                    label={labelFor(a.metricKey, catalog.legacyAxes, catalog.metrics)}
                    onMove={dir => moveAxis(i, dir)}
                    onInvert={v => setAxisInvert(i, v)}
                    onRemove={() => removeAxis(a.metricKey)}
                  />
                ))}
              </div>
            </div>

            {/* Каталог метрик (оси) */}
            <div>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
                Каталог метрик{atMaxAxes && ' (максимум осей достигнут)'}
              </div>
              <input
                type="text"
                value={axisSearch}
                onChange={e => setAxisSearch(e.target.value)}
                placeholder="Поиск по названию или категории…"
                className="w-full mb-2 px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
              <div className="border border-[var(--color-border)] rounded-lg max-h-[420px] overflow-y-auto">
                {legacyAxesFiltered.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg)] sticky top-0">
                      Классические (карточка)
                    </div>
                    {legacyAxesFiltered.map(a => {
                      const selected = selectedAxisKeys.has(a.metricKey);
                      return (
                        <button
                          key={a.metricKey}
                          onClick={() => addAxis(a.metricKey, a.defaultInvert)}
                          disabled={selected || atMaxAxes}
                          className={`w-full text-left px-3 py-2 text-sm border-t border-[var(--color-border)] transition-colors flex items-center justify-between gap-2 ${
                            selected ? 'text-[var(--color-text-muted)] bg-[var(--color-bg)]' : atMaxAxes ? 'text-[var(--color-text-muted)] opacity-50 cursor-not-allowed' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                          }`}
                        >
                          <span className="truncate">{a.label}</span>
                          {selected && <span className="text-[10px] shrink-0">выбрано</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {axisCatalogByCategory.map(([cat, ms]) => (
                  <div key={cat}>
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg)] sticky top-0">
                      {cat}
                    </div>
                    {ms.map(m => {
                      const selected = selectedAxisKeys.has(m.id);
                      return (
                        <button
                          key={m.id}
                          onClick={() => addAxis(m.id, false)}
                          disabled={selected || atMaxAxes}
                          className={`w-full text-left px-3 py-2 text-sm border-t border-[var(--color-border)] transition-colors flex items-center justify-between gap-2 ${
                            selected ? 'text-[var(--color-text-muted)] bg-[var(--color-bg)]' : atMaxAxes ? 'text-[var(--color-text-muted)] opacity-50 cursor-not-allowed' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                          }`}
                        >
                          <span className="truncate">{m.nameRu}</span>
                          {selected && <span className="text-[10px] shrink-0">выбрано</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {legacyAxesFiltered.length === 0 && axisCatalogByCategory.length === 0 && (
                  <div className="px-3 py-3 text-sm text-[var(--color-text-muted)]">Ничего не найдено</div>
                )}
              </div>
            </div>
          </div>

          {/* ── Плитки итогов (карточка v4, п.1): тот же паттерн, что оси паутины
              выше — выбранный список (с порядком, БЕЗ invert) слева, каталог метрик
              справа, БЕЗ ограничения количества. */}
          <div className="mb-6">
            <div className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)] mb-2">
              Плитки итогов
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Выбранные плитки */}
              <div>
                <div className="text-[11px] text-[var(--color-text-muted)] mb-2">
                  Выбрано: {tiles.length} — порядок как в карточке
                </div>
                <div className="flex flex-col gap-1.5">
                  {tiles.length === 0 && (
                    <div className="text-sm text-[var(--color-text-muted)] px-1 py-2">Выберите плитки из каталога справа</div>
                  )}
                  {tiles.map((key, i) => (
                    <SelectedTileRow
                      key={key}
                      index={i} total={tiles.length}
                      label={labelForTile(key, catalog.legacyTiles, catalog.metrics)}
                      onMove={dir => moveTile(i, dir)}
                      onRemove={() => removeTile(key)}
                    />
                  ))}
                </div>
              </div>

              {/* Каталог метрик (плитки) */}
              <div>
                <input
                  type="text"
                  value={tileSearch}
                  onChange={e => setTileSearch(e.target.value)}
                  placeholder="Поиск по названию или категории…"
                  className="w-full mb-2 px-3 py-1.5 text-sm border border-[var(--color-border)] rounded-lg bg-[var(--color-bg-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                />
                <div className="border border-[var(--color-border)] rounded-lg max-h-[420px] overflow-y-auto">
                  {legacyTilesFiltered.length > 0 && (
                    <div>
                      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg)] sticky top-0">
                        Классические (карточка)
                      </div>
                      {legacyTilesFiltered.map(a => {
                        const selected = selectedTileKeys.has(a.metricKey);
                        return (
                          <button
                            key={a.metricKey}
                            onClick={() => addTile(a.metricKey)}
                            disabled={selected}
                            className={`w-full text-left px-3 py-2 text-sm border-t border-[var(--color-border)] transition-colors flex items-center justify-between gap-2 ${
                              selected ? 'text-[var(--color-text-muted)] bg-[var(--color-bg)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                            }`}
                          >
                            <span className="truncate">{a.label}</span>
                            {selected && <span className="text-[10px] shrink-0">выбрано</span>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {tileCatalogByCategory.map(([cat, ms]) => (
                    <div key={cat}>
                      <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg)] sticky top-0">
                        {cat}
                      </div>
                      {ms.map(m => {
                        const selected = selectedTileKeys.has(m.id);
                        return (
                          <button
                            key={m.id}
                            onClick={() => addTile(m.id)}
                            disabled={selected}
                            className={`w-full text-left px-3 py-2 text-sm border-t border-[var(--color-border)] transition-colors flex items-center justify-between gap-2 ${
                              selected ? 'text-[var(--color-text-muted)] bg-[var(--color-bg)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
                            }`}
                          >
                            <span className="truncate">{m.nameRu}</span>
                            {selected && <span className="text-[10px] shrink-0">выбрано</span>}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {legacyTilesFiltered.length === 0 && tileCatalogByCategory.length === 0 && (
                    <div className="px-3 py-3 text-sm text-[var(--color-text-muted)]">Ничего не найдено</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm rounded-lg bg-[var(--color-accent)] text-[var(--color-text-inverse)] disabled:opacity-50"
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
            {isDirty && !saving && (
              <span className="text-xs text-[var(--color-text-muted)]">Есть несохранённые изменения</span>
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
