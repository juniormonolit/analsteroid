'use client';
// «Мой отчёт» — конструктор отчётов в BB-коде (спека REPORT_CONSTRUCTOR_SPEC.md).
//
// Слева шаблон (дата, период, сущности, метрики), справа область печати. Жмёшь
// «Собрать отчёт» — отчёт СОБИРАЕТСЯ на глазах, по словам, с докруткой цифр.
// Кнопки «Пропустить» нет: решение владельца, сборка это способ показа отчёта,
// а не заставка перед ним. «Копировать» активна только после финиша — иначе
// человек унесёт в чат недособранный текст.
//
// Адаптив: одна колонка до lg, две — на десктопе. Область печати на телефоне
// идёт под конструктором, а не рядом (правило 9 CLAUDE.md).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardCheck, Copy, Play, Plus, Save, Star, Trash2, X } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import type { ReportSpec } from '@/features/reports-builder/engine/buildReportText';
import { useReportAssembly } from './useReportAssembly';

type PeriodKey = 'day' | 'week' | 'month';
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'day', label: 'День' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
];

type EntityInput = { kind: 'self' } | { kind: 'department'; id: string } | { kind: 'branch'; id: string };
interface ChosenEntity { input: EntityInput; label: string }

interface EntitiesResponse {
  self: { managerId: string; name: string } | null;
  departments: { id: string; name: string }[];
  branches: { id: string; name: string }[];
}

interface CatalogMetric {
  id: string;
  nameRu: string;
  nameShortRu: string | null;
  category: string | null;
  isCore: boolean;
}

interface TemplateState {
  period: PeriodKey;
  entities: EntityInput[];
  metricIds: string[];
}
interface Template {
  id: string;
  name: string;
  kind: 'preset' | 'personal';
  isDefault: boolean;
  state: TemplateState;
}

// Запасной набор на случай, если пресетов по роли не пришло вовсе (аккаунт без
// привязки к Битриксу и без отделов). Пустой лист человек читает как поломку.
const DEFAULT_METRICS = ['primary_sales_amount', 'repeat_sales_amount', 'primary_deals_count'];

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function entityKey(e: EntityInput): string {
  return e.kind === 'self' ? 'self' : `${e.kind}:${e.id}`;
}

export function MyReportPage() {
  const [date, setDate] = useState(todayStr);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [entities, setEntities] = useState<ChosenEntity[]>([{ input: { kind: 'self' }, label: 'Я' }]);
  const [metricIds, setMetricIds] = useState<string[]>(DEFAULT_METRICS);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);

  const assembly = useReportAssembly();
  const queryClient = useQueryClient();

  const { data: available } = useQuery<EntitiesResponse>({
    queryKey: ['my-report-entities'],
    queryFn: async () => {
      const res = await fetch('/api/my-report/entities');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: catalog } = useQuery<{ metrics: CatalogMetric[] }>({
    queryKey: ['catalog-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/catalog/metrics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: templatesData } = useQuery<{ templates: Template[]; storageReady: boolean }>({
    queryKey: ['my-report-templates'],
    queryFn: async () => {
      const res = await fetch('/api/my-report/templates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const chosenKeys = useMemo(() => new Set(entities.map(e => entityKey(e.input))), [entities]);

  // Подпись сущности берём из доступного человеку списка: шаблон хранит только
  // id, а название отдела могло измениться (или доступ к нему пропасть).
  const labelFor = useCallback((input: EntityInput): string | null => {
    if (input.kind === 'self') return available?.self?.name ?? null;
    const list = input.kind === 'department' ? available?.departments : available?.branches;
    return list?.find(x => x.id === input.id)?.name ?? null;
  }, [available]);

  const applyTemplate = useCallback((tpl: Template) => {
    const resolved = tpl.state.entities
      .map(input => ({ input, label: labelFor(input) }))
      .filter((e): e is ChosenEntity => e.label !== null);
    if (resolved.length === 0) return;
    setPeriod(tpl.state.period);
    setEntities(resolved);
    setMetricIds(tpl.state.metricIds);
    setActiveTemplate(tpl.id);
    assembly.reset();
  }, [assembly, labelFor]);

  // Шаблон по умолчанию применяется ОДИН раз на монтирование: иначе он
  // затирал бы то, что человек уже настроил руками (или после каждого refetch
  // отбрасывал бы его правки — ровно то, за что интерфейсы ненавидят).
  const presetApplied = useRef(false);
  useEffect(() => {
    if (presetApplied.current || !templatesData || !available) return;
    const list = templatesData.templates;
    const chosen = list.find(t => t.isDefault) ?? list[0];
    presetApplied.current = true;
    if (chosen) applyTemplate(chosen);
  }, [templatesData, available, applyTemplate]);

  // Любая правка руками снимает отметку с шаблона: подсвеченный чип при уже
  // изменённом наборе — прямая ложь о том, что сейчас соберётся.
  const touched = useCallback(() => {
    setActiveTemplate(null);
    assembly.reset();
  }, [assembly]);

  const addEntity = useCallback((input: EntityInput, label: string) => {
    setEntities(prev => (prev.some(e => entityKey(e.input) === entityKey(input)) ? prev : [...prev, { input, label }]));
    touched();
  }, [touched]);

  const removeEntity = useCallback((key: string) => {
    setEntities(prev => (prev.length <= 1 ? prev : prev.filter(e => entityKey(e.input) !== key)));
    touched();
  }, [touched]);

  const toggleMetric = useCallback((id: string) => {
    setMetricIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    touched();
  }, [touched]);

  const saveTemplate = useCallback(async (name: string, isDefault: boolean) => {
    const res = await fetch('/api/my-report/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, isDefault, state: { period, entities: entities.map(e => e.input), metricIds } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ['my-report-templates'] });
    setActiveTemplate(body.id as string);
  }, [entities, metricIds, period, queryClient]);

  const deleteTemplate = useCallback(async (id: string) => {
    const res = await fetch(`/api/my-report/templates?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) return;
    await queryClient.invalidateQueries({ queryKey: ['my-report-templates'] });
    if (activeTemplate === id) setActiveTemplate(null);
  }, [activeTemplate, queryClient]);

  const build = useCallback(async () => {
    setError(null);
    setCopied(false);
    setLoading(true);
    assembly.reset();
    try {
      const res = await fetch('/api/my-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, period, entities: entities.map(e => e.input), metricIds }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      // Анимация запускается ТОЛЬКО поверх полученных данных: при обрыве связи
      // иначе собрался бы полуотчёт, который человек скопирует и отправит.
      assembly.start(body.spec as ReportSpec);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось собрать отчёт');
    } finally {
      setLoading(false);
    }
  }, [assembly, date, period, entities, metricIds]);

  const copy = useCallback(async () => {
    if (!assembly.done) return;
    await navigator.clipboard.writeText(assembly.fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [assembly.done, assembly.fullText]);

  const metrics = catalog?.metrics ?? [];
  const selectedMetrics = metricIds
    .map(id => metrics.find(m => m.id === id))
    .filter((m): m is CatalogMetric => !!m);

  return (
    <div className="p-3 sm:p-4 lg:p-6">
      <h1 className="text-lg sm:text-xl font-semibold mb-1">Мой отчёт</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-4">
        Состояние на сегодня и как идём по плану. Собери отчёт и скопируй в чат.
      </p>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr] items-start">
        {/* ── Шаблон ─────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 sm:p-4">
          <TemplateBar
            templates={templatesData?.templates ?? []}
            storageReady={templatesData?.storageReady ?? true}
            activeId={activeTemplate}
            onApply={applyTemplate}
            onSave={saveTemplate}
            onDelete={deleteTemplate}
          />

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Дата</span>
            <input
              type="date"
              value={date}
              // Дата в шаблон НЕ входит (отчёт всегда про «сегодня»), поэтому
              // её смена не снимает отметку с шаблона — только сбрасывает сборку.
              onChange={e => { setDate(e.target.value); assembly.reset(); }}
              // text-base на мобильном — иначе iOS зумит страницу при фокусе (правило 9).
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[16px] sm:text-sm"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Период</span>
            <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              {PERIODS.map(p => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => { setPeriod(p.key); touched(); }}
                  className={`min-h-11 flex-1 text-sm transition-colors ${
                    period === p.key
                      ? 'bg-[var(--color-accent)] text-white font-medium'
                      : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
              «% ПЛАНА» всегда показывает день, неделю и месяц — период задаёт остальные метрики.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Кто в отчёте</span>
            <div className="flex flex-wrap gap-1.5">
              {entities.map(e => {
                const key = entityKey(e.input);
                return (
                  <span key={key} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] pl-2.5 pr-1 py-1 text-sm">
                    {e.label}
                    {entities.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeEntity(key)}
                        aria-label={`Убрать ${e.label}`}
                        className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </span>
                );
              })}
              <Popover
                className="w-[260px] max-w-[calc(100vw-24px)]"
                trigger={
                  <button type="button" className="tap-target inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2.5 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    <Plus size={13} /> Добавить
                  </button>
                }
              >
                <div className="max-h-64 overflow-y-auto p-1">
                  {available?.self && !chosenKeys.has('self') && (
                    <button type="button" onClick={() => addEntity({ kind: 'self' }, available.self!.name)}
                      className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                      {available.self.name} (я)
                    </button>
                  )}
                  {available?.departments.map(d => chosenKeys.has(`department:${d.id}`) ? null : (
                    <button key={d.id} type="button" onClick={() => addEntity({ kind: 'department', id: d.id }, d.name)}
                      className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                      {d.name}
                    </button>
                  ))}
                  {available?.branches.map(b => chosenKeys.has(`branch:${b.id}`) ? null : (
                    <button key={b.id} type="button" onClick={() => addEntity({ kind: 'branch', id: b.id }, b.name)}
                      className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                      {b.name}
                    </button>
                  ))}
                </div>
              </Popover>
            </div>
            {entities.length > 1 && (
              <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
                Метрики общие для всех — в конце отчёта появится агрегат.
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">
              Показатели ({selectedMetrics.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {selectedMetrics.map(m => (
                <span key={m.id} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-bg)] border border-[var(--color-border)] pl-2.5 pr-1 py-1 text-sm">
                  {m.nameShortRu || m.nameRu}
                  <button type="button" onClick={() => toggleMetric(m.id)} aria-label={`Убрать ${m.nameRu}`}
                    className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]">
                    <X size={13} />
                  </button>
                </span>
              ))}
              <MetricPicker metrics={metrics} selected={metricIds} onToggle={toggleMetric} />
            </div>
          </div>

          <button
            type="button"
            onClick={build}
            disabled={loading || assembly.running || metricIds.length === 0}
            className="min-h-11 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
          >
            <Play size={15} />
            {assembly.running ? 'Собирается…' : loading ? 'Считаю…' : 'Собрать отчёт'}
          </button>
          {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}
        </div>

        {/* ── Область печати ─────────────────────────────────────── */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] overflow-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Предпросмотр (BB-код)</span>
            <button
              type="button"
              onClick={copy}
              disabled={!assembly.done}
              title={assembly.done ? 'Скопировать в буфер' : 'Кнопка станет активной, когда отчёт соберётся'}
              className="min-h-11 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm disabled:opacity-40"
            >
              {copied ? <ClipboardCheck size={14} /> : <Copy size={14} />}
              {copied ? 'Скопировано' : 'Копировать'}
            </button>
          </div>

          {assembly.running && (
            <div className="h-0.5 bg-[var(--color-border)]">
              <div className="h-full bg-[var(--color-accent)] transition-[width] duration-100"
                style={{ width: `${Math.round(assembly.progress * 100)}%` }} />
            </div>
          )}

          <div className="p-3 min-h-[240px]">
            {assembly.lines.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Нажми «Собрать отчёт» — он соберётся здесь.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed">
                {assembly.lines.join('\n')}
                {assembly.running && <span className="animate-pulse">▌</span>}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Полоса шаблонов. Пресеты по роли — слева, личные с крестиком, справа
 * «Сохранить». Без скролла: шаблонов у человека единицы, а `flex-wrap` вообще
 * снимает класс багов правила 12 (уехавшая вбок страница на свайпе).
 */
function TemplateBar({ templates, storageReady, activeId, onApply, onSave, onDelete }: {
  templates: Template[];
  storageReady: boolean;
  activeId: string | null;
  onApply: (tpl: Template) => void;
  onSave: (name: string, isDefault: boolean) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [asDefault, setAsDefault] = useState(true);
  const [open, setOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trimmed, asDefault);
      setOpen(false);
      setName('');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">Шаблон</span>
      <div className="flex flex-wrap gap-1.5">
        {templates.map(t => {
          const active = t.id === activeId;
          return (
            <span
              key={t.id}
              className={`inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1 py-1 text-sm ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
                  : 'border-[var(--color-border)] bg-[var(--color-bg)]'
              }`}
            >
              <button type="button" onClick={() => onApply(t)} className="tap-target">
                {t.isDefault && <Star size={11} className="mr-1 inline shrink-0" />}
                {t.name}
              </button>
              {t.kind === 'personal' ? (
                <button
                  type="button"
                  onClick={() => onDelete(t.id)}
                  aria-label={`Удалить шаблон ${t.name}`}
                  className={`tap-target ${active ? 'text-white/70 hover:text-white' : 'text-[var(--color-text-muted)] hover:text-[var(--color-negative)]'}`}
                >
                  <Trash2 size={12} />
                </button>
              ) : (
                <span className="w-1" />
              )}
            </span>
          );
        })}

        <Popover
          open={open}
          onOpenChange={setOpen}
          className="w-[260px] max-w-[calc(100vw-24px)]"
          trigger={
            <button type="button" className="tap-target inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2.5 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              <Save size={13} /> Сохранить
            </button>
          }
        >
          <div className="flex flex-col gap-2 p-3">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void submit(); }}
              placeholder="Название шаблона"
              autoFocus
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[16px] sm:text-sm outline-none"
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={asDefault} onChange={e => setAsDefault(e.target.checked)} />
              Открывать по умолчанию
            </label>
            {saveError && <p className="text-[16px] sm:text-xs text-[var(--color-negative)]">{saveError}</p>}
            <button
              type="button"
              onClick={submit}
              disabled={saving || !name.trim()}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </Popover>
      </div>
      {!storageReady && (
        <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
          Свои шаблоны пока не сохраняются — не применена миграция 156. Пресеты по роли работают.
        </span>
      )}
    </div>
  );
}

function MetricPicker({ metrics, selected, onToggle }: {
  metrics: CatalogMetric[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? metrics.filter(m => m.nameRu.toLowerCase().includes(q)) : metrics.filter(m => m.isCore);
    return base.slice(0, 200);
  }, [metrics, query]);

  return (
    <Popover
      className="w-[300px] max-w-[calc(100vw-24px)]"
      trigger={
        <button type="button" className="tap-target inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2.5 py-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          <Plus size={13} /> Показатель
        </button>
      }
    >
      <div className="flex flex-col">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Поиск показателя"
          className="min-h-11 border-b border-[var(--color-border)] bg-transparent px-3 text-[16px] sm:text-sm outline-none"
        />
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <p className="px-2 py-3 text-sm text-[var(--color-text-muted)]">Ничего не нашлось</p>
          )}
          {filtered.map(m => {
            const on = selected.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onToggle(m.id)}
                className="min-h-11 w-full flex items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]"
              >
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                  on ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)]'
                }`}>
                  {on && <Check size={11} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{m.nameRu}</span>
              </button>
            );
          })}
        </div>
        {!query && (
          <p className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            Показаны основные. Ищи по названию, чтобы добавить любой показатель каталога.
          </p>
        )}
      </div>
    </Popover>
  );
}
