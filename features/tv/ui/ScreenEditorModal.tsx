'use client';
// Создание / правка экрана телевизора: отделы, режим показа, тема, карусель,
// бегущая строка, события («мувики»). Radix-модал (components/ui/Modal).
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { DEFAULT_SCREEN_SETTINGS, type TvEventStyle, type TvScreen, type TvScreenInput } from '../shared';
import { DeptTreePicker, flattenNames, useOrgTree } from './DeptTreePicker';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT_CLS, LABEL_CLS } from './api';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL_CLS}>{label}</label>
      {children}
      {hint && <div className="text-xs text-[var(--color-text-muted)]">{hint}</div>}
    </div>
  );
}

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { v: T; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--color-bg-hover)] w-fit">
      {options.map(o => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)}
          className={`min-h-9 px-3 rounded-md text-sm ${value === o.v ? 'bg-[var(--color-bg-surface)] text-[var(--color-text)] font-medium shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 min-h-9 cursor-pointer text-sm text-[var(--color-text)]">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="accent-[var(--color-accent)] w-4 h-4 shrink-0" />
      {label}
    </label>
  );
}

function toInput(s: TvScreen | null): TvScreenInput {
  return s ? {
    name: s.name, comment: s.comment, departmentIds: s.departmentIds, mode: s.mode, theme: s.theme, rotateSec: s.rotateSec,
    tickerText: s.tickerText, tickerEnabled: s.tickerEnabled, settings: s.settings,
  } : {
    name: '', comment: null, departmentIds: [], mode: 'carousel', theme: 'dark', rotateSec: 20,
    tickerText: null, tickerEnabled: false, settings: DEFAULT_SCREEN_SETTINGS,
  };
}

export function ScreenEditorModal({ open, screen, onClose, onSave, saving, error }: {
  open: boolean; screen: TvScreen | null; onClose: () => void;
  onSave: (input: TvScreenInput) => void; saving: boolean; error: string | null;
}) {
  const [form, setForm] = useState<TvScreenInput>(() => toInput(screen));
  const set = <K extends keyof TvScreenInput>(k: K, v: TvScreenInput[K]) => setForm(f => ({ ...f, [k]: v }));
  const ev = form.settings.events;
  const setEv = (patch: Partial<typeof ev>) => set('settings', { ...form.settings, events: { ...ev, ...patch } });
  const setS = (patch: Partial<TvScreenInput['settings']>) => set('settings', { ...form.settings, ...patch });
  const { data: orgData } = useOrgTree();
  const deptNames = flattenNames(orgData?.tree ?? []);
  const setDeptTicker = (id: string, text: string) => {
    const next = { ...form.settings.deptTickers };
    if (text.trim()) next[id] = text; else delete next[id];
    setS({ deptTickers: next });
  };

  return (
    <Modal open={open} onOpenChange={v => { if (!v) onClose(); }} title={screen ? `Экран «${screen.name}»` : 'Новый экран'} desktopWidth="sm:max-w-2xl">
      <form className="flex flex-col gap-5" onSubmit={e => { e.preventDefault(); onSave(form); }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Название">
            <input className={INPUT_CLS} value={form.name} onChange={e => set('name', e.target.value)} placeholder="ОС МСК + ЖБИ МСК" autoFocus />
          </Field>
          <Field label="Где висит (комментарий)">
            <input className={INPUT_CLS} value={form.comment ?? ''} onChange={e => set('comment', e.target.value || null)} placeholder="Москва, кабинет ОС, у окна" />
          </Field>
        </div>

        <Field label="Отделы на экране" hint="Узел = все менеджеры его поддерева. Филиал или «Монолит» добавляют экран карточек подчинённых отделов; несколько узлов — карусель или общая сетка.">
          <DeptTreePicker value={form.departmentIds} onChange={ids => set('departmentIds', ids)} />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Несколько отделов">
            <Seg value={form.mode} onChange={v => set('mode', v)} options={[{ v: 'carousel', label: 'Карусель' }, { v: 'merged', label: 'Одна сетка' }]} />
          </Field>
          <Field label="Тема">
            <Seg value={form.theme} onChange={v => set('theme', v)} options={[{ v: 'dark', label: 'Тёмная' }, { v: 'light', label: 'Светлая' }]} />
          </Field>
          <Field label="Топ-6 висит, сек" hint="Первый экран отдела — шесть лучших по продажам.">
            <input type="number" min={5} max={300} className={INPUT_CLS} value={form.rotateSec} onChange={e => set('rotateSec', Number(e.target.value) || 20)} />
          </Field>
          <Field label="Остальные страницы, сек" hint="Хвост отдела — страницами по 6 человек, смена плавным затуханием.">
            <input type="number" min={3} max={300} className={INPUT_CLS} value={form.settings.rotateTailSec} onChange={e => setS({ rotateTailSec: Math.min(300, Math.max(3, Number(e.target.value) || 10)) })} />
          </Field>
          <Field label="Цель «продажеброней» в день" hint="Продажи + брони по количеству; при достижении — зелёным.">
            <input type="number" min={1} max={100} className={INPUT_CLS} value={form.settings.dailyTarget} onChange={e => setS({ dailyTarget: Math.min(100, Math.max(1, Number(e.target.value) || 5)) })} />
          </Field>
          <Field label="Аватары">
            <Check checked={form.settings.showAvatars} onChange={v => setS({ showAvatars: v })} label="Показывать фото менеджеров" />
          </Field>
        </div>

        <Field label="Бегущая строка" hint="У каждого отдела своя строка; если для отдела не задана — общая. Разовые рассылки — на вкладке «Рассылки».">
          {form.departmentIds.map(id => (
            <div key={id} className="flex flex-col gap-1">
              <div className="text-xs text-[var(--color-text)] font-medium">{deptNames.get(id) ?? 'Отдел'}</div>
              <textarea className={`${INPUT_CLS} min-h-[48px]`} value={form.settings.deptTickers[id] ?? ''} onChange={e => setDeptTicker(id, e.target.value)}
                placeholder={form.departmentIds.length > 1 ? 'Строка этого отдела (пусто — общая)' : 'Например: Скандик по 899 с Петровича!'} />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <div className="text-xs text-[var(--color-text-muted)] font-medium">Общая строка экрана</div>
            <textarea className={`${INPUT_CLS} min-h-[48px]`} value={form.tickerText ?? ''} onChange={e => set('tickerText', e.target.value || null)} placeholder="Например: До конца месяца 12 рабочих дней — жмём!" />
          </div>
          <div className="flex flex-wrap gap-4">
            <Check checked={form.tickerEnabled} onChange={v => set('tickerEnabled', v)} label="Показывать строки" />
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">Скорость
              <Seg value={form.settings.tickerSpeed} onChange={v => setS({ tickerSpeed: v })}
                options={[{ v: 'slow', label: 'Медленно' }, { v: 'normal', label: 'Обычно' }, { v: 'fast', label: 'Быстро' }]} />
            </div>
          </div>
        </Field>

        <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className={LABEL_CLS}>События на весь экран</div>
            <Check checked={ev.enabled} onChange={v => setEv({ enabled: v })} label="Включены" />
          </div>
          <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 ${ev.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
            <Check checked={ev.sale} onChange={v => setEv({ sale: v })} label="Новая продажа" />
            <Check checked={ev.planDone} onChange={v => setEv({ planDone: v })} label="Отдел выполнил план дня" />
            <Field label="Порог суммы продажи, ₽" hint="0 — праздновать любую">
              <input type="number" min={0} step={10000} className={INPUT_CLS} value={ev.minAmount} onChange={e => setEv({ minAmount: Math.max(0, Number(e.target.value) || 0) })} />
            </Field>
            <Field label="Длительность, сек">
              <input type="number" min={3} max={120} className={INPUT_CLS} value={ev.durationSec} onChange={e => setEv({ durationSec: Math.min(120, Math.max(3, Number(e.target.value) || 12)) })} />
            </Field>
            <Field label="Оформление">
              <Seg<TvEventStyle> value={ev.style} onChange={v => setEv({ style: v })}
                options={[{ v: 'confetti', label: 'Конфетти' }, { v: 'flash', label: 'Вспышка' }, { v: 'minimal', label: 'Тихий тост' }]} />
            </Field>
            <Field label="Звук" hint="Фанфары. На части телевизоров браузер не даёт звук без нажатия — тогда молча.">
              <Check checked={ev.sound} onChange={v => setEv({ sound: v })} label="Со звуком" />
            </Field>
          </div>
        </div>

        {error && <div className="text-sm text-[var(--color-negative)]">{error}</div>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Отмена</button>
          <button type="submit" className={BTN_PRIMARY} disabled={saving}>{saving ? 'Сохраняем…' : screen ? 'Сохранить' : 'Создать экран'}</button>
        </div>
      </form>
    </Modal>
  );
}
