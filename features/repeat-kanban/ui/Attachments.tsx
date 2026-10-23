'use client';
// Файлы и картинки к комментарию задачи (владелец 23.10), по образцу «Есть идея» (IdeasPanel): вставка
// картинки из буфера прямо в поле текста, перетаскивание, кнопка «Прикрепить». Грузим в Битрикс только при
// отправке (upload → токены → действие), брошенная форма ничего не оставляет на Диске.
import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';

const MAX_COUNT = 6;
const MAX_BYTES = 10 * 1024 * 1024;

export function useAttachments() {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const add = (picked: File[]) => {
    if (!picked.length) return;
    const accepted: File[] = [];
    let err: string | null = null;
    for (const f of picked) {
      if (files.length + accepted.length >= MAX_COUNT) { err = `Не больше ${MAX_COUNT} файлов`; break; }
      if (f.size > MAX_BYTES) { err = `Файл больше ${MAX_BYTES / 1024 / 1024} МБ: ${f.name}`; continue; }
      const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      // Скриншоты из буфера приходят как image.png — даём различимое имя.
      const name = !f.name || /^image\.\w+$/.test(f.name) ? `скриншот-${Date.now()}-${accepted.length + 1}.${ext}` : f.name;
      accepted.push(name === f.name ? f : new File([f], name, { type: f.type }));
    }
    setError(err);
    if (accepted.length) setFiles(prev => [...prev, ...accepted]);
  };

  /** На textarea: картинка из буфера → вложение; обычный текст вставляется как всегда. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const got = Array.from(e.clipboardData?.items ?? []).filter(it => it.kind === 'file').map(it => it.getAsFile()).filter((f): f is File => !!f);
    if (!got.length) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    add(got);
  };
  const dropZone = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setDragOver(true); } },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent) => {
      setDragOver(false);
      const got = Array.from(e.dataTransfer?.files ?? []);
      if (!got.length) return;
      e.preventDefault();
      add(got);
    },
  };

  /** Перед действием: файлы → Битрикс, токены — в тело действия. Пусто — пустой массив. */
  const upload = async (): Promise<string[]> => {
    if (!files.length) return [];
    const fd = new FormData();
    files.forEach(f => fd.append('files', f));
    const r = await fetch('/api/repeat-kanban/attachments', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? 'Не удалось загрузить файлы');
    return (j.files as { token: string }[]).map(x => x.token);
  };

  return { files, error, dragOver, add, onPaste, dropZone, upload, remove: (i: number) => setFiles(prev => prev.filter((_, k) => k !== i)) };
}

export function AttachmentsRow({ a }: { a: ReturnType<typeof useAttachments> }) {
  const input = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => a.files.map(f => (f.type.startsWith('image/') ? URL.createObjectURL(f) : null)), [a.files]);
  useEffect(() => () => previews.forEach(u => u && URL.revokeObjectURL(u)), [previews]);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="list" aria-label="Вложения">
        {a.files.map((f, i) => (
          <div key={`${f.name}-${i}`} role="listitem" className="relative" title={f.name}>
            {previews[i]
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={previews[i]!} alt={f.name} className="h-14 w-14 rounded-lg bg-[var(--color-bg-hover)] object-cover" />
              : <span className="flex h-14 w-28 items-center gap-1 rounded-lg bg-[var(--color-bg-hover)] px-2 text-[11px] text-[var(--color-text-secondary)]"><FileText size={14} className="shrink-0" /><span className="line-clamp-2 break-all">{f.name}</span></span>}
            <button type="button" onClick={() => a.remove(i)} aria-label={`Убрать ${f.name}`}
              className="tap-target absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg-overlay)] text-[var(--color-text-muted)] shadow-sm hover:text-[var(--color-negative)]">
              <X size={12} />
            </button>
          </div>
        ))}
        {a.files.length < MAX_COUNT && (
          <button type="button" onClick={() => input.current?.click()}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
            <Paperclip size={14} /> Прикрепить
          </button>
        )}
        <span className="hidden text-[11.5px] text-[var(--color-text-muted)] sm:inline">картинку можно вставить в текст (Ctrl/⌘+V) или перетащить</span>
      </div>
      {a.error && <p className="text-[12px] text-[var(--color-negative)]">{a.error}</p>}
      <input ref={input} type="file" multiple hidden onChange={e => { const p = Array.from(e.target.files ?? []); e.target.value = ''; a.add(p); }} />
    </div>
  );
}
