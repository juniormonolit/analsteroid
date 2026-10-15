'use client';
// Общие детали карточки клиента (модуль «Карточка клиента», 13.10): плашки,
// секции, сохранение, рекомендации, ручные поля клиента. Табы — в соседних файлах.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Lightbulb, Pencil, Sparkles } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';

import {
  type ClientModuleData, type ClientType, type Recommendation, type ObjectStatus, type DealStage,
  CLIENT_TYPES, TYPES_WITH_OCCUPATION, isSelfBuilder, OBJECT_STATUS_LABEL, DEAL_STAGE_LABEL,
} from '../engine/types';

/** Дата «ДД.ММ.ГГ» — экономим место (правка владельца 14.10: «26, а не 2026»). */
export function fmtD(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y.slice(2)}`;
}

/** Название сделки для людей: Битрикс по умолчанию называет «Сделка #267347» —
 *  такое заменяем на первый товар сделки (ID владелец просил не выводить). */
export function dealTitle(d: { name: string | null; products: { name: string; isService: boolean }[]; topGroup: string | null }): string {
  const n = (d.name ?? '').trim();
  if (n && !/^сделка\s*#?\s*\d+$/i.test(n)) return n;
  const p = d.products.find(x => !x.isService) ?? d.products[0];
  return p?.name ?? d.topGroup ?? 'Сделка';
}

export type Tone = 'muted' | 'neg' | 'warn' | 'ok' | 'accent';
const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  muted: { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' },
  neg: { color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' },
  warn: { color: 'var(--color-warning, #e8590c)', backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 12%, transparent)' },
  ok: { color: 'var(--color-positive, #2f9e44)', backgroundColor: 'color-mix(in srgb, var(--color-positive, #2f9e44) 10%, transparent)' },
  accent: { color: 'var(--color-accent)', backgroundColor: 'color-mix(in srgb, var(--color-accent) 10%, transparent)' },
};

export function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: Tone; title?: string }) {
  return <span title={title} className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-semibold" style={TONE_STYLE[tone]}>{children}</span>;
}

export const STATUS_TONE: Record<ObjectStatus, Tone> = { new: 'accent', active: 'ok', done: 'muted' };
export const STAGE_TONE: Record<DealStage, Tone> = { shipped: 'ok', sold: 'warn', active: 'accent', lost: 'neg' };
export const StatusChip = ({ s }: { s: ObjectStatus }) => <Chip tone={STATUS_TONE[s]}>{OBJECT_STATUS_LABEL[s]}</Chip>;
const DOT: Record<ObjectStatus, string> = { new: 'var(--color-accent)', active: 'var(--color-positive, #2f9e44)', done: 'var(--color-text-muted)' };
/** Статус объекта точкой (аудит 14.10: чип на каждом объекте — шум). */
export const StatusDot = ({ s }: { s: ObjectStatus }) => (
  <span title={OBJECT_STATUS_LABEL[s]} aria-label={OBJECT_STATUS_LABEL[s]} className="mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: DOT[s] }} />
);

/** «сегодня» / «вчера» / «N дн. назад». */
export function daysAgoShort(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? 'сегодня' : d === 1 ? 'вчера' : `${d} дн. назад`;
}
export const StageChip = ({ s }: { s: DealStage }) => <Chip tone={STAGE_TONE[s]}>{DEAL_STAGE_LABEL[s]}</Chip>;

export function Section({ title, right, children, className = '' }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3 ${className}`}>
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, hint }: { label: string; value: React.ReactNode; sub?: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2" title={hint}>
      <div className="text-[11px] leading-tight text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 truncate text-[16px] font-bold leading-tight tabular-nums text-[var(--color-text)]">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] leading-tight text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

/** Вариант выбора с пояснением под «?» (ТЗ). Hover на таче не работает (правило 5
 *  CLAUDE.md) — «?» кнопка: hover показывает title, тап раскрывает пояснение. */
export function OptionRow({ name, label, hint, checked, onSelect, showHintWhenChecked = false }: { name: string; label: string; hint?: string; checked: boolean; onSelect: () => void; showHintWhenChecked?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border px-2.5 py-1 ${checked ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]' : 'border-[var(--color-border)]'}`}>
      <div className="flex min-h-9 items-center gap-2">
        <label className="flex min-h-10 min-w-0 flex-1 cursor-pointer items-center gap-2 text-[13.5px]">
          <input type="radio" name={name} checked={checked} onChange={onSelect} className="shrink-0 accent-[var(--color-accent)]" />
          <span className="min-w-0">{label}</span>
        </label>
        {hint && (
          <button type="button" onClick={() => setOpen(v => !v)} title={hint} aria-label="Пояснение" aria-expanded={open}
            className="tap-target shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            <HelpCircle size={15} />
          </button>
        )}
      </div>
      {(open || (showHintWhenChecked && checked)) && hint && <div className="pb-1 pl-6 text-[12px] leading-snug text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  );
}

export const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';
export const selectCls = 'h-10 min-w-0 max-w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-base sm:text-[13px] outline-none focus:border-[var(--color-accent)]';

export function SaveBar({ dirty, saving, error, savedAt, onSave, disabled, label = 'Сохранить' }: {
  dirty: boolean; saving: boolean; error: string | null; savedAt: string | null; onSave: () => void; disabled?: boolean; label?: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={onSave} disabled={!dirty || saving || disabled}
        className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">
        {saving ? 'Сохраняем…' : label}
      </button>
      {error ? <span className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error}</span>
        : savedAt ? <span className="text-[12px] text-[var(--color-text-muted)]">{savedAt}</span> : null}
    </div>
  );
}

export function useSave(params: Record<string, string>) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (payload: object): Promise<{ objectKey?: string | null } | null> => {
    setSaving(true); setError(null);
    try {
      const r = await apiFetch('/api/modules/client-card/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, ...payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось сохранить');
      if (j.warning) setError(j.warning);
      await qc.invalidateQueries({ queryKey: ['client-module'] });
      return j;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
      return null;
    } finally { setSaving(false); }
  };
  return { save, saving, error };
}

export const savedLine = (by: string | null, at: string | null) => (at ? `Сохранено ${fmtD(at)}${by ? ` · ${by}` : ''}` : null);

// ── «Что предложить» ────────────────────────────────────────────────────────

export function RecList({ recs, empty, onDismiss, hidden, onRestore }: {
  recs: Recommendation[]; empty: string;
  /** «Не предлагать» (миграция 007). Нет — кнопки не показываем. */
  onDismiss?: (group: string) => void;
  hidden?: string[];
  onRestore?: (group: string) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      {recs.length === 0 && <div className="text-[12.5px] text-[var(--color-text-muted)]">{empty}</div>}
      {recs.map(r => (
        <div key={r.group} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
          {/* Название — целой строкой (правка владельца 15.10: «Бетон / и / раствор» по слову
              из-за процента и кнопки в той же строке); процент и вопрос — под ним. */}
          <div className="flex items-start gap-2">
            <Lightbulb size={15} className="mt-0.5 shrink-0 text-[var(--color-warning,#e8590c)]" />
            <span className="min-w-0 flex-1 text-[14px] font-semibold leading-snug">{r.group}</span>
            {onDismiss && (
              <button type="button" onClick={() => onDismiss(r.group)} title="Не предлагать этому клиенту"
                className="tap-target shrink-0 whitespace-nowrap text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-negative,#e03131)]">не предлагать</button>
            )}
          </div>
          {(r.pct !== null || r.sources.includes('priority')) && (
            <div className="mt-1 flex flex-wrap gap-1.5 pl-[23px]">
              {r.pct !== null && <span title={`После «${r.pctAfter}» следующей покупкой берут «${r.group}» в ${r.pct}% случаев (клиенты того же профиля)`} className="rounded bg-[var(--color-bg-hover)] px-1.5 py-px text-[11.5px] font-semibold leading-snug text-[var(--color-text-muted)]">{r.pct}% берут после «{shortGroup(r.pctAfter)}»</span>}
              {r.sources.includes('priority') && <Chip tone="accent" title="Ручной приоритет «Настройки → Что предложить»">приоритет</Chip>}
            </div>
          )}
          {r.ask && (
            <div className="mt-1 pl-[23px] text-[12.5px] leading-snug text-[var(--color-text-muted)]">
              {r.after && <>После «{shortGroup(r.after)}» спросите: </>}<span className="text-[var(--color-text)]">«{r.ask.replace(/^[-–—\s]+/, '')}»</span>
            </div>
          )}
        </div>
      ))}
      {hidden && hidden.length > 0 && (
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          <button type="button" onClick={() => setShowHidden(v => !v)} className="min-h-8 hover:text-[var(--color-text)]">скрыто {hidden.length} · {showHidden ? 'свернуть' : 'показать'}</button>
          {showHidden && (
            <div className="flex flex-wrap gap-1.5">
              {hidden.map(g => (
                <span key={g} className="inline-flex items-center gap-1 rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5">
                  {shortGroup(g)}
                  {onRestore && <button type="button" onClick={() => onRestore(g)} className="tap-target text-[var(--color-accent)]">вернуть</button>}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** «Не предлагать» / «вернуть» для рекомендаций клиента (objectKey '') или объекта. */
export function useDismiss(data: ClientModuleData, params: Record<string, string>, objectKey = '') {
  const { save, error } = useSave(params);
  if (!data.dismissAvailable) return { onDismiss: undefined, onRestore: undefined, error: null };
  return {
    onDismiss: (group: string) => void save({ dismiss: { group, objectKey, active: true } }),
    onRestore: (group: string) => void save({ dismiss: { group, objectKey, active: false } }),
    error,
  };
}

export function shortGroup(g: string | null): string {
  if (!g) return '';
  return g.replace(/, водосточные системы$/, '').replace(/ \(Лакокрасочные материалы\)$/, '').replace(/ стальн[а-яё]+( и проволока)?$/, '');
}

// ── Клиент: тип, «чем занимается», заметка ─────────────────────────────────
// Аудит 14.10: четыре радиокнопки на треть первого экрана ради поля, которое
// заполняют один раз, — свёрнуто в строку под именем; редактор раскрывается.

/** Поле, растущее по высоте вместе с текстом (заметки: «не в одну строчку»).
 *  Минимум задаёт rows, максимум — maxRows, дальше внутренний скролл. */
export function AutoTextarea({ value, onChange, minRows = 3, maxRows = 14, className = '', textareaRef, ...rest }:
  { value: string; onChange: (v: string) => void; minRows?: number; maxRows?: number; textareaRef?: React.RefObject<HTMLTextAreaElement | null> }
  & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'>) {
  const own = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? own;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 22;
    const chrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = 'auto';
    const want = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const max = line * maxRows + chrome;
    el.style.height = `${Math.min(want, max)}px`;
    // Скролл — только когда упёрлись в максимум (иначе лишняя полоса справа).
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }, [value, maxRows, ref]);
  return <textarea ref={ref} value={value} onChange={e => onChange(e.target.value)} rows={minRows}
    className={`${inputCls} resize-none leading-relaxed ${className}`} {...rest} />;
}

export function ClientBar({ data, params, openSignal = 0 }: { data: ClientModuleData; params: Record<string, string>; openSignal?: number }) {
  const p = data.profile;
  const [edit, setEdit] = useState<false | 'type' | 'note'>(false);
  // «Другой тип» из подсказки на «Обзоре» открывает редактор здесь.
  const rootRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (openSignal > 0) { setEdit('type'); rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }, [openSignal]);
  const [type, setType] = useState<ClientType | null>(p.clientType);
  const [occupation, setOccupation] = useState(p.occupation);
  const [note, setNote] = useState(p.note);
  const reset = () => { setType(p.clientType); setOccupation(p.occupation); setNote(p.note); };
  useEffect(reset, [p]); // eslint-disable-line react-hooks/exhaustive-deps
  // Клик по заметке — курсор сразу в поле, в конец текста.
  useEffect(() => {
    if (edit !== 'note') return;
    const el = noteRef.current; if (!el) return;
    el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  }, [edit]);
  const { save, saving, error } = useSave(params);
  const dirty = type !== p.clientType || occupation !== p.occupation || note !== p.note;
  const typeLabel = CLIENT_TYPES.find(t => t.value === p.clientType)?.label;
  const hint = data.profilesAvailable ? data.hint : null;
  const close = () => { reset(); setEdit(false); };
  const doSave = async () => {
    if (!dirty || saving || !data.profilesAvailable) return;
    const r = await save({ client: { clientType: type, occupation: type && TYPES_WITH_OCCUPATION.has(type) ? occupation : '', note } });
    if (r) setEdit(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doSave(); }
  };

  return (
    <div ref={rootRef} className="min-w-0">
      {!edit && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* Тип не указан — подсказка «Похоже, это …» прямо здесь (аудит 15.10:
                раньше тип спрашивали дважды — в шапке и отдельной карточкой). */}
            {!typeLabel && hint ? (
              <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] py-1 pl-2.5 pr-1 text-[13px]">
                <Sparkles size={13} className="text-[var(--color-accent)]" />
                <span>Похоже, <b>{CLIENT_TYPES.find(t => t.value === hint.type)?.label}</b>{hint.confidence === 'high' ? '' : '?'}</span>
                <button type="button" disabled={saving} title={hint.reasons.join('\n')}
                  onClick={() => void save({ client: { clientType: hint.type, occupation: TYPES_WITH_OCCUPATION.has(hint.type) ? hint.occupation : '', note: p.note } })}
                  className="min-h-8 rounded-md bg-[var(--color-accent)] px-2.5 text-[12.5px] font-semibold text-white disabled:opacity-60">{saving ? '…' : 'Да'}</button>
                <button type="button" onClick={() => setEdit('type')} className="min-h-8 rounded-md px-2 text-[12.5px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Другой</button>
              </span>
            ) : (
              <button type="button" onClick={() => setEdit('type')}
                className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[13px] ${typeLabel ? 'border-transparent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] font-semibold text-[var(--color-accent)]' : 'border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {typeLabel ?? 'Указать тип клиента'} <Pencil size={12} />
              </button>
            )}
            {p.occupation && <span className="text-[13px] text-[var(--color-text-muted)]">{p.occupation}</span>}
          </div>
          {/* Заметка — заметным блоком целиком, а не обрезанной строкой. */}
          {p.note ? (
            <button type="button" onClick={() => setEdit('note')} title="Изменить заметку"
              className="group w-full rounded-xl border border-[color-mix(in_srgb,#f2c94c_55%,transparent)] bg-[color-mix(in_srgb,#f2c94c_14%,transparent)] px-3 py-2.5 text-left">
              <span className="mb-0.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Заметка о клиенте <Pencil size={11} className="opacity-60 group-hover:opacity-100" />
              </span>
              <span className="block whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[var(--color-text)]">{p.note}</span>
              {savedLine(p.updatedBy, p.updatedAt) && <span className="mt-1 block text-[11.5px] text-[var(--color-text-muted)]">{savedLine(p.updatedBy, p.updatedAt)}</span>}
            </button>
          ) : (
            <button type="button" onClick={() => setEdit('note')}
              className="flex min-h-11 w-full items-center rounded-xl border border-dashed border-[var(--color-border)] px-3 text-left text-[13px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]">
              + Заметка о клиенте — что важно помнить перед звонком
            </button>
          )}
        </div>
      )}
      {edit && (
        <div onKeyDown={onKey} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 shadow-sm">
          {/* Редактируем то, на что нажали (аудит 15.10): заметка — без пяти радио сверху. */}
          {edit === 'type' ? (
            <>
            <div className="mb-1.5 text-[12px] font-semibold text-[var(--color-text-muted)]">Тип клиента</div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {CLIENT_TYPES.map(t => (
                <OptionRow key={t.value} name={`ct-${data.ref}`} label={t.label} hint={t.hint} checked={type === t.value} onSelect={() => setType(t.value)} showHintWhenChecked />
              ))}
            </div>
            {type && TYPES_WITH_OCCUPATION.has(type) && (
              <label className="mt-3 block">
                <span className="mb-1 block text-[12px] font-semibold text-[var(--color-text-muted)]">Чем занимается</span>
                <input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={500} placeholder="Например: фундаменты, дороги, кровля" className={inputCls} />
              </label>
            )}
            {isSelfBuilder(type) && <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">Тип дома (каркасный / газобетонный) — у каждого объекта (вкладка «Объекты»).</div>}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-[var(--color-text-muted)]">
              Тип: <span className="text-[var(--color-text)]">{CLIENT_TYPES.find(t => t.value === type)?.label ?? 'не указан'}</span>
              <button type="button" onClick={() => setEdit('type')} className="min-h-8 text-[var(--color-accent)] hover:underline">изменить</button>
            </div>
          )}
          <label className={`${edit === 'type' ? 'mt-3' : 'mt-1'} block`}>
            <span className="mb-1 block text-[12px] font-semibold text-[var(--color-text-muted)]">Заметка о клиенте</span>
            <AutoTextarea textareaRef={noteRef} value={note} onChange={setNote} maxLength={2000} minRows={3}
              placeholder="Что важно помнить: как общаться, что строит, какие договорённости…" />
            <span className="mt-0.5 block text-right text-[11px] text-[var(--color-text-muted)]">{note.length} / 2000</span>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={doSave} disabled={!dirty || saving || !data.profilesAvailable}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-5 text-sm font-semibold text-white disabled:opacity-40">{saving ? 'Сохраняем…' : 'Сохранить'}</button>
            <button type="button" onClick={close} className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Отмена</button>
            <span className="hidden text-[11px] text-[var(--color-text-muted)] sm:inline">Ctrl/⌘+Enter — сохранить · Esc — отмена</span>
          </div>
          {(error || !data.profilesAvailable) ? <div className="mt-1 text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error ?? 'Хранилище ручных полей недоступно'}</div>
            : savedLine(p.updatedBy, p.updatedAt) && <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">{savedLine(p.updatedBy, p.updatedAt)}</div>}
        </div>
      )}
    </div>
  );
}
