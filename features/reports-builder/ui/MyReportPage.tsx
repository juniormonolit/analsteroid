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
import { metricMatchesQuery, searchTokens } from '@/lib/metrics/searchText';
import { Popover } from '@/components/ui/Popover';
import type { ReportSpec } from '@/features/reports-builder/engine/buildReportText';
import { useReportAssembly } from './useReportAssembly';

type PeriodKey = 'day' | 'week' | 'month';
// Период показателей всегда месяц (решение владельца 07.09: пикер убран — сценария
// «неделя/день» у отчёта нет; «% ПЛАНА» и план/факт и так считаются своими окнами).
const PERIOD: PeriodKey = 'month';

type EntityInput = { kind: 'self' } | { kind: 'department'; id: string } | { kind: 'branch'; id: string };
interface ChosenEntity { input: EntityInput; label: string }

interface EntitiesResponse {
  self: { managerId: string; name: string } | null;
  // depth/path приходят из getAllDepartmentOptions — отступ по дереву и поиск
  // по пути в структуре (правка владельца 07.08).
  departments: { id: string; name: string; depth?: number; path?: string }[];
  branches: { id: string; name: string }[];
}

interface CatalogMetric {
  id: string;
  nameRu: string;
  nameShortRu: string | null;
  category: string | null;
  isCore: boolean;
}

interface EntityAlias { name?: string; short?: string }
interface TemplateState {
  period: PeriodKey;
  entities: EntityInput[];
  metricIds: string[];
  /** Заголовок отчёта и подписи сущностей/метрик в чате (правка владельца 07.09):
   *  в отчёте отделы и показатели зовутся не так, как в Монолитике. */
  title?: string;
  entityAliases?: Record<string, EntityAlias>;
  metricAliases?: Record<string, string>;
  showTotal?: boolean;
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
  const [entities, setEntities] = useState<ChosenEntity[]>([{ input: { kind: 'self' }, label: 'Я' }]);
  const [metricIds, setMetricIds] = useState<string[]>(DEFAULT_METRICS);
  const [title, setTitle] = useState('');
  const [entityAliases, setEntityAliases] = useState<Record<string, EntityAlias>>({});
  const [metricAliases, setMetricAliases] = useState<Record<string, string>>({});
  const [showTotal, setShowTotal] = useState(true);
  // Поиск в пикере «Кто в отчёте» — список стал всей оргструктурой (80 отделов).
  const [entitySearch, setEntitySearch] = useState('');
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

  // Поиск по пикеру: без учёта регистра, по названию И по пути в структуре
  // («нц» находит все отделы департамента НЦ). Пустой запрос пропускает всё.
  const matchesEntitySearch = useCallback((text: string) => {
    const q = entitySearch.trim().toLowerCase();
    return q === '' || text.toLowerCase().includes(q);
  }, [entitySearch]);

  const noEntityMatches = useMemo(() => {
    if (!available) return false;
    const selfOk = available.self && !chosenKeys.has('self') && matchesEntitySearch(available.self.name);
    const branchOk = available.branches.some(b => !chosenKeys.has(`branch:${b.id}`) && matchesEntitySearch(b.name));
    const deptOk = available.departments.some(d => !chosenKeys.has(`department:${d.id}`) && matchesEntitySearch(d.path ?? d.name));
    return !selfOk && !branchOk && !deptOk;
  }, [available, chosenKeys, matchesEntitySearch]);

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
    setEntities(resolved);
    setMetricIds(tpl.state.metricIds);
    setTitle(tpl.state.title ?? '');
    setEntityAliases(tpl.state.entityAliases ?? {});
    setMetricAliases(tpl.state.metricAliases ?? {});
    setShowTotal(tpl.state.showTotal !== false);
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

  const setEntityAlias = useCallback((key: string, alias: EntityAlias) => {
    setEntityAliases(prev => {
      const next = { ...prev };
      // Не тримим на вводе — иначе нельзя набрать пробел между словами; сервер
      // обрежет края сам (parseReportLabels).
      const clean: EntityAlias = {};
      if (alias.name) clean.name = alias.name;
      if (alias.short) clean.short = alias.short;
      if (clean.name || clean.short) next[key] = clean; else delete next[key];
      return next;
    });
    touched();
  }, [touched]);

  const setMetricAlias = useCallback((id: string, label: string) => {
    setMetricAliases(prev => {
      const next = { ...prev };
      if (label) next[id] = label; else delete next[id];
      return next;
    });
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
      body: JSON.stringify({ name, isDefault, state: { period: PERIOD, entities: entities.map(e => e.input), metricIds, title, entityAliases, metricAliases, showTotal } }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    await queryClient.invalidateQueries({ queryKey: ['my-report-templates'] });
    setActiveTemplate(body.id as string);
  }, [entities, metricIds, title, entityAliases, metricAliases, showTotal, queryClient]);

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
        body: JSON.stringify({ date, period: PERIOD, entities: entities.map(e => e.input), metricIds, title, entityAliases, metricAliases, showTotal }),
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
  }, [assembly, date, entities, metricIds, title, entityAliases, metricAliases, showTotal]);

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

      <div className="grid gap-4 lg:grid-cols-[minmax(440px,520px)_1fr] items-start">
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
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Заголовок отчёта</span>
            <input
              value={title}
              onChange={e => { setTitle(e.target.value); touched(); }}
              placeholder="Отчет МОСКВА"
              maxLength={80}
              className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[16px] sm:text-sm"
            />
            <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
              Пусто — «Отчет: …» из названий участников. Заголовок хранится в шаблоне.
            </span>
          </label>

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
                {/* Поиск — список теперь всё поддерево «Отдела продаж» (28 отделов
                    вместо 16, правка владельца 07.08). Ищем и по названию, и по пути
                    в структуре: «нц» находит все отделы департамента НЦ. */}
                <div className="p-1">
                  <input
                    value={entitySearch}
                    onChange={e => setEntitySearch(e.target.value)}
                    placeholder="Поиск по отделам продаж…"
                    className="mb-1 min-h-11 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm outline-none"
                  />
                  <div className="max-h-64 overflow-y-auto">
                    {available?.self && !chosenKeys.has('self') && matchesEntitySearch(available.self.name) && (
                      <button type="button" onClick={() => addEntity({ kind: 'self' }, available.self!.name)}
                        className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                        {available.self.name} (я)
                      </button>
                    )}
                    {available?.branches.map(b => chosenKeys.has(`branch:${b.id}`) || !matchesEntitySearch(b.name) ? null : (
                      <button key={b.id} type="button" onClick={() => addEntity({ kind: 'branch', id: b.id }, b.name)}
                        className="min-h-11 w-full rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                        {b.name}
                      </button>
                    ))}
                    {available?.departments.map(d => chosenKeys.has(`department:${d.id}`) || !matchesEntitySearch(d.path ?? d.name) ? null : (
                      // Отступ по глубине в структуре — видно, что «Отдел ЖБИ» это
                      // отдел департамента НЦ, а не корневой. При поиске отступы
                      // сохраняются: они же подсказывают, чей это отдел.
                      <button key={d.id} type="button" onClick={() => addEntity({ kind: 'department', id: d.id }, d.name)}
                        title={d.path ?? d.name}
                        style={{ paddingLeft: 8 + (d.depth ?? 0) * 12 }}
                        className="min-h-11 w-full rounded-md pr-2 text-left text-sm hover:bg-[var(--color-bg-hover)]">
                        {d.name}
                      </button>
                    ))}
                    {noEntityMatches && (
                      <div className="px-2 py-3 text-center text-xs text-[var(--color-text-muted)]">Ничего не нашлось</div>
                    )}
                  </div>
                </div>
              </Popover>
            </div>
            {entities.length > 1 && (
              <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
                Показатели — сводкой (итог + строка на участника), затем план/факт по каждому за месяц.
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

          {/* Названия в отчёте — таблицей в два столбца (правка владельца 07.09:
              карандаши у чипов «не попадёшь»): слева как в Монолитике, справа как
              печатать. Пустое поле — оставить название Монолитики. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Названия в отчёте</span>
            <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
              <div className="hidden sm:grid grid-cols-2 gap-2 px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg)] border-b border-[var(--color-border)]">
                <span>В Монолитике</span><span>В отчёте</span>
              </div>
              {entities.map(e => {
                const key = entityKey(e.input);
                const a = entityAliases[key] ?? {};
                return (
                  <div key={key} className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2 items-center px-3 py-1.5 border-b border-[var(--color-border)] last:border-b-0">
                    <span className="text-sm min-w-0 truncate" title={e.label}>{e.label}</span>
                    <div className="flex gap-1.5 min-w-0">
                      <input
                        value={a.name ?? ''}
                        onChange={ev => setEntityAlias(key, { ...a, name: ev.target.value })}
                        placeholder={e.label}
                        maxLength={60}
                        aria-label={`Название «${e.label}» в отчёте`}
                        className="min-h-11 sm:min-h-9 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm outline-none"
                      />
                      <input
                        value={a.short ?? ''}
                        onChange={ev => setEntityAlias(key, { ...a, short: ev.target.value })}
                        placeholder="кратко"
                        maxLength={20}
                        title="Кратко — для строки «ИТОГО (…)»"
                        aria-label={`Кратко для ИТОГО: ${e.label}`}
                        className="min-h-11 sm:min-h-9 w-20 sm:w-16 shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm outline-none"
                      />
                    </div>
                  </div>
                );
              })}
              {selectedMetrics.map(m => (
                <div key={m.id} className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2 items-center px-3 py-1.5 border-b border-[var(--color-border)] last:border-b-0">
                  <span className="text-sm min-w-0 truncate" title={m.nameRu}>{m.nameShortRu || m.nameRu}</span>
                  <input
                    value={metricAliases[m.id] ?? ''}
                    onChange={ev => setMetricAlias(m.id, ev.target.value)}
                    placeholder={m.nameShortRu || m.nameRu}
                    maxLength={60}
                    aria-label={`Название «${m.nameRu}» в отчёте`}
                    className="min-h-11 sm:min-h-9 min-w-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-[16px] sm:text-sm outline-none"
                  />
                </div>
              ))}
            </div>
            <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">
              Пустое поле — как в Монолитике. Второе поле у участника — короткое имя для «ИТОГО (…)».
            </span>
          </div>

          {entities.length > 1 && (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={showTotal} onChange={e => { setShowTotal(e.target.checked); touched(); }} />
              Блок «ИТОГО» в конце отчёта
            </label>
          )}

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
  // Тот же поиск, что в панели метрик отчёта (lib/metrics/searchText): токены в
  // любом порядке, разделители не мешают — «доля повтор сумм» находит «Доля
  // повторных продаж, % (сумма, по воронке)».
  const filtered = useMemo(() => {
    const tokens = searchTokens(query);
    const base = tokens.length ? metrics.filter(m => metricMatchesQuery(m, tokens)) : metrics.filter(m => m.isCore);
    return base.slice(0, 200);
  }, [metrics, query]);

  return (
    <Popover
      className="w-[400px] max-w-[calc(100vw-24px)]"
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
                <span className="min-w-0 flex-1 leading-snug">{m.nameRu}</span>
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
