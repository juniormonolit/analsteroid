'use client';
// Рассылки на телевизоры: бегущая строка / баннер / на весь экран, адресат —
// все экраны или выбранные, длительность в минутах. Список активных и истории
// за сутки, «Снять» — закончить показ сейчас.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Square } from 'lucide-react';
import type { TvMessage, TvMessageKind, TvScreen } from '../shared';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, LABEL_CLS, tvApi } from './api';

const KIND_LABEL: Record<TvMessageKind, string> = { ticker: 'Бегущая строка', banner: 'Баннер сверху', fullscreen: 'На весь экран' };
const DURATIONS = [{ m: 5, l: '5 мин' }, { m: 15, l: '15 мин' }, { m: 60, l: '1 час' }, { m: 240, l: '4 часа' }, { m: 1440, l: 'сутки' }];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessagesPanel({ screens, full }: { screens: TvScreen[]; full: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['tv-messages'], queryFn: tvApi.listMessages, refetchInterval: 30_000 });
  const [kind, setKind] = useState<TvMessageKind>('ticker');
  const [text, setText] = useState('');
  const [all, setAll] = useState(full);
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => tvApi.createMessage({ kind, text: text.trim(), targetScreenIds: all ? null : [...targets], minutes }),
    onSuccess: () => { setText(''); setError(null); qc.invalidateQueries({ queryKey: ['tv-messages'] }); },
    onError: (e: Error) => setError(e.message),
  });
  const stop = useMutation({
    mutationFn: (id: string) => tvApi.stopMessage(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tv-messages'] }),
  });

  const messages = data?.messages ?? [];
  const active = messages.filter(m => m.active);
  const past = messages.filter(m => !m.active);
  const canSend = text.trim().length > 0 && (all || targets.size > 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)] gap-4">
      <form className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 flex flex-col gap-4 self-start"
        onSubmit={e => { e.preventDefault(); if (canSend) create.mutate(); }}>
        <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]"><Megaphone size={16} /> Новая рассылка</div>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Формат</label>
          <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--color-bg-hover)] w-fit">
            {(Object.keys(KIND_LABEL) as TvMessageKind[]).map(k => (
              <button key={k} type="button" onClick={() => setKind(k)}
                className={`min-h-9 px-3 rounded-md text-sm ${kind === k ? 'bg-[var(--color-bg-surface)] font-medium shadow-sm text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}>{KIND_LABEL[k]}</button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Текст</label>
          <textarea className={`${INPUT_CLS} min-h-[80px]`} value={text} onChange={e => setText(e.target.value)} maxLength={kind === 'ticker' ? 500 : 300}
            placeholder={kind === 'ticker' ? 'Коллеги, в 17:00 общее собрание в переговорной' : 'Собрание в 17:00'} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Кому</label>
          {full && (
            <label className="flex items-center gap-2 min-h-9 text-sm cursor-pointer">
              <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} className="accent-[var(--color-accent)] w-4 h-4" /> Все экраны
            </label>
          )}
          {!all && (
            <div className="border border-[var(--color-border)] rounded-lg p-2 max-h-48 overflow-y-auto overflow-x-hidden flex flex-col">
              {screens.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Экранов пока нет</div>}
              {screens.map(s => (
                <label key={s.id} className="flex items-center gap-2 min-h-9 text-sm cursor-pointer">
                  <input type="checkbox" checked={targets.has(s.id)} onChange={e => setTargets(prev => { const n = new Set(prev); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} className="accent-[var(--color-accent)] w-4 h-4" />
                  <span className="truncate">{s.name}</span>
                  {s.comment && <span className="text-xs text-[var(--color-text-muted)] truncate">· {s.comment}</span>}
                </label>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={LABEL_CLS}>Показывать</label>
          <div className="flex flex-wrap gap-1">
            {DURATIONS.map(d => (
              <button key={d.m} type="button" onClick={() => setMinutes(d.m)}
                className={`min-h-9 px-3 rounded-md text-sm border ${minutes === d.m ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-medium' : 'border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>{d.l}</button>
            ))}
          </div>
        </div>
        {error && <div className="text-sm text-[var(--color-negative)]">{error}</div>}
        <button type="submit" className={BTN_PRIMARY} disabled={!canSend || create.isPending}>{create.isPending ? 'Отправляем…' : 'Отправить на экраны'}</button>
      </form>

      <div className="flex flex-col gap-4 min-w-0">
        <section>
          <div className="text-sm font-semibold text-[var(--color-text)] mb-2">Сейчас на экранах {active.length > 0 && <span className="text-[var(--color-text-muted)] font-normal">· {active.length}</span>}</div>
          {isLoading && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
          {!isLoading && active.length === 0 && <div className="text-sm text-[var(--color-text-muted)] rounded-lg border border-dashed border-[var(--color-border)] p-4">Активных рассылок нет</div>}
          <div className="flex flex-col gap-2">
            {active.map(m => <MessageRow key={m.id} m={m} onStop={() => stop.mutate(m.id)} stopping={stop.isPending} />)}
          </div>
        </section>
        {past.length > 0 && (
          <section>
            <div className="text-sm font-semibold text-[var(--color-text-muted)] mb-2">За последние сутки</div>
            <div className="flex flex-col gap-2 opacity-70">
              {past.map(m => <MessageRow key={m.id} m={m} />)}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function MessageRow({ m, onStop, stopping }: { m: TvMessage; onStop?: () => void; stopping?: boolean }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 flex flex-col sm:flex-row sm:items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-[var(--color-text)] break-words">{m.text}</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-1 flex flex-wrap gap-x-2">
          <span>{KIND_LABEL[m.kind]}</span>
          <span>· {m.targetScreenNames ? m.targetScreenNames.join(', ') : 'все экраны'}</span>
          <span>· {fmtTime(m.startsAt)}–{fmtTime(m.endsAt)}</span>
          {m.createdByName && <span>· {m.createdByName}</span>}
        </div>
      </div>
      {onStop && <button type="button" className={BTN_SECONDARY} onClick={onStop} disabled={stopping}><Square size={14} /> Снять</button>}
    </div>
  );
}
