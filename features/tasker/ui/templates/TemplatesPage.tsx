'use client';
// «Задачник → Шаблоны» (/tasker/templates): конструктор шаблонов рекомендаций (правки собрания 23.11,
// TASKER_FEEDBACK_2026-11-23 п.4). Руководители пишут пошаговые инструкции на каждый показатель: несколько
// вариантов, ссылки и картинки, порядок (он же порядок в форме задачи), архив. Право action.tasker.templates
// (админ — и так). В форме задачи РОП выбирает вариант и дописывает своё.
// С миграции 282 здесь же темы: сначала тема (показатель каталога или товарная группа), под ней — варианты.
// Удаления темы нет — архив; старые задачи с архивной темой живут и замеряются.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, BarChart3, ImagePlus, Link2, Loader2, Package, Pencil, Plus, Trash2 } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  TASKER_METRIC_GROUP_LABELS, type TaskerMetric, type TaskerMetricGroup, type TaskerPgMeasure, type TaskerTemplateFull,
  type TaskerTopicKind, type TaskerTopicSaveRequest,
} from '../../types';
import { TaskerTabs } from '../shared/TaskerPage';
import { insertAt, renderTemplateBody } from './templateBody';
import {
  TEMPLATES_FULL_KEY, TOPICS_KEY, createTemplate, createTopic, deleteTemplate, fetchTemplatesFull, fetchTopicCatalog, fetchTopics,
  reorderTemplates, reorderTopics, updateTemplate, updateTopic, uploadTemplateImage,
} from './api';

const INPUT = 'w-full min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] sm:text-sm';
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50';
const PRIMARY = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50';
const ICON = 'tap-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] disabled:opacity-30';

// ── Редактор одного варианта ────────────────────────────────────────────────

function TemplateEditor({ initial, onSave, onCancel, saving, error }: {
  initial: { title: string; body: string };
  onSave: (v: { title: string; body: string }) => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [preview, setPreview] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const insert = (snippet: string) => {
    const { next, caret } = insertAt(ta.current, body, snippet);
    setBody(next);
    setPreview(false);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(caret, caret); });
  };

  const addLink = () => {
    const url = linkUrl.trim();
    if (!/^https?:\/\//i.test(url)) { setLocalErr('Ссылка должна начинаться с http:// или https://'); return; }
    const text = linkText.trim();
    insert(text ? `[URL=${url}]${text}[/URL]` : url);
    setLinkOpen(false); setLinkUrl(''); setLinkText(''); setLocalErr(null);
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setUploading(true); setLocalErr(null);
    try {
      const { url } = await uploadTemplateImage(f);
      insert(`[IMG]${url}[/IMG]\n`);
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : 'Не удалось загрузить картинку');
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };

  const shown = localErr ?? error;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-accent)] bg-[var(--color-bg-surface)] p-3">
      <input value={title} onChange={e => setTitle(e.target.value)} maxLength={120} placeholder="Название варианта, например «Разбор броней по отчёту»"
        aria-label="Название варианта" className={INPUT} />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setLinkOpen(o => !o)} className={BTN}><Link2 size={15} aria-hidden /> Ссылка</button>
        <button type="button" onClick={() => file.current?.click()} disabled={uploading} className={BTN}>
          {uploading ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <ImagePlus size={15} aria-hidden />} Картинка
        </button>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
          onChange={e => onFile(e.target.files?.[0])} />
        <div className="ml-auto flex rounded-lg border border-[var(--color-border)] p-0.5 text-sm">
          {(['Текст', 'Просмотр'] as const).map((l, i) => (
            <button key={l} type="button" onClick={() => setPreview(i === 1)} aria-pressed={preview === (i === 1)}
              className={`min-h-10 rounded-md px-3 ${preview === (i === 1) ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{l}</button>
          ))}
        </div>
      </div>
      {linkOpen && (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg bg-[var(--color-bg-hover)] p-2 sm:flex-row">
          <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://monolitika.mlt-it.ru/…" aria-label="Адрес ссылки" className={INPUT} />
          <input value={linkText} onChange={e => setLinkText(e.target.value)} placeholder="Текст ссылки (необязательно)" aria-label="Текст ссылки" className={INPUT} />
          <button type="button" onClick={addLink} className={`${PRIMARY} shrink-0`}>Вставить</button>
        </div>
      )}
      {preview ? (
        <div className="min-h-[160px] whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border)] p-3 text-sm leading-relaxed text-[var(--color-text)]">
          {body.trim() ? renderTemplateBody(body) : <span className="text-[var(--color-text-muted)]">Пусто</span>}
        </div>
      ) : (
        <textarea ref={ta} value={body} onChange={e => setBody(e.target.value)} rows={10} aria-label="Текст инструкции"
          placeholder={'Пошагово, что сделать. Например:\n1. Открыть Монолитику → отчёт «Базовый минимум» за прошлую неделю.\n2. Нажать на кол-во сделок, посмотреть «Созвонился и озвучил».\n3. …'}
          className={`${INPUT} min-h-[200px] resize-y py-2 leading-snug`} />
      )}
      <p className="text-xs text-[var(--color-text-muted)]">
        Картинка вставляется кодом [IMG]…[/IMG]: здесь видна картинкой, в задаче Битрикса — ссылкой «🖼 Картинка».
      </p>
      {shown && <p className="text-sm text-[var(--color-negative)]">{shown}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>Отмена</button>
        <button type="button" disabled={saving || !title.trim() || !body.trim()} onClick={() => onSave({ title, body })} className={PRIMARY}>
          {saving && <Loader2 size={15} className="animate-spin" aria-hidden />} Сохранить
        </button>
      </div>
    </div>
  );
}

// ── Карточка варианта ───────────────────────────────────────────────────────

function TemplateCard({ t, first, last, busy, onEdit, onMove, onArchive, onDelete }: {
  t: TaskerTemplateFull; first: boolean; last: boolean; busy: boolean;
  onEdit: () => void; onMove: (dir: -1 | 1) => void; onArchive: (active: boolean) => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const long = t.body.length > 280 || t.body.split('\n').length > 6;
  return (
    <article className={`flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 ${t.active ? '' : 'opacity-70'}`}>
      {/* Телефон: заголовок во всю ширину, иконки — строкой под ним (иначе заголовок сжат в столбик). */}
      <div className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <h3 className="min-w-0 basis-full break-words font-semibold text-[var(--color-text)] sm:basis-0 sm:flex-1">{t.title}</h3>
        <div className="flex shrink-0 items-center gap-0.5">
          {t.active && (
            <>
              <button type="button" disabled={first || busy} onClick={() => onMove(-1)} className={ICON} aria-label="Выше" title="Выше"><ArrowUp size={15} /></button>
              <button type="button" disabled={last || busy} onClick={() => onMove(1)} className={ICON} aria-label="Ниже" title="Ниже"><ArrowDown size={15} /></button>
            </>
          )}
          <button type="button" disabled={busy} onClick={onEdit} className={ICON} aria-label="Редактировать" title="Редактировать"><Pencil size={15} /></button>
          <button type="button" disabled={busy} onClick={() => onArchive(!t.active)} className={ICON}
            aria-label={t.active ? 'В архив' : 'Вернуть из архива'} title={t.active ? 'В архив' : 'Вернуть из архива'}>
            {t.active ? <Archive size={15} /> : <ArchiveRestore size={15} />}
          </button>
          {!t.active && (
            <button type="button" disabled={busy} onClick={onDelete} className={`${ICON} hover:text-[var(--color-negative)]`} aria-label="Удалить" title="Удалить навсегда"><Trash2 size={15} /></button>
          )}
        </div>
      </div>
      <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text-secondary)] ${long && !open ? 'line-clamp-6' : ''}`}>
        {renderTemplateBody(t.body)}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-text-muted)]">
        {long && (
          <button type="button" onClick={() => setOpen(o => !o)} className="min-h-8 text-[var(--color-accent)] hover:underline">{open ? 'Свернуть' : 'Показать целиком'}</button>
        )}
        <span>{t.updatedBy ? `Правил: ${t.updatedBy}` : 'Базовый шаблон'}
          {t.updatedAt && t.updatedBy ? `, ${new Date(t.updatedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : ''}</span>
        {!t.active && t.archivedAt && <span>В архиве с {new Date(t.archivedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>}
      </div>
    </article>
  );
}

// ── Тема: создание / правка ─────────────────────────────────────────────────

const GROUP_OPTIONS = (Object.keys(TASKER_METRIC_GROUP_LABELS) as TaskerMetricGroup[]).map(g => ({ value: g, label: TASKER_METRIC_GROUP_LABELS[g] }));
const FORMAT_OPTIONS = [{ value: 'percent', label: 'Проценты, %' }, { value: 'money', label: 'Деньги, ₽' }, { value: 'number', label: 'Число' }];

function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full flex-wrap rounded-lg border border-[var(--color-border)] p-0.5 sm:w-fit">
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}
          className={`min-h-10 flex-1 rounded-md px-3 text-sm sm:flex-none ${value === o.value ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const FIELD = 'flex min-w-0 flex-col gap-1 text-sm text-[var(--color-text-secondary)]';

function TopicForm({ topic, onDone, onCancel }: { topic?: TaskerMetric; onDone: (id: string) => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const isNew = !topic;
  const catalogQ = useQuery({ queryKey: ['tasker', 'topic-catalog'], queryFn: fetchTopicCatalog, enabled: isNew, staleTime: 10 * 60_000 });
  const [kind, setKind] = useState<TaskerTopicKind>(topic?.kind ?? 'metric');
  const [metricId, setMetricId] = useState('');
  const [pgId, setPgId] = useState('');
  const [measure, setMeasure] = useState<TaskerPgMeasure>('amount');
  const [label, setLabel] = useState(topic?.label ?? '');
  const [group, setGroup] = useState<TaskerMetricGroup | ''>(topic?.group ?? '');
  const [higher, setHigher] = useState<'up' | 'down'>(topic?.higherIsBetter === false ? 'down' : 'up');
  const [format, setFormat] = useState<TaskerMetric['format'] | ''>(topic?.format ?? '');
  const [err, setErr] = useState<string | null>(null);

  const cat = catalogQ.data;
  const picked = cat?.metrics.find(m => m.id === metricId);
  const pickedPg = cat?.productGroups.find(g => g.id === pgId);
  const defaultLabel = kind === 'metric' ? (picked?.shortName || picked?.name || '') : pickedPg ? (measure === 'share' ? `${pickedPg.name}: доля в продажах` : pickedPg.name) : '';
  const effFormat = kind === 'product_group' ? (measure === 'share' ? 'percent' : 'money') : (format || picked?.format || 'number');

  const save = useMutation({
    mutationFn: async () => {
      const common: TaskerTopicSaveRequest = {
        label: label.trim() || undefined,
        group: group || undefined,
        higherIsBetter: higher === 'up',
      };
      if (topic) return updateTopic(topic.id, { ...common, label: label.trim(), ...(topic.kind !== 'product_group' && format ? { format } : {}) });
      return createTopic(kind === 'metric'
        ? { ...common, kind, metricId, format: format || undefined }
        : { ...common, kind, productGroupId: pgId, pgMeasure: measure, group: group || 'product' });
    },
    onSuccess: r => {
      qc.invalidateQueries({ queryKey: TOPICS_KEY });
      qc.invalidateQueries({ queryKey: ['tasker', 'metrics'] });
      qc.invalidateQueries({ queryKey: ['tasker-metrics'] });
      onDone(r.topic.id);
    },
    onError: e => setErr(e instanceof Error ? e.message : 'Не получилось'),
  });
  const ready = topic ? !!label.trim() : kind === 'metric' ? !!metricId : !!pgId;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-accent)] bg-[var(--color-bg-surface)] p-3">
      <h3 className="font-semibold text-[var(--color-text)]">{topic ? 'Тема' : 'Новая тема'}</h3>
      {isNew && (
        <Segmented label="Тип темы" value={kind} onChange={setKind}
          options={[{ value: 'metric', label: 'Показатель' }, { value: 'product_group', label: 'Материалы по товарной группе' }]} />
      )}
      {isNew && catalogQ.isLoading && <p className="text-sm text-[var(--color-text-muted)]">Загружаю каталог…</p>}
      {isNew && kind === 'metric' && cat && (
        <div className={FIELD}>
          Показатель из каталога отчётов
          <SearchSelect searchable options={cat.metrics.map(m => ({ value: m.id, label: m.name, hint: m.category }))} value={metricId}
            onChange={v => { setMetricId(v); setFormat(''); }} placeholder="Выберите показатель" ariaLabel="Показатель из каталога" className="w-full" />
        </div>
      )}
      {isNew && kind === 'product_group' && cat && (
        <>
          <div className={FIELD}>
            Товарная группа (как в отчёте «По товарным группам»)
            <SearchSelect searchable options={cat.productGroups.map(g => ({ value: g.id, label: g.name }))} value={pgId}
              onChange={setPgId} placeholder="Выберите группу" ariaLabel="Товарная группа" className="w-full" />
          </div>
          <div className={FIELD}>
            Что замеряем у менеджера до/после
            <Segmented label="Замер товарной группы" value={measure} onChange={setMeasure}
              options={[{ value: 'amount', label: 'Сумма продаж группы' }, { value: 'share', label: 'Доля в его продажах' }]} />
          </div>
        </>
      )}
      {topic && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {topic.kind === 'product_group'
            ? `Товарная группа · замер: ${topic.pgMeasure === 'share' ? 'доля в продажах менеджера' : 'сумма продаж группы'}`
            : `Показатель каталога: ${topic.id}`}
        </p>
      )}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={FIELD}>
          Короткое название
          <input value={label} onChange={e => setLabel(e.target.value)} maxLength={80} placeholder={defaultLabel || 'Как тема видна в задаче'}
            className={INPUT} aria-label="Короткое название темы" />
        </label>
        <div className={FIELD}>
          Группа
          <SearchSelect options={GROUP_OPTIONS} value={group || (kind === 'product_group' ? 'product' : '')} onChange={v => setGroup(v as TaskerMetricGroup)}
            placeholder="По формату показателя" ariaLabel="Группа темы" className="w-full" />
        </div>
        <div className={FIELD}>
          Что лучше
          <Segmented label="Направление" value={higher} onChange={setHigher}
            options={[{ value: 'up', label: 'Больше — лучше' }, { value: 'down', label: 'Меньше — лучше' }]} />
        </div>
        <div className={FIELD}>
          Формат
          {kind === 'product_group' || topic?.kind === 'product_group' ? (
            <span className="flex min-h-11 items-center text-[var(--color-text)]">{effFormat === 'percent' ? 'Проценты, %' : 'Деньги, ₽'}</span>
          ) : (
            <SearchSelect options={FORMAT_OPTIONS} value={format || effFormat} onChange={v => setFormat(v as TaskerMetric['format'])}
              ariaLabel="Формат значения" className="w-full" />
          )}
        </div>
      </div>
      {err && <p className="text-sm text-[var(--color-negative)]">{err}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={BTN}>Отмена</button>
        <button type="button" disabled={!ready || save.isPending} onClick={() => { setErr(null); save.mutate(); }} className={PRIMARY}>
          {save.isPending && <Loader2 size={15} className="animate-spin" aria-hidden />} {topic ? 'Сохранить' : 'Создать тему'}
        </button>
      </div>
    </div>
  );
}

const KindIcon = ({ t, className }: { t: TaskerMetric; className?: string }) =>
  t.kind === 'product_group' ? <Package size={14} className={className} aria-hidden /> : <BarChart3 size={14} className={className} aria-hidden />;

// ── Страница ────────────────────────────────────────────────────────────────

export function TemplatesPage() {
  const qc = useQueryClient();
  const topicsQ = useQuery({ queryKey: TOPICS_KEY, queryFn: fetchTopics });
  const q = useQuery({ queryKey: TEMPLATES_FULL_KEY, queryFn: fetchTemplatesFull });
  const allTopics = useMemo(() => topicsQ.data?.topics ?? [], [topicsQ.data]);
  const [showArchivedTopics, setShowArchivedTopics] = useState(false);
  const topics = useMemo(
    () => allTopics.filter(t => showArchivedTopics || t.active !== false)
      .sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || a.sortOrder - b.sortOrder),
    [allTopics, showArchivedTopics],
  );
  const activeTopics = allTopics.filter(t => t.active !== false).sort((a, b) => a.sortOrder - b.sortOrder);
  const [metricParam, setMetricId] = useState('');
  const metricId = metricParam || activeTopics[0]?.id || '';
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [topicForm, setTopicForm] = useState<'new' | 'edit' | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const all = useMemo(() => q.data?.templates ?? [], [q.data]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of all) if (t.active) m.set(t.metricId, (m.get(t.metricId) ?? 0) + 1);
    return m;
  }, [all]);
  const active = all.filter(t => t.metricId === metricId && t.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const archived = all.filter(t => t.metricId === metricId && !t.active);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: TEMPLATES_FULL_KEY });
    qc.invalidateQueries({ queryKey: ['tasker', 'templates'] }); // кэш формы задачи
  };
  const refreshTopics = () => {
    qc.invalidateQueries({ queryKey: TOPICS_KEY });
    qc.invalidateQueries({ queryKey: ['tasker', 'metrics'] });
    qc.invalidateQueries({ queryKey: ['tasker-metrics'] });
  };
  const onErr = (e: unknown) => setErr(e instanceof Error ? e.message : 'Не получилось');
  const save = useMutation({
    mutationFn: (v: { id: number | 'new'; title: string; body: string }) =>
      v.id === 'new' ? createTemplate({ metricId, title: v.title, body: v.body }) : updateTemplate(v.id, { title: v.title, body: v.body }),
    onSuccess: () => { setEditing(null); setErr(null); refresh(); },
    onError: onErr,
  });
  const patch = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => updateTemplate(v.id, { active: v.active }),
    onSuccess: () => { setErr(null); refresh(); }, onError: onErr,
  });
  const del = useMutation({ mutationFn: deleteTemplate, onSuccess: () => { setErr(null); refresh(); }, onError: onErr });
  const reorder = useMutation({
    mutationFn: (ids: number[]) => reorderTemplates(metricId, ids),
    onMutate: ids => {
      // Оптимистично: порядок в кэше сразу, сервер догонит.
      qc.setQueryData(TEMPLATES_FULL_KEY, (d: typeof q.data) => d && {
        ...d, templates: d.templates.map(t => (ids.includes(t.id) ? { ...t, sortOrder: (ids.indexOf(t.id) + 1) * 10 } : t)),
      });
    },
    onSettled: refresh, onError: onErr,
  });
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; title: string } | null>(null);
  const topicPatch = useMutation({
    mutationFn: (v: { id: string; active: boolean }) => updateTopic(v.id, { active: v.active }),
    onSuccess: () => { setErr(null); refreshTopics(); }, onError: onErr,
  });
  const topicOrder = useMutation({
    mutationFn: (ids: string[]) => reorderTopics(ids),
    onMutate: ids => {
      qc.setQueryData(TOPICS_KEY, (d: typeof topicsQ.data) => d && {
        ...d, topics: d.topics.map(t => (ids.includes(t.id) ? { ...t, sortOrder: (ids.indexOf(t.id) + 1) * 10 } : t)),
      });
    },
    onSettled: refreshTopics, onError: onErr,
  });
  const move = (i: number, dir: -1 | 1) => {
    const ids = active.map(t => t.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  const moveTopic = (dir: -1 | 1) => {
    const ids = activeTopics.map(t => t.id);
    const i = ids.indexOf(metricId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    topicOrder.mutate(ids);
  };
  const busy = patch.isPending || del.isPending || reorder.isPending;
  const metric = allTopics.find(m => m.id === metricId);
  const topicIdx = activeTopics.findIndex(t => t.id === metricId);
  const selectTopic = (id: string) => { setMetricId(id); setEditing(null); setTopicForm(null); setErr(null); };

  const topicOptions = topics.map(m => ({
    value: m.id, label: m.active === false ? `${m.label} (архив)` : m.label,
    hint: `${m.kind === 'product_group' ? 'Товарная группа' : 'Показатель'} · ${counts.get(m.id) ?? 0} вар.`,
  }));
  const archivedTopicsCount = allTopics.filter(t => t.active === false).length;
  const loadErr = (topicsQ.error ?? q.error) as Error | null;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Задачник</h1>
        </header>
        <TaskerTabs active="templates" />
        <details className="max-w-3xl text-sm text-[var(--color-text-secondary)]">
          <summary className="min-h-11 cursor-pointer content-center">
            Темы задач и инструкции к ним · <span className="text-[var(--color-accent)]">как это работает</span>
          </summary>
          <p className="pb-1">
            Тема — показатель из отчётов или товарная группа: по ней снимаются цифры и делается автозамер. В форме задачи РОП
            выбирает тему, вариант инструкции (первый — по умолчанию) и дописывает своё.
          </p>
        </details>

        {loadErr && (
          <p className="rounded-lg bg-[var(--color-negative)]/10 p-3 text-sm text-[var(--color-negative)]">
            {loadErr.message === 'Forbidden' ? 'Нет права «Задачник: редактировать шаблоны рекомендаций».' : loadErr.message}
          </p>
        )}

        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
          {/* Темы: на телефоне/планшете — выпадающий, на десктопе — список слева */}
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center lg:hidden">
            <SearchSelect searchable options={topicOptions} value={metricId} onChange={selectTopic}
              placeholder="Тема" ariaLabel="Тема" className="w-full sm:max-w-sm" />
            <button type="button" onClick={() => { setErr(null); setEditing(null); setTopicForm('new'); }} className={BTN}>
              <Plus size={16} aria-hidden /> Тема
            </button>
          </div>
          <nav aria-label="Темы" className="hidden w-72 shrink-0 flex-col gap-0.5 rounded-xl border border-[var(--color-border)] p-1 lg:flex">
            <button type="button" onClick={() => { setErr(null); setEditing(null); setTopicForm('new'); }}
              className="flex min-h-10 items-center gap-2 rounded-lg px-3 text-left text-sm font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
              <Plus size={15} aria-hidden /> Новая тема
            </button>
            {topicsQ.isLoading && [0, 1, 2, 3, 4].map(i => <div key={i} className="mx-1 my-0.5 h-9 animate-pulse rounded-lg bg-[var(--color-bg-surface)]" />)}
            {topics.map(m => {
              const on = m.id === metricId && topicForm !== 'new';
              return (
                <button key={m.id} type="button" onClick={() => selectTopic(m.id)} aria-current={on ? 'true' : undefined}
                  className={`flex min-h-10 items-center gap-2 rounded-lg px-3 text-left text-sm ${on ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'} ${m.active === false ? 'opacity-60' : ''}`}>
                  <KindIcon t={m} className={`shrink-0 ${on ? 'text-white/80' : 'text-[var(--color-text-muted)]'}`} />
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  <span className={`shrink-0 text-xs ${on ? 'text-white/80' : 'text-[var(--color-text-muted)]'}`}>{m.active === false ? 'архив' : counts.get(m.id) ?? 0}</span>
                </button>
              );
            })}
            {archivedTopicsCount > 0 && (
              <button type="button" onClick={() => setShowArchivedTopics(s => !s)} className="min-h-10 px-3 text-left text-xs text-[var(--color-accent)] hover:underline">
                {showArchivedTopics ? 'Скрыть архивные темы' : `Архивные темы (${archivedTopicsCount})`}
              </button>
            )}
          </nav>
          {archivedTopicsCount > 0 && (
            <button type="button" onClick={() => setShowArchivedTopics(s => !s)} className="min-h-11 w-fit text-left text-sm text-[var(--color-accent)] hover:underline lg:hidden">
              {showArchivedTopics ? 'Скрыть архивные темы' : `Показать архивные темы (${archivedTopicsCount})`}
            </button>
          )}

          <section className="flex min-w-0 flex-1 flex-col gap-3">
            {topicForm === 'new' ? (
              <TopicForm onCancel={() => setTopicForm(null)} onDone={id => { setTopicForm(null); setMetricId(id); }} />
            ) : (
              <>
                {topicForm === 'edit' && metric ? (
                  <TopicForm topic={metric} onCancel={() => setTopicForm(null)} onDone={() => setTopicForm(null)} />
                ) : (
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <h2 className="flex min-w-0 items-center gap-1.5 text-base font-semibold text-[var(--color-text)]">
                        {metric && <KindIcon t={metric} className="shrink-0 text-[var(--color-text-muted)]" />}
                        {metric ? <span className="min-w-0 break-words">{metric.label}</span>
                          : topicsQ.isLoading ? <span className="h-5 w-48 animate-pulse rounded bg-[var(--color-bg-surface)]" aria-label="Загружаю" />
                          : <span className="min-w-0 text-[var(--color-text-muted)]">Выберите тему слева или создайте новую</span>}
                        {metric?.active === false && <span className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] font-normal text-[var(--color-text-muted)]">архив</span>}
                      </h2>
                      {metric && (
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {metric.kind === 'product_group'
                            ? `Товарная группа · ${metric.pgMeasure === 'share' ? 'доля в продажах' : 'сумма продаж'}`
                            : TASKER_METRIC_GROUP_LABELS[metric.group]}
                          {' · '}{metric.higherIsBetter ? 'больше — лучше' : 'меньше — лучше'}
                        </span>
                      )}
                    </div>
                    {metric && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        {metric.active !== false && (
                          <>
                            <button type="button" disabled={topicIdx <= 0 || topicOrder.isPending} onClick={() => moveTopic(-1)} className={ICON} aria-label="Тему выше" title="Тему выше в списке формы"><ArrowUp size={15} /></button>
                            <button type="button" disabled={topicIdx < 0 || topicIdx >= activeTopics.length - 1 || topicOrder.isPending} onClick={() => moveTopic(1)} className={ICON} aria-label="Тему ниже" title="Тему ниже в списке формы"><ArrowDown size={15} /></button>
                          </>
                        )}
                        <button type="button" onClick={() => { setErr(null); setTopicForm('edit'); }} className={ICON} aria-label="Изменить тему" title="Изменить тему"><Pencil size={15} /></button>
                        <button type="button" disabled={topicPatch.isPending}
                          onClick={() => {
                            // В архив — через ConfirmDialog (как везде в Монолитике), вернуть — сразу.
                            if (metric.active !== false) setConfirmArchive(true);
                            else topicPatch.mutate({ id: metric.id, active: true });
                          }}
                          className={ICON} aria-label={metric.active !== false ? 'Тему в архив' : 'Вернуть тему'} title={metric.active !== false ? 'Тему в архив' : 'Вернуть тему из архива'}>
                          {metric.active !== false ? <Archive size={15} /> : <ArchiveRestore size={15} />}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
                  <h3 className="min-w-0 flex-1 text-sm font-semibold text-[var(--color-text)]">Варианты инструкции</h3>
                  {editing === null && metricId && (
                    <button type="button" onClick={() => { setErr(null); setEditing('new'); }} className={PRIMARY}><Plus size={16} aria-hidden /> Вариант</button>
                  )}
                </div>
                {err && editing === null && <p className="text-sm text-[var(--color-negative)]">{err}</p>}
                {editing === 'new' && (
                  <TemplateEditor initial={{ title: '', body: '' }} saving={save.isPending} error={err}
                    onCancel={() => { setEditing(null); setErr(null); }} onSave={v => save.mutate({ id: 'new', ...v })} />
                )}
                {q.isLoading && [0, 1].map(i => <div key={i} className="h-28 animate-pulse rounded-xl bg-[var(--color-bg-surface)]" />)}
                {!q.isLoading && metricId && active.length === 0 && editing !== 'new' && (
                  <div className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
                    <span>Вариантов пока нет — в форме задачи поле инструкции будет пустым, РОП напишет её сам.</span>
                    <button type="button" onClick={() => { setErr(null); setEditing('new'); }} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 font-medium text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
                      <Plus size={15} aria-hidden /> Добавить первый вариант
                    </button>
                  </div>
                )}
                {active.map((t, i) => editing === t.id ? (
                  <TemplateEditor key={t.id} initial={t} saving={save.isPending} error={err}
                    onCancel={() => { setEditing(null); setErr(null); }} onSave={v => save.mutate({ id: t.id, ...v })} />
                ) : (
                  <TemplateCard key={t.id} t={t} first={i === 0} last={i === active.length - 1} busy={busy}
                    onEdit={() => { setErr(null); setEditing(t.id); }} onMove={d => move(i, d)}
                    onArchive={a => patch.mutate({ id: t.id, active: a })} onDelete={() => {}} />
                ))}

                {archived.length > 0 && (
                  <div className="flex min-w-0 flex-col gap-2 pt-2">
                    <button type="button" onClick={() => setShowArchive(s => !s)} className="min-h-11 w-fit text-sm text-[var(--color-accent)] hover:underline">
                      {showArchive ? 'Скрыть архив' : `Архив вариантов (${archived.length})`}
                    </button>
                    {showArchive && archived.map(t => editing === t.id ? (
                      <TemplateEditor key={t.id} initial={t} saving={save.isPending} error={err}
                        onCancel={() => { setEditing(null); setErr(null); }} onSave={v => save.mutate({ id: t.id, ...v })} />
                    ) : (
                      <TemplateCard key={t.id} t={t} first last busy={busy}
                        onEdit={() => { setErr(null); setEditing(t.id); }} onMove={() => {}}
                        onArchive={a => patch.mutate({ id: t.id, active: a })}
                        onDelete={() => setConfirmDelete({ id: t.id, title: t.title })} />
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      <ConfirmDialog
        open={confirmArchive && !!metric}
        title="Убрать тему в архив?"
        description={metric ? `«${metric.label}» пропадёт из формы задачи; старые задачи и их замеры останутся.` : ''}
        confirmLabel="В архив" cancelLabel="Отмена" pending={topicPatch.isPending}
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => { if (metric) topicPatch.mutate({ id: metric.id, active: false }, { onSettled: () => setConfirmArchive(false) }); }}
      />
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Удалить вариант навсегда?"
        description={confirmDelete ? `«${confirmDelete.title}» удалится без возможности вернуть.` : ''}
        confirmLabel="Удалить" cancelLabel="Отмена" tone="danger" pending={del.isPending}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => { if (confirmDelete) del.mutate(confirmDelete.id, { onSettled: () => setConfirmDelete(null) }); }}
      />
    </div>
  );
}
