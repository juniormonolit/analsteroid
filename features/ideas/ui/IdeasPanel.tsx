'use client';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, X, ImagePlus, Trash2 } from 'lucide-react';
import { useSlideClose } from '@/lib/hooks/useSlideClose';
import { PanelCloseTab } from '@/components/ui/PanelCloseTab';
import { SlideBackdrop } from '@/components/ui/SlideBackdrop';
import { useIdeasQuery } from './useIdeasQuery';
import type { Idea, IdeaAttachment, IdeaStatus } from '@/lib/ideas/types';
import {
  IDEA_TITLE_MAX_LEN,
  IDEA_BODY_MAX_LEN,
  IDEA_ATTACH_MAX_BYTES,
  IDEA_ATTACH_MAX_COUNT,
  IDEA_ATTACH_ALLOWED_MIME,
} from '@/lib/ideas/types';

interface Props {
  onClose: () => void;
}

const STATUS_BADGE: Record<IdeaStatus, { label: string; cls: string }> = {
  in_progress: { label: 'В работе', cls: 'bg-amber-100 text-amber-700' },
  planned: { label: 'Запланировано', cls: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' },
  proposed: { label: 'На рассмотрении', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
  done: { label: 'Готово', cls: 'bg-green-100 text-green-700' },
  rejected: { label: 'Отклонено', cls: 'bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]' },
};

// Пункты меню смены статуса для админа (п.3 задачи) — минимально, без отдельного
// экрана: нативный <select> прямо на карточке. «Предложено» (proposed) в список не
// входит — это стартовое состояние идеи, а не то, куда её возвращают вручную.
const ADMIN_STATUS_OPTIONS: { value: IdeaStatus; label: string }[] = [
  { value: 'planned', label: 'Запланировано' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'done', label: 'Готово' },
  { value: 'rejected', label: 'Отклонить' },
];

// Клиентская валидация набора картинок перед отправкой (сервер валидирует повторно).
function validateFiles(files: File[], alreadyHas: number): string | null {
  if (alreadyHas + files.length > IDEA_ATTACH_MAX_COUNT) {
    return `Максимум ${IDEA_ATTACH_MAX_COUNT} скриншотов на идею`;
  }
  for (const f of files) {
    if (!IDEA_ATTACH_ALLOWED_MIME.includes(f.type)) return `Только картинки (png, jpg, gif, webp): ${f.name}`;
    if (f.size > IDEA_ATTACH_MAX_BYTES) return `Файл больше 8 МБ: ${f.name}`;
  }
  return null;
}

async function uploadAttachments(ideaId: string, files: File[]): Promise<string | null> {
  const fd = new FormData();
  files.forEach(f => fd.append('files', f));
  const res = await fetch(`/api/ideas/${ideaId}/attachments`, { method: 'POST', body: fd });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return d.error ?? 'Не удалось загрузить скриншоты';
  }
  return null;
}

/**
 * Выезжающая справа панель «Идеи и планы» (макет владельца, ideas-backlog-mock.html) —
 * построена по паттерну ChangelogPanel (features/changelog/ui/ChangelogPanel.tsx):
 * тот же SlideBackdrop + PanelCloseTab + useSlideClose, та же ширина панели.
 * Два экрана внутри одной панели: лента идей и форма подачи (стрелка назад).
 */
export function IdeasPanel({ onClose }: Props) {
  const { data } = useIdeasQuery();
  const qc = useQueryClient();
  const { closing, requestClose } = useSlideClose(onClose);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [isAdmin, setIsAdmin] = useState(false);
  const [myLogin, setMyLogin] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  // Право менять статус идеи — тот же гейт, что «управление общими отчётами»
  // (action.shared_reports.manage), см. app/api/ideas/[id]/route.ts. Заодно берём
  // login — по нему решаем, может ли пользователь удалить своё вложение.
  useEffect(() => {
    fetch('/api/auth/session')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { user?: { login?: string; isSuperadmin?: boolean; permissions?: string[] } } | null) => {
        setIsAdmin(!!d?.user?.isSuperadmin || !!d?.user?.permissions?.includes('action.shared_reports.manage'));
        setMyLogin(d?.user?.login ?? null);
      })
      .catch(() => {});
  }, []);

  function changeStatus(id: string, status: IdeaStatus) {
    fetch(`/api/ideas/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
      .then(() => qc.invalidateQueries({ queryKey: ['ideas'] }))
      .catch(() => {});
  }

  const refetch = () => qc.invalidateQueries({ queryKey: ['ideas'] });

  return (
    <>
      <SlideBackdrop closing={closing} onClick={requestClose} />
      <div
        className={`fixed inset-y-0 right-0 z-50 w-full sm:w-[50vw] sm:min-w-[360px] sm:max-w-[800px] bg-[var(--color-bg-surface)] shadow-2xl flex flex-col ${closing ? 'slide-panel-out-right' : 'slide-panel-in-right'}`}
      >
        <PanelCloseTab onClick={requestClose} />

        {view === 'list' ? (
          <ListView
            data={data}
            isAdmin={isAdmin}
            myLogin={myLogin}
            onChangeStatus={changeStatus}
            onPropose={() => setView('form')}
            onCloseMobile={requestClose}
            onView={setLightbox}
            onAttachmentsChanged={refetch}
          />
        ) : (
          <FormView
            onBack={() => setView('list')}
            onSubmitted={() => {
              refetch();
              setView('list');
            }}
            onCloseMobile={requestClose}
          />
        )}
      </div>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </>
  );
}

// Полноразмерный просмотр скриншота по клику на миниатюру.
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out"
      onClick={onClose}
    >
      <button className="absolute top-4 right-4 text-white/80 hover:text-white" onClick={onClose}>
        <X size={26} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
    </div>
  );
}

// Миниатюры вложений идеи + удаление (для загрузившего/админа) + открытие в полный размер.
function AttachmentThumbs({ idea, canDelete, onView, onChanged }: {
  idea: Idea;
  canDelete: (a: IdeaAttachment) => boolean;
  onView: (v: { src: string; alt: string }) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!idea.attachments.length) return null;

  async function remove(attId: string) {
    setBusyId(attId);
    try {
      await fetch(`/api/ideas/${idea.id}/attachments/${attId}`, { method: 'DELETE' });
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 mb-1.5">
      {idea.attachments.map(a => {
        const src = `/api/ideas/${idea.id}/attachments/${a.id}`;
        return (
          <div key={a.id} className="relative group">
            <button
              onClick={() => onView({ src, alt: a.filename })}
              className="block h-16 w-16 rounded-md overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-hover)] cursor-zoom-in"
              title={a.filename}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={a.filename} loading="lazy" className="h-full w-full object-cover" />
            </button>
            {canDelete(a) && (
              <button
                onClick={() => remove(a.id)}
                disabled={busyId === a.id}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--color-bg-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center shadow-sm disabled:opacity-40"
                title="Удалить скриншот"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Кнопка «добавить скриншот» к уже существующей идее (скрытый file input).
function AddScreenshotButton({ idea, onChanged }: { idea: Idea; onChanged: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = IDEA_ATTACH_MAX_COUNT - idea.attachments.length;
  if (remaining <= 0) return null;

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const vErr = validateFiles(files, idea.attachments.length);
    if (vErr) {
      setError(vErr);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const upErr = await uploadAttachments(idea.id, files);
      if (upErr) setError(upErr);
      else onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] disabled:opacity-50"
      >
        <ImagePlus size={13} /> {busy ? 'Загрузка…' : 'Скриншот'}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={IDEA_ATTACH_ALLOWED_MIME.join(',')}
        multiple
        hidden
        onChange={onPick}
      />
      {error && <div className="text-[11px] text-[var(--color-negative)] mt-1 basis-full">{error}</div>}
    </>
  );
}

function IdeaCard({ idea, isAdmin, myLogin, onChangeStatus, onView, onAttachmentsChanged }: {
  idea: Idea;
  isAdmin: boolean;
  myLogin: string | null;
  onChangeStatus: (id: string, status: IdeaStatus) => void;
  onView: (v: { src: string; alt: string }) => void;
  onAttachmentsChanged: () => void;
}) {
  const badge = STATUS_BADGE[idea.status];
  const canDelete = (a: IdeaAttachment) => isAdmin || (!!myLogin && a.uploadedBy === myLogin);
  return (
    <div className="px-3.5 py-3 rounded-[10px] mb-1.5 border border-[var(--color-border)]">
      <div className="flex items-start justify-between gap-2.5 mb-1">
        <div className="text-[13.5px] font-bold text-[var(--color-text)]">{idea.title}</div>
        <span className={`shrink-0 text-[10.5px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      <div className="text-[12.5px] leading-[1.45] text-[var(--color-text-muted)] mb-1.5 whitespace-pre-wrap">
        {idea.body}
      </div>

      <AttachmentThumbs idea={idea} canDelete={canDelete} onView={onView} onChanged={onAttachmentsChanged} />

      <div className="flex items-center justify-between gap-2 flex-wrap">
        {idea.authorName && (
          <div className="text-[11.5px] text-[var(--color-text-muted)]">предложил: {idea.authorName}</div>
        )}
        <div className="flex items-center gap-3 ml-auto">
          <AddScreenshotButton idea={idea} onChanged={onAttachmentsChanged} />
          {isAdmin && (
            <select
              value=""
              onChange={e => {
                const status = e.target.value as IdeaStatus;
                if (status) onChangeStatus(idea.id, status);
              }}
              className="text-[11px] border border-[var(--color-border)] rounded-md px-1.5 py-0.5 bg-[var(--color-bg-surface)] text-[var(--color-text-muted)]"
            >
              <option value="">Изменить статус…</option>
              {ADMIN_STATUS_OPTIONS.filter(o => o.value !== idea.status).map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
}

function ListView({ data, isAdmin, myLogin, onChangeStatus, onPropose, onCloseMobile, onView, onAttachmentsChanged }: {
  data: { planned: Idea[]; proposed: Idea[] } | undefined;
  isAdmin: boolean;
  myLogin: string | null;
  onChangeStatus: (id: string, status: IdeaStatus) => void;
  onPropose: () => void;
  onCloseMobile: () => void;
  onView: (v: { src: string; alt: string }) => void;
  onAttachmentsChanged: () => void;
}) {
  const planned = data?.planned ?? [];
  const proposed = data?.proposed ?? [];
  const empty = planned.length === 0 && proposed.length === 0;

  const cardProps = { isAdmin, myLogin, onChangeStatus, onView, onAttachmentsChanged };

  return (
    <>
      <div className="flex items-center gap-2.5 px-5 sm:px-6 py-4 border-b border-[var(--color-border)] shrink-0">
        <h2 className="text-[17px] font-bold text-[var(--color-text)] m-0">Идеи и планы</h2>
        <button
          onClick={onPropose}
          className="ml-auto text-[12.5px] font-bold text-[var(--color-text-inverse)] bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] px-3.5 py-2 rounded-lg shadow-sm shrink-0 whitespace-nowrap"
        >
          + Предложить идею
        </button>
        <button
          onClick={onCloseMobile}
          className="sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2">
        {empty && (
          <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">
            Пока нет идей — предложите первую
          </div>
        )}

        {planned.length > 0 && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--color-text-muted)] px-3 pt-3.5 pb-2">
              Запланировано
            </div>
            {planned.map(idea => (
              <IdeaCard key={idea.id} idea={idea} {...cardProps} />
            ))}
          </div>
        )}

        {proposed.length > 0 && (
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--color-text-muted)] px-3 pt-3.5 pb-2">
              Предложено
            </div>
            {proposed.map(idea => (
              <IdeaCard key={idea.id} idea={idea} {...cardProps} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function FormView({ onBack, onSubmitted, onCloseMobile }: {
  onBack: () => void;
  onSubmitted: () => void;
  onCloseMobile: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // object-URL превью выбранных, но ещё не загруженных картинок.
  useEffect(() => {
    const urls = files.map(f => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach(u => URL.revokeObjectURL(u));
  }, [files]);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !saving;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!picked.length) return;
    const next = [...files, ...picked];
    const vErr = validateFiles(next, 0);
    if (vErr) {
      setError(vErr);
      return;
    }
    setError(null);
    setFiles(next);
  }

  function removeFile(i: number) {
    setFiles(files.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), body: body.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Не удалось отправить идею');
        return;
      }
      const { id } = (await res.json().catch(() => ({}))) as { id?: string };
      if (id && files.length) {
        const upErr = await uploadAttachments(id, files);
        if (upErr) {
          // идея создана, но часть скринов не прикрепилась — не теряем идею, сообщаем.
          setError(`Идея создана, но скриншоты не загрузились: ${upErr}`);
          onSubmitted();
          return;
        }
      }
      onSubmitted();
    } catch {
      setError('Не удалось отправить идею');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2.5 px-5 sm:px-6 py-4 border-b border-[var(--color-border)] shrink-0">
        <button onClick={onBack} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0">
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-[17px] font-bold text-[var(--color-text)] m-0">Предложить идею</h2>
        <button
          onClick={onCloseMobile}
          className="ml-auto sm:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text)] shrink-0"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-5">
        <div className="text-xs text-[var(--color-text-muted)] leading-[1.5] mb-4 -mt-0.5">
          Расскажите, чего не хватает — админы рассмотрят и решат, брать ли идею в работу.
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-[var(--color-text)] mb-1.5">Название</label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={IDEA_TITLE_MAX_LEN}
            placeholder="Например: экспорт в Excel"
            className="w-full border border-[var(--color-border)] rounded-[9px] px-3 py-2.5 text-[13px] text-[var(--color-text)] bg-[var(--color-bg-hover)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-[var(--color-text)] mb-1.5">Описание</label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            maxLength={IDEA_BODY_MAX_LEN}
            placeholder="Что именно нужно и зачем — чем подробнее, тем быстрее решим"
            className="w-full h-[110px] resize-none border border-[var(--color-border)] rounded-[9px] px-3 py-2.5 text-[13px] leading-[1.5] text-[var(--color-text)] bg-[var(--color-bg-hover)] placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        <div className="mb-4">
          <label className="block text-xs font-bold text-[var(--color-text)] mb-1.5">
            Скриншоты <span className="font-normal text-[var(--color-text-muted)]">(необязательно, до {IDEA_ATTACH_MAX_COUNT})</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {previews.map((src, i) => (
              <div key={src} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="h-16 w-16 object-cover rounded-md border border-[var(--color-border)]" />
                <button
                  onClick={() => removeFile(i)}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[var(--color-bg-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-negative)] flex items-center justify-center shadow-sm"
                  title="Убрать"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {files.length < IDEA_ATTACH_MAX_COUNT && (
              <button
                onClick={() => inputRef.current?.click()}
                className="h-16 w-16 rounded-md border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] flex items-center justify-center"
                title="Добавить скриншот"
              >
                <ImagePlus size={18} />
              </button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept={IDEA_ATTACH_ALLOWED_MIME.join(',')}
            multiple
            hidden
            onChange={onPick}
          />
        </div>

        {error && <div className="text-xs text-[var(--color-negative)] mb-3">{error}</div>}

        <button
          onClick={submit}
          disabled={!canSubmit}
          className="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 text-[var(--color-text-inverse)] text-[13.5px] font-bold py-3 rounded-[9px] shadow-sm mb-2.5"
        >
          {saving ? 'Отправляем…' : 'Отправить'}
        </button>
        <div className="text-[11.5px] text-[var(--color-text-muted)] leading-[1.5] text-center">
          Идея уйдёт админам; статус увидишь здесь же.
        </div>
      </div>
    </>
  );
}
