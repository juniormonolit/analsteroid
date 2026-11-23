'use client';
// «Задачник → Шаблоны» (/tasker/templates): конструктор шаблонов рекомендаций (правки собрания 23.11,
// TASKER_FEEDBACK_2026-11-23 п.4). Руководители пишут пошаговые инструкции на каждый показатель: несколько
// вариантов, ссылки и картинки, порядок (он же порядок в форме задачи), архив. Право action.tasker.templates
// (админ — и так). В форме задачи РОП выбирает вариант и дописывает своё.
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, ImagePlus, Link2, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { TaskerTemplateFull } from '../../types';
import { useTaskerMetrics } from '../shared/api';
import { TaskerTabs } from '../shared/TaskerPage';
import { insertAt, renderTemplateBody } from './templateBody';
import {
  TEMPLATES_FULL_KEY, createTemplate, deleteTemplate, fetchTemplatesFull, reorderTemplates, updateTemplate, uploadTemplateImage,
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
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 break-words font-semibold text-[var(--color-text)]">{t.title}</h3>
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

// ── Страница ────────────────────────────────────────────────────────────────

export function TemplatesPage() {
  const qc = useQueryClient();
  const metricsQ = useTaskerMetrics(false);
  const q = useQuery({ queryKey: TEMPLATES_FULL_KEY, queryFn: fetchTemplatesFull });
  const metrics = useMemo(() => metricsQ.data?.metrics ?? [], [metricsQ.data]);
  const [metricParam, setMetricId] = useState('');
  const metricId = metricParam || metrics[0]?.id || '';
  const [editing, setEditing] = useState<number | 'new' | null>(null);
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
  const move = (i: number, dir: -1 | 1) => {
    const ids = active.map(t => t.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  const busy = patch.isPending || del.isPending || reorder.isPending;
  const metric = metrics.find(m => m.id === metricId);

  const metricOptions = metrics.map(m => ({ value: m.id, label: m.label, hint: `${counts.get(m.id) ?? 0} вар.` }));

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Задачник</h1>
        </header>
        <TaskerTabs active="templates" />
        <p className="max-w-3xl text-sm text-[var(--color-text-secondary)]">
          Пошаговые инструкции к задачам по каждому показателю. В форме задачи РОП выбирает вариант (первый — по умолчанию)
          и дописывает своё; текст уходит в описание задачи Битрикса.
        </p>

        {(q.error || metricsQ.error) && (
          <p className="rounded-lg bg-[var(--color-negative)]/10 p-3 text-sm text-[var(--color-negative)]">
            {(q.error as Error | null)?.message === 'Forbidden' ? 'Нет права «Задачник: редактировать шаблоны рекомендаций».' : ((q.error ?? metricsQ.error) as Error).message}
          </p>
        )}

        <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start">
          {/* Показатели: на телефоне/планшете — выпадающий, на десктопе — список слева */}
          <div className="lg:hidden">
            <SearchSelect options={metricOptions} value={metricId} onChange={v => { setMetricId(v); setEditing(null); }}
              placeholder="Показатель" ariaLabel="Показатель" className="w-full sm:max-w-sm" />
          </div>
          <nav aria-label="Показатели" className="hidden w-72 shrink-0 flex-col gap-0.5 rounded-xl border border-[var(--color-border)] p-1 lg:flex">
            {metrics.map(m => (
              <button key={m.id} type="button" onClick={() => { setMetricId(m.id); setEditing(null); }} aria-current={m.id === metricId ? 'true' : undefined}
                className={`flex min-h-10 items-center gap-2 rounded-lg px-3 text-left text-sm ${m.id === metricId ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
                <span className={`shrink-0 text-xs ${m.id === metricId ? 'text-white/80' : 'text-[var(--color-text-muted)]'}`}>{counts.get(m.id) ?? 0}</span>
              </button>
            ))}
          </nav>

          <section className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="min-w-0 flex-1 text-base font-semibold text-[var(--color-text)]">{metric?.label ?? '—'}</h2>
              {editing === null && metricId && (
                <button type="button" onClick={() => { setErr(null); setEditing('new'); }} className={PRIMARY}><Plus size={16} aria-hidden /> Вариант</button>
              )}
            </div>
            {err && editing === null && <p className="text-sm text-[var(--color-negative)]">{err}</p>}
            {editing === 'new' && (
              <TemplateEditor initial={{ title: '', body: '' }} saving={save.isPending} error={err}
                onCancel={() => { setEditing(null); setErr(null); }} onSave={v => save.mutate({ id: 'new', ...v })} />
            )}
            {q.isLoading && <p className="text-sm text-[var(--color-text-muted)]">Загрузка…</p>}
            {!q.isLoading && active.length === 0 && editing !== 'new' && (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
                Вариантов пока нет — в форме задачи поле рекомендаций будет пустым.
              </p>
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
                  {showArchive ? 'Скрыть архив' : `Архив (${archived.length})`}
                </button>
                {showArchive && archived.map(t => editing === t.id ? (
                  <TemplateEditor key={t.id} initial={t} saving={save.isPending} error={err}
                    onCancel={() => { setEditing(null); setErr(null); }} onSave={v => save.mutate({ id: t.id, ...v })} />
                ) : (
                  <TemplateCard key={t.id} t={t} first last busy={busy}
                    onEdit={() => { setErr(null); setEditing(t.id); }} onMove={() => {}}
                    onArchive={a => patch.mutate({ id: t.id, active: a })}
                    onDelete={() => { if (window.confirm(`Удалить вариант «${t.title}» навсегда? Это не отменить.`)) del.mutate(t.id); }} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
