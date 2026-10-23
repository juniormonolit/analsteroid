'use client';
// Страница «Как работать?» канбана повторных (владелец 22.10: «положи в кнопку „Как работать?“ со
// скриншотами, чтобы было интересно и понятно максимально»). Контент — guide/content.ts (данные),
// здесь только отрисовка: оглавление, разделы, скриншоты, мини-квизы.
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle, ArrowLeft, BarChart3, BookOpen, ClipboardCheck, Columns3, EyeOff, HelpCircle, IdCard, KeyRound,
  Lightbulb, ListPlus, Merge, PhoneOff, Search, Sparkles, Sun, User, Zap, type LucideIcon,
} from 'lucide-react';
import type { Guide, GuideBlock, GuideSection } from './types';

// Имена иконок lucide-react, которые использует content.ts. Новая иконка в контенте — добавить сюда.
const ICONS: Record<string, LucideIcon> = {
  BarChart3, ClipboardCheck, Columns3, EyeOff, HelpCircle, IdCard, KeyRound, ListPlus, Merge, PhoneOff, Search, Sun, User, Zap,
};
const iconOf = (name: string) => ICONS[name] ?? BookOpen;

/** **жирный** и `кнопка` — больше разметки в контенте нет. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <>
      {parts.map((p, i) => p.startsWith('**') ? <b key={i} className="font-semibold text-[var(--color-text)]">{p.slice(2, -2)}</b>
        : p.startsWith('`') ? (
          <span key={i} className="mx-0.5 inline-flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-1.5 py-px text-[0.92em] font-medium text-[var(--color-text)] shadow-[0_1px_0_var(--color-border)]">{p.slice(1, -1)}</span>
        ) : <Fragment key={i}>{p}</Fragment>)}
    </>
  );
}

function Shot({ id, caption, what }: { id: string; caption: string; what: string }) {
  const [missing, setMissing] = useState(false);
  const [zoom, setZoom] = useState(false);
  const src = `/guide/repeat-kanban/${id}.jpg`;
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      {missing ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4 text-center text-sm text-[var(--color-text-muted)]">
          <span className="font-medium">Скриншот скоро будет</span><span className="text-xs">{what}</span>
        </div>
      ) : (
        <button type="button" onClick={() => setZoom(z => !z)} title={zoom ? 'Уменьшить' : 'Увеличить'}
          className={`block min-w-0 max-w-full self-start overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] shadow-sm ${zoom ? 'cursor-zoom-out' : 'cursor-zoom-in'}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={caption} loading="lazy" onError={() => setMissing(true)}
            className={`block h-auto max-w-full ${zoom ? '' : 'max-h-[460px] object-contain object-top'}`} />
          {/* Без w-full: снимок не растягивается шире своего размера (крупные планы карточек — 300 px) и не мылится. */}
        </button>
      )}
      <figcaption className="text-xs text-[var(--color-text-muted)]">{caption}</figcaption>
    </figure>
  );
}

function Quiz({ q, options, answer, why }: Extract<GuideBlock, { type: 'quiz' }>) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-soft)] p-3 sm:p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-accent)]"><Sparkles size={16} /> Проверьте себя</div>
      <div className="text-[15px] font-medium text-[var(--color-text)]"><Rich text={q} /></div>
      <div className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const state = picked === null ? 'idle' : i === answer ? 'right' : i === picked ? 'wrong' : 'idle';
          return (
            <button key={i} type="button" disabled={picked !== null} onClick={() => setPicked(i)}
              className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm ${state === 'right' ? 'border-[#6aa84f] bg-[#d9ead3] text-[#274e13]'
                : state === 'wrong' ? 'border-[#cc0000] bg-[#f4cccc] text-[#660000]'
                : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              <Rich text={o} />
            </button>
          );
        })}
      </div>
      {picked !== null && (
        <div className="text-sm text-[var(--color-text-secondary)]">
          <b className={picked === answer ? 'text-[#38761d]' : 'text-[#990000]'}>{picked === answer ? 'Верно! ' : 'Не совсем. '}</b><Rich text={why} />
          {picked !== answer && <button type="button" onClick={() => setPicked(null)} className="ml-2 text-[var(--color-accent)] underline">ещё раз</button>}
        </div>
      )}
    </div>
  );
}

function Block({ b }: { b: GuideBlock }) {
  switch (b.type) {
    case 'p': return <p className="leading-relaxed text-[var(--color-text-secondary)]"><Rich text={b.text} /></p>;
    case 'list': return (
      <ul className="flex list-disc flex-col gap-1 pl-5 leading-relaxed text-[var(--color-text-secondary)]">
        {b.items.map((x, i) => <li key={i}><Rich text={x} /></li>)}
      </ul>
    );
    case 'steps': return (
      <ol className="flex flex-col gap-2">
        {b.items.map((x, i) => (
          <li key={i} className="flex gap-3 leading-relaxed text-[var(--color-text-secondary)]">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-xs font-bold text-white">{i + 1}</span>
            <span className="min-w-0"><Rich text={x} /></span>
          </li>
        ))}
      </ol>
    );
    case 'tip': return (
      <div className="flex gap-2.5 rounded-xl bg-[#d9ead3] p-3 text-sm leading-relaxed text-[#274e13]">
        <Lightbulb size={18} className="mt-0.5 shrink-0" /><div className="min-w-0"><Rich text={b.text} /></div>
      </div>
    );
    case 'warn': return (
      <div className="flex gap-2.5 rounded-xl bg-[#fce5cd] p-3 text-sm leading-relaxed text-[#783f04]">
        <AlertTriangle size={18} className="mt-0.5 shrink-0" /><div className="min-w-0"><Rich text={b.text} /></div>
      </div>
    );
    case 'table': return (
      <div className="scroll-x rounded-xl border border-[var(--color-border)]">
        <table className="w-full min-w-[480px] border-collapse text-sm">
          <thead><tr className="bg-[var(--color-bg-surface)]">{b.head.map((h, i) => <th key={i} className="px-3 py-2 text-left font-semibold text-[var(--color-text)]">{h}</th>)}</tr></thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i} className="border-t border-[var(--color-border)] align-top">
                {r.map((c, j) => <td key={j} className={`px-3 py-2 leading-relaxed ${j === 0 ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'}`}><Rich text={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    case 'shot': return <Shot id={b.id} caption={b.caption} what={b.what} />;
    case 'quiz': return <Quiz {...b} />;
  }
}

function Section({ s, n }: { s: GuideSection; n: number }): ReactNode {
  const Icon = iconOf(s.icon);
  return (
    <section id={s.id} data-guide-section={s.id} className="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent)]"><Icon size={20} /></span>
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
            Шаг {n}{s.audience === 'manager' ? ' · для менеджера' : s.audience === 'rop' ? ' · для РОПа' : ''}
          </div>
          <h2 className="text-lg font-bold text-[var(--color-text)] sm:text-xl">{s.title}</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">{s.lead}</p>
        </div>
      </header>
      {s.blocks.map((b, i) => <Block key={i} b={b} />)}
    </section>
  );
}

type Who = 'all' | 'rop' | 'manager';

export function GuidePage({ guide }: { guide: Guide }) {
  const [who, setWho] = useState<Who>('all');
  const [active, setActive] = useState<string>(guide.sections[0]?.id ?? '');
  const sections = useMemo(() => guide.sections.filter(s => who === 'all' || !s.audience || s.audience === who), [guide, who]);

  // Активный раздел оглавления — по прокрутке (корень страницы — свой скролл-контейнер).
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('[data-guide-section]')];
    const io = new IntersectionObserver(entries => {
      const top = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive((top.target as HTMLElement).dataset.guideSection ?? '');
    }, { rootMargin: '0px 0px -70% 0px' });
    els.forEach(e => io.observe(e));
    return () => io.disconnect();
  }, [sections]);
  const go = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#${id}`); };

  const whoBtn = (w: Who, label: string) => (
    <button type="button" onClick={() => setWho(w)} aria-pressed={who === w}
      className={`min-h-11 rounded-lg px-3 text-sm ${who === w ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{label}</button>
  );

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-[var(--color-bg-surface)]">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <Link href="/repeat-kanban" className="inline-flex min-h-11 items-center gap-1.5 self-start text-sm text-[var(--color-accent)] hover:underline">
          <ArrowLeft size={16} /> К канбану
        </Link>
        <div className="flex flex-col gap-2 rounded-2xl bg-[var(--color-accent)] p-5 text-white sm:p-7">
          <div className="flex items-center gap-2 text-sm opacity-90"><BookOpen size={16} /> Инструкция</div>
          <h1 className="text-2xl font-bold leading-tight sm:text-3xl">{guide.title}</h1>
          <p className="max-w-3xl text-[15px] leading-relaxed opacity-95"><Rich text={guide.intro} /></p>
          <div className="mt-1 flex flex-wrap gap-1 self-start rounded-xl bg-white/95 p-1" role="group" aria-label="Для кого">
            {whoBtn('all', 'Всё')}{whoBtn('rop', 'Я РОП')}{whoBtn('manager', 'Я менеджер')}
          </div>
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          {/* Оглавление: на телефоне — переносящиеся чипы (без горизонтальной ленты), на десктопе — липкая колонка. */}
          <nav aria-label="Разделы" className="min-w-0 lg:sticky lg:top-4 lg:self-start">
            <div className="flex flex-wrap gap-1.5 lg:flex-col lg:gap-0.5">
              {sections.map((s, i) => (
                <button key={s.id} type="button" onClick={() => go(s.id)}
                  className={`min-h-11 rounded-lg px-3 text-left text-sm lg:min-h-10 ${active === s.id ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]' : 'bg-[var(--color-bg)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] lg:bg-transparent'}`}>
                  <span className="mr-1.5 tabular-nums text-[var(--color-text-muted)]">{i + 1}.</span>{s.title}
                </button>
              ))}
            </div>
          </nav>
          <div className="flex min-w-0 flex-col gap-4">
            {sections.map((s, i) => <Section key={s.id} s={s} n={i + 1} />)}
            <p className="pb-6 text-center text-xs text-[var(--color-text-muted)]">
              Инструкция обновлена {guide.updated.split('-').reverse().join('.')}. Что-то непонятно или устарело — напишите РОПу или владельцу системы.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
