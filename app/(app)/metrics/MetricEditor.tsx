'use client';
import { useState, useEffect } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SLIDE_BACKDROP_BG } from '@/components/ui/SlideBackdrop';

type AggFn = 'count_distinct' | 'sum' | 'avg' | 'count_all';
type MetricSource = 'deals' | 'deal_events';
type MetricType = 'collected' | 'calculated';
type DataType = 'int' | 'decimal' | 'money' | 'percent' | 'months';

interface MetricFilter { field: string; op: string; value: string; }

export interface MetricDraft {
  id: string;
  name_ru: string;
  name_short_ru: string;
  description: string;
  category: string;
  metric_type: MetricType;
  data_type: DataType;
  decimal_places: number;
  aggregation_fn: string;
  sort_order: number;
  // collected
  source: MetricSource;
  agg_fn: AggFn | '';
  agg_field: string;
  date_field: string;
  filters: MetricFilter[];
  // calculated
  formula: string;
  dependencies: string[];
  // status
  is_core: boolean;
  is_active: boolean;
  is_hidden_in_ui: boolean;
  is_test: boolean;
  is_collect_ok: boolean;
  is_calc_ok: boolean;
  tags: string[];
}

const EMPTY: MetricDraft = {
  id: '', name_ru: '', name_short_ru: '', description: '', category: '',
  metric_type: 'collected', data_type: 'int', decimal_places: 0,
  aggregation_fn: 'sum', sort_order: 999,
  source: 'deals', agg_fn: 'count_distinct', agg_field: 'deal_id', date_field: 'created_at',
  filters: [], formula: '', dependencies: [],
  is_core: false, is_active: false, is_hidden_in_ui: false, is_test: false,
  is_collect_ok: false, is_calc_ok: false, tags: [],
};

const DATE_FIELDS_DEALS  = ['created_at', 'reserved_at', 'confirmed_at', 'sold_at', 'delivered_at', 'lost_at'];
const DATE_FIELDS_EVENTS = ['event_at', 'recorded_at'];
const AGG_FIELDS_DEALS   = ['deal_id', 'amount'];
const AGG_FIELDS_EVENTS  = ['deal_id', 'id'];
const FUNNEL_TYPE_OPTS   = ['primary', 'repeat', 'b2c', 'b2b'];
const EVENT_TYPE_OPTS    = ['created', 'called', 'reserved', 'confirmed', 'sold', 'shipped', 'lost'];
const CATEGORIES         = ['Входящие', 'Брони', 'Продажи', 'Отгрузки', 'Конверсии', 'Суммы', 'Средние', 'Прочие'];

interface Props {
  initial?: Partial<MetricDraft>;
  existingIds: string[];
  onSave: (d: MetricDraft) => Promise<void>;
  onClose: () => void;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-text-muted)] font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-[var(--color-text-muted)]/60 mt-0.5">{hint}</span>}
    </label>
  );
}

// text-base на мобильном: <16px заставляет iOS зумить страницу при фокусе инпута
const inp = 'w-full px-2.5 py-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-base sm:text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]';
const sel = inp;
const chk = 'rounded border-[var(--color-border)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]';

function FilterRow({
  f, onChange, onRemove, source,
}: {
  f: MetricFilter;
  onChange: (f: MetricFilter) => void;
  onRemove: () => void;
  source: MetricSource;
}) {
  const isEventType = f.field === 'event_type';
  const isFunnelType = f.field === 'funnel_type';

  return (
    <div className="flex items-end gap-2 p-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex-1 flex flex-col gap-1">
        <span className="text-xs text-[var(--color-text-muted)]">Поле</span>
        <select
          className={sel}
          value={f.field}
          onChange={e => onChange({ ...f, field: e.target.value, value: '' })}
        >
          <option value="funnel_type">Тип воронки</option>
          {source === 'deal_events' && <option value="event_type">Тип события</option>}
          <option value="stage_id">stage_id</option>
          <option value="funnel_id">funnel_id</option>
        </select>
      </div>
      <div className="w-20 flex flex-col gap-1">
        <span className="text-xs text-[var(--color-text-muted)]">Оператор</span>
        <select
          className={sel}
          value={f.op}
          onChange={e => onChange({ ...f, op: e.target.value })}
        >
          <option value="eq">=</option>
          <option value="neq">≠</option>
          <option value="in">IN</option>
          <option value="not_in">NOT IN</option>
          <option value="is_null">IS NULL</option>
          <option value="is_not_null">IS NOT NULL</option>
        </select>
      </div>
      <div className="flex-1 flex flex-col gap-1">
        <span className="text-xs text-[var(--color-text-muted)]">Значение</span>
        {(isFunnelType || isEventType) ? (
          <select
            className={sel}
            value={f.value}
            onChange={e => onChange({ ...f, value: e.target.value })}
          >
            <option value="">—</option>
            {(isFunnelType ? FUNNEL_TYPE_OPTS : EVENT_TYPE_OPTS).map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : (
          <input
            className={inp}
            placeholder="значение"
            value={f.value}
            onChange={e => onChange({ ...f, value: e.target.value })}
          />
        )}
      </div>
      <button onClick={onRemove} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)] p-1.5 rounded hover:bg-[var(--color-border)]">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

export function MetricEditor({ initial, existingIds, onSave, onClose }: Props) {
  const [d, setD] = useState<MetricDraft>({ ...EMPTY, ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tagInput, setTagInput] = useState('');
  const isNew = !initial?.id;
  const { closing, requestClose } = useSlideClose(onClose);

  useEffect(() => { setD({ ...EMPTY, ...initial }); }, [initial?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function set<K extends keyof MetricDraft>(k: K, v: MetricDraft[K]) {
    setD(p => ({ ...p, [k]: v }));
  }

  function addFilter() {
    set('filters', [...d.filters, { field: 'funnel_type', op: 'eq', value: '' }]);
  }

  function updateFilter(i: number, f: MetricFilter) {
    const next = [...d.filters];
    next[i] = f;
    set('filters', next);
  }

  function removeFilter(i: number) {
    set('filters', d.filters.filter((_, j) => j !== i));
  }

  function addTag(e: React.KeyboardEvent) {
    if (e.key !== 'Enter' && e.key !== ',') return;
    e.preventDefault();
    const t = tagInput.trim();
    if (t && !d.tags.includes(t)) set('tags', [...d.tags, t]);
    setTagInput('');
  }

  async function handleSave() {
    if (!d.id.trim()) { setError('ID обязателен'); return; }
    if (!d.name_ru.trim()) { setError('Название обязательно'); return; }
    if (isNew && existingIds.includes(d.id)) { setError('ID уже существует'); return; }
    setSaving(true);
    try {
      await onSave(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setSaving(false);
    }
  }

  const dateFields = d.source === 'deal_events' ? DATE_FIELDS_EVENTS : DATE_FIELDS_DEALS;
  const aggFields  = d.source === 'deal_events' ? AGG_FIELDS_EVENTS  : AGG_FIELDS_DEALS;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className={`flex-1 ${SLIDE_BACKDROP_BG} slide-backdrop-fade ${closing ? 'opacity-0' : 'opacity-100'}`} onClick={requestClose} />
      <aside className={`relative w-[800px] max-w-full bg-[var(--color-bg-surface)] border-l border-[var(--color-border)] flex flex-col h-full shadow-2xl ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}>
        <PanelCloseTab onClick={requestClose} />
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-semibold text-[var(--color-text)]">
            {isNew ? 'Новая метрика' : `Редактировать: ${d.name_ru}`}
          </h2>
          <button onClick={requestClose} className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] p-1 rounded">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">

          {/* Basic */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Основное</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="ID (системный, уникальный)"
                hint="Уникальный идентификатор. Используется в формулах как [id]. Латиница, подчеркивания, цифры. Не менять для существующих метрик."
              >
                <input
                  className={inp}
                  value={d.id}
                  readOnly={!isNew}
                  placeholder="primary_sales_count"
                  onChange={e => set('id', e.target.value.replace(/\s/g, '_').toLowerCase())}
                />
              </Field>
              <Field
                label="Тип"
                hint="Собираемая = читаем из deals/deal_events. Вычисляемая = формула из других метрик."
              >
                <select className={sel} value={d.metric_type} onChange={e => set('metric_type', e.target.value as MetricType)}>
                  <option value="collected">Собираемая</option>
                  <option value="calculated">Вычисляемая</option>
                </select>
              </Field>
            </div>
            <Field
              label="Название"
              hint="Отображается в пикере и таблице отчёта. Например: 'Продажи (первичные)' или 'Конверсия брони в продажу'."
            >
              <input className={inp} value={d.name_ru} onChange={e => set('name_ru', e.target.value)} placeholder="Продажи (перв.)" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                label="Краткое название"
                hint="Показывается в заголовке колонки таблицы, когда много метрик. Макс 8 символов."
              >
                <input className={inp} value={d.name_short_ru} onChange={e => set('name_short_ru', e.target.value)} placeholder="Прод." />
              </Field>
              <Field
                label="Категория"
                hint="Группировка в пикере метрик. Помогает пользователю быстро найти нужную метрику."
              >
                <select className={sel} value={d.category} onChange={e => set('category', e.target.value)}>
                  <option value="">—</option>
                  {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <Field
              label="Описание"
              hint="Полная формула расчёта, единицы, исключения. Видно при наведении на инфо-иконку в отчёте."
            >
              <textarea className={`${inp} resize-none h-16`} value={d.description} onChange={e => set('description', e.target.value)} />
            </Field>
          </section>

          {/* Format */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Формат вывода</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field
                label="Тип данных"
                hint="Целое: 1234. Дробное: 1234.56. Деньги: 1,234₽. Процент: 12.34%. Месяцы: 3м."
              >
                <select className={sel} value={d.data_type} onChange={e => set('data_type', e.target.value as DataType)}>
                  <option value="int">Целое</option>
                  <option value="decimal">Дробное</option>
                  <option value="money">Деньги</option>
                  <option value="percent">Процент</option>
                  <option value="months">Месяцы</option>
                </select>
              </Field>
              <Field
                label="Знаков после запятой"
                hint="Только для Дробное, Деньги, Процент. 0 = округление до целого."
              >
                <input type="number" className={inp} min={0} max={6} value={d.decimal_places} onChange={e => set('decimal_places', Number(e.target.value))} />
              </Field>
              <Field
                label="Агрегация строк"
                hint="Сумма = складываем значения всех менеджеров. Среднее = среднее. Нет = не складываем."
              >
                <select className={sel} value={d.aggregation_fn} onChange={e => set('aggregation_fn', e.target.value)}>
                  <option value="sum">Сумма</option>
                  <option value="avg">Среднее</option>
                  <option value="none">Нет</option>
                </select>
              </Field>
            </div>
          </section>

          {/* Logic */}
          {d.metric_type === 'collected' && (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Логика сбора</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label="Источник"
                  hint="deals = таблица сделок (created_at, sold_at и т.д.). deal_events = события (звонки, смены статуса)."
                >
                  <select className={sel} value={d.source} onChange={e => { set('source', e.target.value as MetricSource); set('date_field', ''); set('agg_field', 'deal_id'); }}>
                    <option value="deals">deals</option>
                    <option value="deal_events">deal_events</option>
                  </select>
                </Field>
                <Field
                  label="Агрегация"
                  hint="COUNT DISTINCT = уникальные deal_id. SUM/AVG = сумма/среднее поля. COUNT ALL = все события."
                >
                  <select className={sel} value={d.agg_fn} onChange={e => set('agg_fn', e.target.value as AggFn)}>
                    <option value="count_distinct">COUNT DISTINCT</option>
                    <option value="sum">SUM</option>
                    <option value="avg">AVG</option>
                    <option value="count_all">COUNT ALL</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  label="Поле для агрегации"
                  hint="deal_id = кол-во сделок. amount = сумма денег. Используется с COUNT DISTINCT, SUM, AVG."
                >
                  <select className={sel} value={d.agg_field} onChange={e => set('agg_field', e.target.value)}>
                    {aggFields.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
                <Field
                  label="Поле даты (привязка к периоду)"
                  hint="Какое поле отсчитывает период. created_at = по дате создания. sold_at = по дате продажи и т.д."
                >
                  <select className={sel} value={d.date_field} onChange={e => set('date_field', e.target.value)}>
                    <option value="">—</option>
                    {dateFields.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                </Field>
              </div>

              {/* Filters */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--color-text-muted)]">Фильтры (необязательно)</span>
                  <button
                    onClick={addFilter}
                    className="flex items-center gap-1 text-xs text-[var(--color-accent)] hover:opacity-80"
                  >
                    <Plus size={12} /> Добавить
                  </button>
                </div>
                <p className="text-xs text-[var(--color-text-muted)]/70">
                  Ограничить метрику. Например: "только первичные сделки" или "только события type=called". Без фильтров = по всем.
                </p>
                {d.filters.map((f, i) => (
                  <FilterRow
                    key={i}
                    f={f}
                    source={d.source}
                    onChange={nf => updateFilter(i, nf)}
                    onRemove={() => removeFilter(i)}
                  />
                ))}
              </div>
            </section>
          )}

          {d.metric_type === 'calculated' && (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Формула</p>
              <Field label="Выражение (используй [metric_id])">
                <input
                  className={inp}
                  value={d.formula}
                  onChange={e => set('formula', e.target.value)}
                  placeholder="[primary_sales_count] / [primary_deals_count] * 100"
                />
              </Field>
              <p className="text-xs text-[var(--color-text-muted)]">
                Допустимые операторы: + − * / ( ). Ссылки на другие метрики: [metric_id]
              </p>
            </section>
          )}

          {/* Tags */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Теги (для поиска в пикере)</p>
            <div className="flex flex-wrap gap-1.5 min-h-8 p-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
              {d.tags.map(t => (
                <span key={t} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--color-accent)]/15 text-[var(--color-accent)] text-xs">
                  {t}
                  <button onClick={() => set('tags', d.tags.filter(x => x !== t))}><X size={10} /></button>
                </span>
              ))}
              <input
                className="flex-1 min-w-24 text-xs bg-transparent outline-none text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
                placeholder="Введи тег, Enter"
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={addTag}
              />
            </div>
          </section>

          {/* Status */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Статус</p>
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_collect_ok}
                  onChange={e => set('is_collect_ok', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">Собирается правильно</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Логика SQL верна, данные актуальны. Без галочки = метрика в разработке.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_calc_ok}
                  onChange={e => set('is_calc_ok', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">Считается правильно</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Формула верна, единицы правильные. Для вычисляемых = отм., для собираемых = фин. согласование.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_active}
                  onChange={e => set('is_active', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">Доступна в отчёте</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Показывается в пикере метрик и в отчётах. Без неё = видна только как зависимость других метрик.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_test}
                  onChange={e => set('is_test', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">Тест (с пометкой)</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Видна в отчёте, но помечена (тест). Помогает тестировать метрику перед выводом в prod.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_core}
                  onChange={e => set('is_core', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">По умолчанию</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Показывается в отчёте автоматом, без выбора пользователя. Остальные нужно выбирать в пикере.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[var(--color-text)] cursor-pointer">
                <input
                  type="checkbox"
                  className={chk}
                  checked={!!d.is_hidden_in_ui}
                  onChange={e => set('is_hidden_in_ui', e.target.checked)}
                />
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="font-medium">Только как зависимость</span>
                  <span className="text-xs text-[var(--color-text-muted)]">Скрыта в пикере. Видна только если её использует другая метрика в формуле.</span>
                </div>
              </label>
            </div>
          </section>

          {/* Sort */}
          <section>
            <Field label="Порядок сортировки">
              <input type="number" className={`${inp} w-24`} value={d.sort_order} onChange={e => set('sort_order', Number(e.target.value))} />
            </Field>
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-5 py-4 flex items-center justify-between">
          {error && <p className="text-sm text-[var(--color-negative)]">{error}</p>}
          {!error && <span />}
          <div className="flex gap-2">
            <button onClick={requestClose} className="px-4 py-2 rounded text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-bg-surface)]">
              Отмена
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded text-sm bg-[var(--color-accent)] text-[var(--color-text-inverse)] hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
