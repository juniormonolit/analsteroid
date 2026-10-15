'use client';
// Общие детали карточки клиента (модуль «Карточка клиента», 13.10): плашки,
// секции, сохранение, рекомендации, ручные поля клиента. Табы — в соседних файлах.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HelpCircle, Lightbulb, Pencil } from 'lucide-react';
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
export function OptionRow({ name, label, hint, checked, onSelect }: { name: string; label: string; hint?: string; checked: boolean; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border px-2.5 py-1 ${checked ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]' : 'border-[var(--color-border)]'}`}>
      <div className="flex min-h-9 items-center gap-2">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[13px]">
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
      {open && hint && <div className="pb-1 pl-6 text-[12px] leading-snug text-[var(--color-text-muted)]">{hint}</div>}
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
  return g.replace(/, водосточные системы$/, '').replace(/ \(Лакокрасочные материалы\)$/, '').replace(/ стальн\w+( и проволока)?$/, '');
}

// ── Клиент: тип, «чем занимается», заметка ─────────────────────────────────
// Аудит 14.10: четыре радиокнопки на треть первого экрана ради поля, которое
// заполняют один раз, — свёрнуто в строку под именем; редактор раскрывается.

export function ClientBar({ data, params, openSignal = 0 }: { data: ClientModuleData; params: Record<string, string>; openSignal?: number }) {
  const p = data.profile;
  const [edit, setEdit] = useState(false);
  // «Другой тип» из подсказки на «Обзоре» открывает редактор здесь.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (openSignal > 0) { setEdit(true); rootRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }, [openSignal]);
  const [type, setType] = useState<ClientType | null>(p.clientType);
  const [occupation, setOccupation] = useState(p.occupation);
  const [note, setNote] = useState(p.note);
  useEffect(() => { setType(p.clientType); setOccupation(p.occupation); setNote(p.note); }, [p]);
  const { save, saving, error } = useSave(params);
  const dirty = type !== p.clientType || occupation !== p.occupation || note !== p.note;
  const typeLabel = CLIENT_TYPES.find(t => t.value === p.clientType)?.label;

  return (
    <div ref={rootRef} className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <button type="button" onClick={() => setEdit(v => !v)}
          className={`inline-flex min-h-8 items-center gap-1 rounded-lg border px-2 ${typeLabel ? 'border-transparent bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] font-semibold text-[var(--color-accent)]' : 'border-dashed border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
          {typeLabel ?? 'Тип клиента не указан'} <Pencil size={11} />
        </button>
        {p.occupation && <span className="text-[var(--color-text-muted)]">{p.occupation}</span>}
        <button type="button" onClick={() => setEdit(true)} className="min-h-8 min-w-0 max-w-full truncate text-left text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title={p.note || undefined}>
          {p.note ? <>📝 {p.note}</> : '+ заметка'}
        </button>
      </div>
      {edit && (
        <div className="mt-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
          <div className="grid gap-1.5 sm:grid-cols-2">
            {CLIENT_TYPES.map(t => (
              <OptionRow key={t.value} name={`ct-${data.ref}`} label={t.label} hint={t.hint} checked={type === t.value} onSelect={() => setType(t.value)} />
            ))}
          </div>
          {type && TYPES_WITH_OCCUPATION.has(type) && (
            <label className="mt-2 block">
              <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Чем занимается</span>
              <input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={500} placeholder="Например: фундаменты, дороги, кровля" className={inputCls} />
            </label>
          )}
          {isSelfBuilder(type) && <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">Тип дома (каркасный / газобетонный) — у каждого объекта (вкладка «Объекты»).</div>}
          <label className="mt-2 block">
            <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Заметка</span>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} className={inputCls} />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <SaveBar dirty={dirty} saving={saving} error={error ?? (data.profilesAvailable ? null : 'Хранилище ручных полей недоступно')}
              disabled={!data.profilesAvailable} savedAt={savedLine(p.updatedBy, p.updatedAt)}
              onSave={async () => {
                const r = await save({ client: { clientType: type, occupation: type && TYPES_WITH_OCCUPATION.has(type) ? occupation : '', note } });
                if (r) setEdit(false);
              }} />
            <button type="button" onClick={() => setEdit(false)} className="mt-2 min-h-11 rounded-lg px-3 text-sm text-[var(--color-text-muted)]">Закрыть</button>
          </div>
        </div>
      )}
    </div>
  );
}
