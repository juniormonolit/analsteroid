'use client';
// Теги заказчика (миграция 245, владелец 22.10): «неудаляемые теги по умолчанию … для всех и
// кастомные для каждого аккаунта. Чтобы можно было выбрать цвет». Окно: отметить теги заказчику,
// создать свой (название + цвет), переименовать/перекрасить/удалить свой. Базовые — только отметить.
import { useState } from 'react';
import { Check, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { TAG_COLORS, type TagColor, type TagDef } from '../engine/tagColors';

export function TagChip({ tag, className = '' }: { tag: TagDef; className?: string }) {
  const c = TAG_COLORS[tag.color];
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${className}`}
      style={{ background: c.bg, color: c.fg }} title={tag.system ? 'Базовый тег' : 'Ваш тег'}>
      <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.dot }} />
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Цвет тега">
      {(Object.keys(TAG_COLORS) as TagColor[]).map(k => (
        <button key={k} type="button" role="radio" aria-checked={value === k} aria-label={TAG_COLORS[k].label} title={TAG_COLORS[k].label}
          onClick={() => onChange(k)}
          className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full border-2"
          style={{ background: TAG_COLORS[k].dot, borderColor: value === k ? 'var(--color-text)' : 'transparent' }}>
          {value === k && <Check size={13} className="text-white" />}
        </button>
      ))}
    </div>
  );
}

const field = 'min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';

async function api(url: string, body: Record<string, unknown>) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}

export function TagsModal({ title, clientKey, managerId, column, current, defs, onClose, onSaved, onDefsChanged }: {
  title: string; clientKey: string; managerId: string; column: string;
  current: number[]; defs: TagDef[];
  onClose: () => void; onSaved: () => void;
  /** Словарь поменялся (создан/переименован/удалён свой тег) — доску надо перезапросить. */
  onDefsChanged: () => void;
}) {
  const [list, setList] = useState<TagDef[]>(defs);
  const [picked, setPicked] = useState<Set<number>>(new Set(current));
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColor>('cornflower');
  const [edit, setEdit] = useState<{ id: number; name: string; color: TagColor } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const toggle = (id: number) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const create = () => run(async () => {
    const j = await api('/api/repeat-kanban/tags', { action: 'create', name: newName, color: newColor });
    setList(l => [...l, j.tag]); setPicked(s => new Set(s).add(j.tag.id)); setNewName(''); onDefsChanged();
  });
  const saveEdit = () => edit && run(async () => {
    await api('/api/repeat-kanban/tags', { action: 'update', id: edit.id, name: edit.name, color: edit.color });
    setList(l => l.map(t => (t.id === edit.id ? { ...t, name: edit.name.trim(), color: edit.color } : t))); setEdit(null); onDefsChanged();
  });
  const remove = (t: TagDef) => {
    if (!confirm(`Удалить тег «${t.name}»? Он пропадёт у всех заказчиков, где вы его ставили.`)) return;
    run(async () => {
      await api('/api/repeat-kanban/tags', { action: 'delete', id: t.id });
      setList(l => l.filter(x => x.id !== t.id)); setPicked(s => { const n = new Set(s); n.delete(t.id); return n; }); onDefsChanged();
    });
  };
  const save = () => run(async () => {
    await api('/api/repeat-kanban', { action: 'set_tags', clientKey, managerId, column, tagIds: [...picked] });
    onSaved(); onClose();
  });

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Теги · ${title}`} desktopWidth="sm:max-w-md">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <p className="text-[var(--color-text-secondary)]">
          Отметьте теги заказчика. Базовые (<Lock size={11} className="inline" />) видят все; свои теги видите только вы.
        </p>
        <div className="flex flex-col gap-0.5">
          {list.map(t => edit?.id === t.id ? (
            <div key={t.id} className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-2">
              <input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} maxLength={40} aria-label="Название тега" className={field} autoFocus />
              <ColorPicker value={edit.color} onChange={color => setEdit({ ...edit, color })} />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setEdit(null)} className="min-h-11 rounded-lg px-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
                <button type="button" disabled={busy || !edit.name.trim()} onClick={saveEdit} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-white disabled:opacity-50">Сохранить</button>
              </div>
            </div>
          ) : (
            <div key={t.id} className="flex min-w-0 items-center gap-2">
              <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 hover:bg-[var(--color-bg-hover)]">
                <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
                <TagChip tag={t} className="text-xs" />
                {t.system && <Lock size={11} className="shrink-0 text-[var(--color-text-muted)]" aria-label="Базовый тег" />}
              </label>
              {!t.system && (
                <>
                  <button type="button" onClick={() => setEdit({ id: t.id, name: t.name, color: t.color })} aria-label={`Изменить тег ${t.name}`}
                    className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]"><Pencil size={13} /></button>
                  <button type="button" onClick={() => remove(t)} aria-label={`Удалить тег ${t.name}`}
                    className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-md text-[#990000] hover:bg-[var(--color-bg-hover)]"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-[var(--color-border)] p-2">
          <span className="text-xs font-medium text-[var(--color-text-muted)]">Новый свой тег</span>
          <div className="flex gap-2">
            <input value={newName} onChange={e => setNewName(e.target.value)} maxLength={40} placeholder="Например: Объект в Химках"
              aria-label="Название нового тега" className={field}
              onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) { e.preventDefault(); create(); } }} />
            <button type="button" disabled={busy || !newName.trim()} onClick={create}
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-border)] px-3 text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">
              <Plus size={14} /> Создать
            </button>
          </div>
          <ColorPicker value={newColor} onChange={setNewColor} />
        </div>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy} onClick={save} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
            {busy ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
