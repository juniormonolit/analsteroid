'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, MessageSquare } from 'lucide-react';
import type { DismissalAnnouncement } from '../types';
import { fmtDateTime } from './planMath';

// v4 «Сторож увольнений»: черновик заведён ботом по сообщению в чате «Увольнения».
// Баннер: откуда (автор, время, текст, ссылка), срок с цветом по близости, уровень эскалации,
// история уведомлений по раскрытию; после запуска — спокойный итог «вовремя / с опозданием».

const TZ = 'Europe/Moscow';
const LEVEL_TITLE = ['Написали РОПу', 'Эскалировано директору', 'Эскалировано Куликову'] as const;

export type DeadlineTone = 'ok' | 'today' | 'overdue';

const mskDay = (d: Date) => d.toLocaleDateString('ru-RU', { timeZone: TZ });

/** «до 18:00 вт 25.11» */
export function deadlineText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const wd = d.toLocaleDateString('ru-RU', { timeZone: TZ, weekday: 'short' });
  const day = d.toLocaleDateString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  return `до ${time} ${wd} ${day}`;
}

export function deadlineTone(a: Pick<DismissalAnnouncement, 'deadline' | 'resolvedAt'>, now = Date.now()): DeadlineTone {
  const d = new Date(a.deadline);
  if (now > d.getTime()) return 'overdue';
  return mskDay(d) === mskDay(new Date(now)) ? 'today' : 'ok';
}

export const TONE_CLS: Record<DeadlineTone, string> = {
  ok: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
  today: 'bg-[var(--color-warning)]/15 text-[var(--color-warning)]',
  overdue: 'bg-[var(--color-negative)]/15 text-[var(--color-negative)]',
};

function durationText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} мин`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.round(h / 24)} дн.`;
}

/** Итог после запуска: вовремя / с опозданием (от исходного срока — до первой эскалации). */
export function resolvedText(a: DismissalAnnouncement): { text: string; late: boolean } | null {
  if (!a.resolvedAt) return null;
  const res = Date.parse(a.resolvedAt);
  const firstEsc = a.notified.filter(n => n.level >= 1).map(n => Date.parse(n.at)).filter(Number.isFinite).sort((x, y) => x - y)[0];
  const original = firstEsc ?? Date.parse(a.deadline);
  if (!Number.isFinite(res) || !Number.isFinite(original) || res <= original) return { text: 'Запущено вовремя', late: false };
  return { text: `Запущено с опозданием на ${durationText(res - original)}`, late: true };
}

function levelLine(a: DismissalAnnouncement): string {
  if (a.level === 2) return LEVEL_TITLE[2];
  const who = [...a.notified].reverse().find(n => n.level === a.level)?.name;
  return who ? `${LEVEL_TITLE[a.level]} ${who}` : LEVEL_TITLE[a.level];
}

export function AnnouncementBanner({ a }: { a: DismissalAnnouncement }) {
  const [open, setOpen] = useState(false);
  const res = resolvedText(a);
  const tone = deadlineTone(a);
  const frame = res
    ? 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'
    : tone === 'overdue' ? 'border-[var(--color-negative)]/40 bg-[var(--color-negative)]/5'
    : tone === 'today' ? 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/5'
    : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]';
  return (
    <div className={`mb-3 rounded-xl border p-3 sm:px-4 ${frame}`}>
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-2 text-sm text-[var(--color-text)]">
          <MessageSquare size={16} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
          <p className="min-w-0 break-words">
            <span className="text-[var(--color-text-muted)]">Из чата «Увольнения» · {a.authorName}, {fmtDateTime(a.announcedAt)}: </span>
            «{a.text}»
            {a.messageUrl && (
              <>{' · '}<a href={a.messageUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">сообщение <ExternalLink size={12} /></a></>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-6 md:shrink-0 md:pl-0">
          {res ? (
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${res.late ? 'bg-[var(--color-bg-hover)] text-[var(--color-text)]' : 'bg-[var(--color-positive)]/15 text-[var(--color-positive)]'}`}>{res.text}</span>
          ) : (
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium tabular-nums ${TONE_CLS[tone]}`}>
              {tone === 'overdue' ? `Просрочено: срок был ${deadlineText(a.deadline).replace(/^до /, '')}` : `Запустить ${deadlineText(a.deadline)}`}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 pl-6">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="inline-flex min-h-11 items-center gap-1 text-left text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] sm:min-h-7">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {res ? `${levelLine(a)} · история` : levelLine(a)}{a.notified.length > 0 && ` · уведомлений ${a.notified.length}`}
        </button>
        {open && (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--color-text-muted)]">
            {a.notified.length === 0 && <li>Уведомлений ещё не было.</li>}
            {a.notified.map((n, i) => (
              <li key={i} className="break-words">{fmtDateTime(n.at)} · {LEVEL_TITLE[n.level]}{n.level < 2 ? ` ${n.name}` : ''}</li>
            ))}
            {a.resolvedAt && <li className="break-words">{fmtDateTime(a.resolvedAt)} · прогон запущен</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
