'use client';
// Раздел «Телевизоры» (ТЗ владельца 07.09): экраны телевизоров — создание,
// отделы/режим/тема, привязка телевизоров по коду, превью, публичная ссылка,
// бегущая строка; вкладка «Рассылки» — сообщения на экраны.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cast, Check, Copy, Eye, Link2, Megaphone, MonitorPlay, Pencil, Plus, RefreshCw, Trash2, Unplug } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TvScreen, TvScreenInput } from '../shared';
import { ScreenEditorModal } from './ScreenEditorModal';
import { PairModal } from './PairModal';
import { PreviewModal } from './PreviewModal';
import { MessagesPanel } from './MessagesPanel';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, copyText, fmtAgo, screenUrl, tvApi } from './api';

type Tab = 'screens' | 'messages';

export function TvAdminPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['tv-screens'], queryFn: tvApi.listScreens, refetchInterval: 30_000 });
  const screens = data?.screens ?? [];
  const full = data?.full ?? false;
  const [tab, setTab] = useState<Tab>('screens');
  const [editor, setEditor] = useState<{ open: boolean; screen: TvScreen | null }>({ open: false, screen: null });
  const [pairFor, setPairFor] = useState<TvScreen | null>(null);
  const [previewFor, setPreviewFor] = useState<TvScreen | null>(null);
  const [deleteFor, setDeleteFor] = useState<TvScreen | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['tv-screens'] });

  const save = useMutation({
    mutationFn: (input: TvScreenInput) => editor.screen ? tvApi.updateScreen(editor.screen.id, input) : tvApi.createScreen(input),
    onSuccess: () => { setEditor({ open: false, screen: null }); setSaveError(null); invalidate(); },
    onError: (e: Error) => setSaveError(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => tvApi.deleteScreen(id),
    onSuccess: () => { setDeleteFor(null); invalidate(); },
  });

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-3 sm:p-6 flex flex-col gap-4 max-w-6xl">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text)] flex items-center gap-2"><MonitorPlay size={20} /> Телевизоры</h1>
            <p className="text-sm text-[var(--color-text-muted)]">ТВ-дашборды отделов продаж: телевизор открывает <b className="text-[var(--color-text)]">{typeof window !== 'undefined' ? window.location.host : ''}/tv</b>, показывает код — вы привязываете его к экрану здесь.</p>
          </div>
          {tab === 'screens' && (
            <button className={BTN_PRIMARY} onClick={() => { setSaveError(null); setEditor({ open: true, screen: null }); }}><Plus size={16} /> Создать экран</button>
          )}
        </div>

        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
          {([['screens', 'Экраны', screens.length], ['messages', 'Рассылки', null]] as [Tab, string, number | null][]).map(([k, l, n]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`min-h-11 px-3 text-sm -mb-px border-b-2 ${tab === k ? 'border-[var(--color-accent)] text-[var(--color-text)] font-medium' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
              {k === 'messages' && <Megaphone size={14} className="inline mr-1 -mt-0.5" />}{l}{n !== null && n > 0 ? ` · ${n}` : ''}
            </button>
          ))}
        </div>

        {tab === 'messages' ? (
          <MessagesPanel screens={screens} full={full} />
        ) : (
          <>
            {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
            {error && <div className="text-sm text-[var(--color-negative)]">{(error as Error).message}</div>}
            {!isLoading && screens.length === 0 && (
              <div className="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
                Экранов пока нет. Создайте первый: выберите отделы, а потом привяжите телевизор по коду с его экрана.
              </div>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {screens.map(s => (
                <ScreenCard key={s.id} screen={s}
                  onEdit={() => { setSaveError(null); setEditor({ open: true, screen: s }); }}
                  onPair={() => setPairFor(s)} onPreview={() => setPreviewFor(s)} onDelete={() => setDeleteFor(s)}
                  onChanged={invalidate} />
              ))}
            </div>
          </>
        )}
      </div>

      {editor.open && (
        <ScreenEditorModal open={editor.open} screen={editor.screen} onClose={() => setEditor({ open: false, screen: null })}
          onSave={input => save.mutate(input)} saving={save.isPending} error={saveError} />
      )}
      <PairModal screen={pairFor} onClose={() => setPairFor(null)} onPaired={() => { invalidate(); setPairFor(null); }} />
      <PreviewModal screen={previewFor} onClose={() => setPreviewFor(null)} />
      <ConfirmDialog open={!!deleteFor} title="Удалить экран?" tone="danger" pending={del.isPending}
        description={deleteFor ? <>Экран «{deleteFor.name}» и его ссылка перестанут работать; привязанные телевизоры ({deleteFor.devices.length}) покажут код привязки заново.</> : null}
        confirmLabel="Удалить" onConfirm={() => deleteFor && del.mutate(deleteFor.id)} onCancel={() => setDeleteFor(null)} />
    </div>
  );
}

function ScreenCard({ screen: s, onEdit, onPair, onPreview, onDelete, onChanged }: {
  screen: TvScreen; onEdit: () => void; onPair: () => void; onPreview: () => void; onDelete: () => void; onChanged: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [ticker, setTicker] = useState(s.tickerText ?? '');
  const [tickerDirty, setTickerDirty] = useState(false);
  const [rotating, setRotating] = useState(false);
  const url = screenUrl(s.publicToken);

  const tickerMut = useMutation({
    mutationFn: (enabled: boolean) => tvApi.setTicker(s.id, ticker.trim() || null, enabled),
    onSuccess: () => { setTickerDirty(false); onChanged(); },
  });
  const unpair = useMutation({ mutationFn: (id: string) => tvApi.unpair(id), onSuccess: onChanged });

  async function copy() { if (await copyText(url)) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }
  async function rotate() {
    setRotating(true);
    try { await tvApi.rotateToken(s.id); onChanged(); } finally { setRotating(false); }
  }
  const online = s.devices.filter(d => d.online).length;

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-[var(--color-text)] truncate">{s.name}</div>
          {s.comment && <div className="text-xs text-[var(--color-text-muted)] truncate">{s.comment}</div>}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]" title="Редактировать" onClick={onEdit}><Pencil size={16} /></button>
          <button className="tap-target p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]" title="Удалить" onClick={onDelete}><Trash2 size={16} /></button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {s.departmentNames.map((n, i) => <span key={s.departmentIds[i]} className="text-xs px-2 py-0.5 rounded-full bg-[var(--color-accent-soft)] text-[var(--color-text)]">{n}</span>)}
        <span className="text-xs px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)]">
          {s.departmentIds.length > 1 ? (s.mode === 'merged' ? 'одна сетка' : `карусель · ${s.rotateSec} с`) : 'один отдел'} · {s.theme === 'dark' ? 'тёмная' : 'светлая'}
        </span>
        {s.settings.events.enabled && <span className="text-xs px-2 py-0.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)]">события{s.settings.events.sound ? ' 🔊' : ''}</span>}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider flex items-center justify-between">
          <span>Телевизоры · {s.devices.length}{s.devices.length > 0 && <span className="normal-case tracking-normal"> ({online} онлайн)</span>}</span>
          <button className="normal-case tracking-normal inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline min-h-9" onClick={onPair}><Cast size={14} /> Привязать телевизор</button>
        </div>
        {s.devices.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Ни один телевизор ещё не привязан</div>}
        {s.devices.map(d => (
          <div key={d.id} className="flex items-center gap-2 text-sm min-h-9">
            <span className={`w-2 h-2 rounded-full shrink-0 ${d.online ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-border-strong)]'}`} />
            <span className="truncate text-[var(--color-text)]">{d.label ?? 'Телевизор'}</span>
            <span className="text-xs text-[var(--color-text-muted)] truncate">{fmtAgo(d.lastSeenAt)}</span>
            <button className="tap-target ml-auto p-1 text-[var(--color-text-muted)] hover:text-[var(--color-negative)]" title="Отвязать" onClick={() => unpair.mutate(d.id)} disabled={unpair.isPending}><Unplug size={14} /></button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Бегущая строка</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input className={INPUT_CLS} value={ticker} onChange={e => { setTicker(e.target.value); setTickerDirty(true); }} placeholder="Текст строки для этого телевизора" />
          <div className="flex gap-2 shrink-0">
            <button className={BTN_PRIMARY} disabled={tickerMut.isPending || !ticker.trim() || (!tickerDirty && s.tickerEnabled)} onClick={() => tickerMut.mutate(true)}>
              {s.tickerEnabled && !tickerDirty ? 'Показывается' : 'Показать'}
            </button>
            {s.tickerEnabled && <button className={BTN_SECONDARY} disabled={tickerMut.isPending} onClick={() => tickerMut.mutate(false)}>Скрыть</button>}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-1 border-t border-[var(--color-border)]">
        <button className={BTN_SECONDARY} onClick={onPreview}><Eye size={14} /> Превью</button>
        <button className={BTN_SECONDARY} onClick={copy} title={url}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Скопировано' : 'Ссылка'}</button>
        <a className={BTN_SECONDARY} href={url} target="_blank" rel="noreferrer"><Link2 size={14} /> Открыть</a>
        <button className={`${BTN_SECONDARY} ml-auto`} onClick={rotate} disabled={rotating} title="Старая ссылка перестанет работать; привязанные по коду телевизоры не затрагиваются">
          <RefreshCw size={14} className={rotating ? 'animate-spin' : ''} /> Новая ссылка
        </button>
      </div>
    </div>
  );
}
