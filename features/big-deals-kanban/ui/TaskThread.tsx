'use client';
// Единая лента переписки задачи (владелец 25.11: «везде единообразие по представлению переписок из задач и везде
// возможность написать сообщение прямо из канбана»; спецификация Fable 25.11, раздел 3). Одна лента на чат самой
// задачи и чаты связанных задач (логист, снабжение):
//  • свои сообщения — справа (от СМОТРЯЩЕГО, а не от исполнителя, как было), чужие — слева с именем и ролью;
//  • подряд от одного автора в пределах 5 минут — склеиваются, разделители дней;
//  • служебные события Битрикса: важные (завершил, вернул, просрочена, сменил исполнителя) — строкой с иконкой,
//    прочие подряд идущие — свёрнуты в «N событий» с раскрытием;
//  • автосообщения канбана («…из Монолитики», «из канбана больших чеков») — событием, текст РОПа после пустой строки — пузырём;
//  • «— новое с прошлого раза —» по lastSeenAt и прокрутка к нему; иначе — к последнему сообщению.
// ThreadComposer — поле ответа: Enter — отправить, Shift+Enter — строка, @ — отметить, «Шаблоны» — вопросы, скрепка — файлы.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AtSign, CheckCircle2, ChevronDown, CornerUpLeft, Paperclip, Send, Settings, UserRoundCog, Zap } from 'lucide-react';
import { Popover } from '@/components/ui/Popover';
import { AttachmentsRow, useAttachments } from '@/features/repeat-kanban/ui/Attachments';
import type { BigChatMessage } from '../engine/taskDetails';
import { suggestTemplate } from '../engine/templateDefaults';
import { BbText } from './BbText';
import { QuestionsBlock, templateText, useBigTemplates } from './QuestionsBlock';

const MSK = 3 * 3600_000;
const dayKey = (iso: string) => new Date(Date.parse(iso) + MSK).toISOString().slice(0, 10);
const dayLabel = (iso: string) => {
  const k = dayKey(iso), today = dayKey(new Date().toISOString()), yest = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  if (k === today) return 'Сегодня';
  if (k === yest) return 'Вчера';
  return new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', weekday: 'short' });
};
const hm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const fullDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const SIGNIFICANT = /(завершил|вернул|просрочен|изменил исполнителя|отметил сообщение как результат|возобновил|принял|отклонил|делегировал)/i;
const AUTO = /(из Монолитики|из канбана больших чеков)/i;

type Item =
  | { k: 'day'; label: string; key: string }
  | { k: 'new'; key: string; since: string }
  | { k: 'event'; key: string; m: BigChatMessage; icon: 'done' | 'back' | 'late' | 'user' | 'auto' | 'other'; text: string }
  | { k: 'events'; key: string; list: BigChatMessage[] }
  | { k: 'msg'; key: string; m: BigChatMessage; bb: string; mine: boolean; head: boolean };

function iconOf(t: string): 'done' | 'back' | 'late' | 'user' | 'other' {
  if (/завершил|принял|результат/i.test(t)) return 'done';
  if (/вернул|возобновил/i.test(t)) return 'back';
  if (/просрочен/i.test(t)) return 'late';
  if (/исполнител|делегировал/i.test(t)) return 'user';
  return 'other';
}

export function buildItems(messages: BigChatMessage[], viewerId: string | null, lastSeenAt: string | null): Item[] {
  const out: Item[] = [];
  let day = '', newShown = false, pendingSys: BigChatMessage[] = [];
  let prev: { author: string; at: number } | null = null;
  const flush = () => {
    if (!pendingSys.length) return;
    if (pendingSys.length === 1) out.push({ k: 'event', key: `e${pendingSys[0].id}`, m: pendingSys[0], icon: 'other', text: pendingSys[0].text });
    else out.push({ k: 'events', key: `g${pendingSys[0].id}`, list: pendingSys });
    pendingSys = [];
  };
  for (const m of messages) {
    const dk = dayKey(m.at);
    if (dk !== day) { flush(); day = dk; out.push({ k: 'day', label: dayLabel(m.at), key: `d${dk}` }); prev = null; }
    const mine = !!viewerId && m.authorId === viewerId;
    if (!newShown && lastSeenAt && !m.system && !mine && m.at > lastSeenAt) {
      flush(); out.push({ k: 'new', key: 'new', since: lastSeenAt }); newShown = true; prev = null;
    }
    if (m.system) {
      if (SIGNIFICANT.test(m.text)) { flush(); out.push({ k: 'event', key: `e${m.id}`, m, icon: iconOf(m.text), text: m.text }); }
      else pendingSys.push(m);
      prev = null;
      continue;
    }
    flush();
    const raw = m.bb ?? m.text;
    if (AUTO.test(m.text.split('\n')[0] ?? '')) {
      // «Возвращено на доработку из канбана… \n Новый срок: …\n\nВопрос РОПа» — событие + пузырь с текстом РОПа.
      const [head, ...rest] = raw.split(/\n\s*\n/);
      out.push({ k: 'event', key: `a${m.id}`, m, icon: 'auto', text: head.replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, '').trim() });
      const body = rest.join('\n\n').trim();
      if (body || m.files?.length) out.push({ k: 'msg', key: `m${m.id}`, m, bb: body, mine, head: true });
      prev = null;
      continue;
    }
    const t = Date.parse(m.at);
    const head = !(prev && prev.author === m.authorId && t - prev.at < 5 * 60_000);
    out.push({ k: 'msg', key: `m${m.id}`, m, bb: raw, mine, head });
    prev = { author: m.authorId, at: t };
  }
  flush();
  return out;
}

const ICON = { done: CheckCircle2, back: CornerUpLeft, late: AlertTriangle, user: UserRoundCog, auto: Zap, other: Settings } as const;
const ICON_CLS = { done: 'text-[var(--color-positive)]', back: 'text-[var(--color-warning)]', late: 'text-[var(--color-negative)]', user: 'text-[var(--color-accent)]', auto: 'text-[var(--color-accent)]', other: 'text-[var(--color-text-muted)]' } as const;

export function TaskThread({ messages, viewerId, roles = {}, lastSeenAt = null, loading = false, emptyText = 'Сообщений пока нет', className = '' }: {
  messages: BigChatMessage[] | null; viewerId: string | null;
  /** Bitrix id → роль у имени: «исполнитель», «логист», «РОП». */
  roles?: Record<string, string>;
  lastSeenAt?: string | null; loading?: boolean; emptyText?: string; className?: string;
}) {
  const items = useMemo(() => buildItems(messages ?? [], viewerId, lastSeenAt), [messages, viewerId, lastSeenAt]);
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const count = messages?.length ?? 0;
  // Прокрутка: к «новому», иначе вниз — при первой загрузке и при новых сообщениях.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const mark = el.querySelector('[data-new-divider]') as HTMLElement | null;
    el.scrollTop = mark ? Math.max(0, mark.offsetTop - 12) : el.scrollHeight;
  }, [count]);

  return (
    <div ref={box} className={`flex min-h-0 min-w-0 flex-col gap-1.5 overflow-y-auto overflow-x-hidden pr-1 ${className}`}>
      {loading && <p className="text-[var(--color-text-muted)]">Загружаю переписку…</p>}
      {!loading && messages && !messages.length && <p className="text-[var(--color-text-muted)]">{emptyText}</p>}
      {items.map(it => {
        if (it.k === 'day') return <div key={it.key} className="sticky top-0 z-[1] mx-auto my-1 rounded-full bg-[var(--color-bg-surface)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] shadow-sm">{it.label}</div>;
        if (it.k === 'new') return (
          <div key={it.key} data-new-divider className="my-1 flex items-center gap-2 text-[11px] font-semibold text-[var(--color-accent)]">
            <span className="h-px flex-1 bg-[var(--color-accent)]" />новое с прошлого раза ({fullDT(it.since)})<span className="h-px flex-1 bg-[var(--color-accent)]" />
          </div>
        );
        if (it.k === 'event') {
          const I = ICON[it.icon];
          return (
            <div key={it.key} className="flex min-w-0 items-start justify-center gap-1.5 px-2 text-center text-[11.5px] text-[var(--color-text-secondary)]">
              <I size={12} className={`mt-[2px] shrink-0 ${ICON_CLS[it.icon]}`} aria-hidden />
              <span className="min-w-0 break-words">{it.icon === 'auto' && it.m.author ? <b className="font-medium">{it.m.author}: </b> : null}{it.text}<span className="ml-1 text-[var(--color-text-muted)]">· {hm(it.m.at)}</span></span>
            </div>
          );
        }
        if (it.k === 'events') {
          const isOpen = open.has(it.key);
          return (
            <div key={it.key} className="flex min-w-0 flex-col items-center gap-0.5">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(s => { const n = new Set(s); if (n.has(it.key)) n.delete(it.key); else n.add(it.key); return n; })}
                className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[11.5px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
                <Settings size={12} aria-hidden /> {it.list.length} {plural(it.list.length, 'событие', 'события', 'событий')} · {hm(it.list[0].at)}–{hm(it.list[it.list.length - 1].at)}
                <ChevronDown size={12} className={isOpen ? 'rotate-180' : ''} aria-hidden />
              </button>
              {isOpen && it.list.map(m => <p key={m.id} className="px-2 text-center text-[11.5px] text-[var(--color-text-secondary)]">{m.text} <span className="text-[var(--color-text-muted)]">· {hm(m.at)}</span></p>)}
            </div>
          );
        }
        const m = it.m;
        const role = roles[m.authorId];
        return (
          <div key={it.key} className={`flex min-w-0 max-w-[88%] flex-col ${it.mine ? 'self-end items-end' : 'self-start items-start'} ${it.head ? 'mt-1' : ''}`}>
            {it.head && (
              <div className="px-1 text-[11px] text-[var(--color-text-muted)]">
                {it.mine ? 'Вы' : (m.author ?? `#${m.authorId}`)}{role && !it.mine ? <span className="ml-1 rounded bg-[var(--color-bg-hover)] px-1">{role}</span> : null} · {hm(m.at)}
              </div>
            )}
            <div className={`min-w-0 max-w-full rounded-2xl px-3 py-1.5 ${it.mine ? 'rounded-tr-md bg-[var(--color-accent-soft)]' : 'rounded-tl-md bg-[var(--color-bg-hover)]'}`} title={it.head ? undefined : fullDT(m.at)}>
              {it.bb && <BbText text={it.bb} />}
              {m.files && m.files.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {m.files.map((f, i) => <FileChip key={i} name={f.name} url={f.url} n={i + 1} />)}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const plural = (n: number, a: string, b: string, c: string) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };

/** Файл сообщения: имя вебхуку чаще недоступно — «Файл 1»; открывается в Битриксе. */
function FileChip({ name, url, n }: { name: string; url: string | null; n: number }) {
  const label = name && name !== 'файл' ? name : `Файл ${n}`;
  const cls = 'inline-flex min-h-8 max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2.5 text-[12px]';
  return url
    ? <a href={url} target="_blank" rel="noreferrer" title="Откроется в Битриксе (нужен вход в Битрикс)" className={`${cls} text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]`}><Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{label}</span></a>
    : <span className={`${cls} text-[var(--color-text-secondary)]`}><Paperclip size={12} className="shrink-0" aria-hidden /><span className="min-w-0 truncate">{label}</span></span>;
}

/** Шаблоны вопросов компактно (Fable 25.11): чип шаблона «по стадии» в один тап + «Шаблоны» — весь список в поповере.
 *  Одинаково в чате и в формах «Назначить» / «Вернуть» — вместо стены из 9 чипов. */
export function TemplatePicker({ onInsert, questions, deal, mock = false, showBest = true }: {
  onInsert: (text: string) => void; questions?: string[];
  deal?: { stageName: string; categoryId?: number | null } | null; mock?: boolean; showBest?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = useBigTemplates(mock);
  const best = t.data ? suggestTemplate(t.data, deal) : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {showBest && best && (
        <button type="button" onClick={() => onInsert(templateText(best.questions))} title={templateText(best.questions)}
          className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1 rounded-full border border-[var(--color-accent)] px-3 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
          <span className="shrink-0 text-[10.5px] uppercase opacity-80">по стадии</span><span className="min-w-0 truncate font-semibold">{best.name}</span><span className="shrink-0 opacity-60">· {best.questions.length}</span>
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen} side="bottom" align="start" className="w-[420px] max-w-[calc(100vw-16px)] p-3"
        trigger={<button type="button" className="inline-flex min-h-9 items-center gap-1 rounded-full border border-[var(--color-border)] px-3 text-[12px] hover:bg-[var(--color-bg-hover)]">Шаблоны<ChevronDown size={12} aria-hidden /></button>}>
        <QuestionsBlock questions={questions} deal={deal} mock={mock} onInsert={s => { onInsert(s); setOpen(false); }} />
      </Popover>
    </div>
  );
}

export interface MentionTarget { id: string; name: string; role: string }

/** Поле ответа. onSend бросает ошибку — текст остаётся, ошибка показывается. */
export function ThreadComposer({ onSend, placeholder, mentions = [], questions, deal, mock = false, inject, compact = false }: {
  onSend: (text: string, attachments: string[]) => Promise<string[] | void>;
  placeholder: string;
  mentions?: MentionTarget[];
  questions?: string[];
  deal?: { stageName: string; categoryId?: number | null } | null;
  mock?: boolean;
  /** Текст снаружи (ИИ-оценка) — дописывается в черновик; key — чтобы сработал повтор. */
  inject?: { text: string; key: number } | null;
  /** Для связанных задач: без шаблонов. */
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false);
  const [atOpen, setAtOpen] = useState(false);
  const att = useAttachments();
  const ta = useRef<HTMLTextAreaElement>(null);
  const t = useBigTemplates(mock);
  const best = !compact && t.data ? suggestTemplate(t.data, deal) : null;
  // Упоминание — в начало строки, остальное — с новой строки.
  const insert = (s: string) => {
    setText(prev => (!prev.trim() ? s : s.startsWith('[USER=') ? `${s}${prev.trimStart()}` : `${prev.trimEnd()}\n${s}`));
    requestAnimationFrame(() => ta.current?.focus());
  };
  useEffect(() => { if (inject?.text) insert(inject.text); }, [inject?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Авторост до ~6 строк.
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const can = !busy && (!!text.trim() || att.files.length > 0);
  const send = async () => {
    if (!can) return;
    setBusy(true); setErr(null); setWarn(null);
    try {
      const attachments = await att.upload();
      const w = await onSend(text.trim(), attachments);
      setText(''); for (let i = att.files.length - 1; i >= 0; i--) att.remove(i);
      if (w && w.length) setWarn(w.join(' '));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const iconBtn = 'tap-target inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]';

  return (
    <div className="flex min-w-0 flex-col gap-1.5" {...att.dropZone}>
      {best && !text.trim() && (
        <button type="button" onClick={() => insert(templateText(best.questions))} title={templateText(best.questions)}
          className="inline-flex min-h-9 min-w-0 max-w-full items-center gap-1 self-start rounded-full border border-[var(--color-accent)] px-3 text-[12px] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]">
          <span className="shrink-0 text-[10.5px] uppercase opacity-80">по стадии</span><span className="min-w-0 truncate font-semibold">{best.name}</span><span className="shrink-0 opacity-60">· {best.questions.length}</span>
        </button>
      )}
      <div className={`flex min-w-0 items-end gap-1 rounded-xl border bg-[var(--color-bg-surface)] p-1 ${att.dragOver ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
        {mentions.length > 0 && (
          <Popover open={atOpen} onOpenChange={setAtOpen} side="top" align="start" className="w-[280px] max-w-[calc(100vw-16px)] p-1"
            trigger={<button type="button" className={iconBtn} aria-label="Отметить человека" title="Отметить — Битрикс пришлёт уведомление"><AtSign size={16} /></button>}>
            <div className="flex flex-col">
              {mentions.map(m => (
                <button key={m.id} type="button" onClick={() => { insert(`[USER=${m.id}]${m.name}[/USER], `); setAtOpen(false); }}
                  className="flex min-h-11 min-w-0 items-center gap-2 rounded px-2 text-left text-[13px] hover:bg-[var(--color-bg-hover)] sm:min-h-9">
                  <span className="min-w-0 flex-1 truncate">{m.name}</span><span className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{m.role}</span>
                </button>
              ))}
            </div>
          </Popover>
        )}
        {!compact && (
          <Popover open={tplOpen} onOpenChange={setTplOpen} side="top" align="start" className="w-[420px] max-w-[calc(100vw-16px)] p-3"
            trigger={<button type="button" className={`${iconBtn} w-auto px-2 text-[12px]`} title="Шаблоны вопросов">Шаблоны</button>}>
            <QuestionsBlock questions={questions} deal={deal} mock={mock} onInsert={s => { insert(s); setTplOpen(false); }} />
          </Popover>
        )}
        <label className={`${iconBtn} cursor-pointer`} title="Прикрепить файл (картинку можно вставить Ctrl/⌘+V или перетащить)">
          <Paperclip size={16} /><input type="file" multiple className="sr-only" onChange={e => { if (e.target.files) att.add(Array.from(e.target.files)); e.target.value = ''; }} />
        </label>
        <textarea ref={ta} value={text} onChange={e => setText(e.target.value)} onPaste={att.onPaste} rows={1}
          placeholder={placeholder} title="Enter — отправить, Shift+Enter — новая строка"
          onKeyDown={e => { if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return; e.preventDefault(); void send(); }}
          className="min-h-9 w-full min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-base outline-none sm:text-sm" />
        <button type="button" onClick={() => void send()} disabled={!can} aria-label="Отправить" title="Отправить (Enter)"
          className="inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] px-2.5 text-white disabled:opacity-40">
          {busy ? <span className="text-[12px]">…</span> : <Send size={15} />}
        </button>
      </div>
      {att.files.length > 0 && <AttachmentsRow a={att} />}
      {(err || att.error) && <p role="alert" className="text-[12.5px] text-[var(--color-negative)]">{err ?? att.error}</p>}
      {warn && <p role="status" className="text-[12.5px] text-[var(--color-warning)]">{warn}</p>}
    </div>
  );
}

