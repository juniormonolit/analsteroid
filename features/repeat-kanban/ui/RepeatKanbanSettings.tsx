'use client';
// «Настройки» канбана повторных продаж (владелец 21.10) — боковая панель справа, только
// админам (canManageRepeatKanbanSettings): вкладки «Общие» (норма активных задач на
// менеджера) и «Шаблоны сообщений» (текст задачи с плейсхолдерами, предпросмотр на
// реальном заказчике). Здесь же TemplatePicker — выбор шаблона в окне постановки задачи.
// API: /api/repeat-kanban/settings, /api/repeat-kanban/templates/render.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Plus, Save, Settings, Shuffle, Star, Trash2 } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PLACEHOLDERS, toDisplayBody, toStoredBody } from '../engine/templatePlaceholders';
import type { KanbanSettings, MessageTemplate } from '../engine/settings';

interface SettingsState { settings: KanbanSettings; templates: MessageTemplate[]; canManage: boolean }
interface RenderResult { text: string; templateId: number | null; clientKey: string; managerId: string }

const QK = ['repeat-kanban-settings'] as const;

const fieldCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors disabled:opacity-50';
const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const BTN_PRIMARY = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent)] text-white hover:opacity-90`;
const BTN_DANGER = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init ? { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error || `Ошибка ${r.status}`);
  return j as T;
}

function useKanbanSettings(enabled = true) {
  return useQuery<SettingsState, Error>({
    queryKey: QK,
    queryFn: () => api<SettingsState>('/api/repeat-kanban/settings'),
    staleTime: 60_000,
    enabled,
  });
}

async function renderText(body: Record<string, unknown>): Promise<RenderResult> {
  return api<RenderResult>('/api/repeat-kanban/templates/render', { method: 'POST', body: JSON.stringify(body) });
}

// ── Кнопка + панель ────────────────────────────────────────────────────────

/** Кнопка «Настройки» для шапки доски. Сама решает, показываться ли: только админам. */
export function RepeatKanbanSettingsButton({ className }: { className?: string }) {
  const { data } = useKanbanSettings();
  const [open, setOpen] = useState(false);
  if (!data?.canManage) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className ?? BTN_IDLE} title="Норма задач на менеджера, шаблоны сообщений к задаче">
        <Settings size={16} /> Настройки
      </button>
      <Drawer open={open} onOpenChange={setOpen} title="Настройки канбана повторных">
        {open && <SettingsPanel state={data} />}
      </Drawer>
    </>
  );
}

type Tab = 'general' | 'templates';
const TABS: { key: Tab; label: string }[] = [
  { key: 'general', label: 'Общие' },
  { key: 'templates', label: 'Шаблоны сообщений' },
];

function SettingsPanel({ state }: { state: SettingsState }) {
  const [tab, setTab] = useState<Tab>('general');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Две вкладки — переносом (flex-wrap), без горизонтальной ленты (CLAUDE.md, п.12). */}
      <div className="flex flex-wrap gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1" role="tablist">
        {TABS.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-md px-3 text-sm ${tab === t.key ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' ? <GeneralTab settings={state.settings} /> : <TemplatesTab templates={state.templates} />}
    </div>
  );
}

// ── «Общие» ────────────────────────────────────────────────────────────────

function GeneralTab({ settings }: { settings: KanbanSettings }) {
  const qc = useQueryClient();
  const [limit, setLimit] = useState(String(settings.managerTaskLimit));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dirty = limit.trim() !== String(settings.managerTaskLimit);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const next = await api<SettingsState>('/api/repeat-kanban/settings', { method: 'PUT', body: JSON.stringify({ settings: { managerTaskLimit: Number(limit) } }) });
      qc.setQueryData(QK, next);
      setLimit(String(next.settings.managerTaskLimit));
      setMsg({ ok: true, text: 'Сохранено' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Не удалось сохранить' });
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="font-medium">Норма активных задач на менеджера</span>
        <input type="number" inputMode="numeric" min={1} max={200} step={1} value={limit}
          onChange={e => { setLimit(e.target.value); setMsg(null); }} className={`${fieldCls} max-w-[160px]`} />
        <span className="text-xs text-[var(--color-text-muted)]">
          Активные — незакрытые и не сданные на проверку задачи проекта «Повторные продажи». По умолчанию 10.
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={save} disabled={busy || !dirty} className={BTN_PRIMARY}>
          <Save size={16} /> {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
        {msg && <span className={msg.ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}>{msg.text}</span>}
      </div>
    </div>
  );
}

// ── «Шаблоны сообщений» ────────────────────────────────────────────────────

const NEW_ID = 0;
interface Draft { id: number; name: string; body: string; isDefault: boolean }
const draftOf = (t: MessageTemplate): Draft => ({ id: t.id, name: t.name, body: toDisplayBody(t.body), isDefault: t.isDefault });
const emptyDraft = (): Draft => ({ id: NEW_ID, name: '', body: '', isDefault: false });

function TemplatesTab({ templates }: { templates: MessageTemplate[] }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => (templates[0] ? draftOf(templates[0]) : emptyDraft()));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<Draft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const original = templates.find(t => t.id === draft.id);
  const dirty = original
    ? draft.name !== original.name || toStoredBody(draft.body) !== original.body || draft.isDefault !== original.isDefault
    : draft.name.trim() !== '' || draft.body.trim() !== '';

  const switchTo = (next: Draft) => {
    if (dirty) { setPendingSwitch(next); return; }
    setDraft(next); setMsg(null);
  };

  const insert = (label: string) => {
    const token = `{{${label}}}`;
    const el = areaRef.current;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const body = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft(d => ({ ...d, body }));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload = { name: draft.name, body: toStoredBody(draft.body), isDefault: draft.isDefault };
      const next = draft.id === NEW_ID
        ? await api<SettingsState & { created?: MessageTemplate }>('/api/repeat-kanban/settings', { method: 'POST', body: JSON.stringify(payload) })
        : await api<SettingsState & { created?: MessageTemplate }>('/api/repeat-kanban/settings', { method: 'PUT', body: JSON.stringify({ template: { id: draft.id, ...payload } }) });
      qc.setQueryData(QK, { settings: next.settings, templates: next.templates, canManage: next.canManage });
      const savedId = next.created?.id ?? draft.id;
      const saved = next.templates.find(t => t.id === savedId);
      if (saved) setDraft(draftOf(saved));
      setMsg({ ok: true, text: 'Сохранено' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Не удалось сохранить' });
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setMsg(null);
    try {
      const next = await api<SettingsState>(`/api/repeat-kanban/settings?id=${draft.id}`, { method: 'DELETE' });
      qc.setQueryData(QK, next);
      setDraft(next.templates[0] ? draftOf(next.templates[0]) : emptyDraft());
      setMsg({ ok: true, text: 'Шаблон удалён' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Не удалось удалить' });
    } finally { setBusy(false); setConfirmDelete(false); }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4 text-sm">
      {/* Список шаблонов */}
      <div className="flex flex-col gap-1.5">
        {templates.map(t => (
          <button key={t.id} type="button" onClick={() => switchTo(draftOf(t))}
            className={`flex min-h-11 min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left ${draft.id === t.id ? 'border-[var(--color-accent)] bg-[var(--color-bg-hover)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]'}`}>
            <span className="min-w-0 flex-1 truncate">{t.name}</span>
            {t.isDefault && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-xs text-white">
                <Star size={11} /> по умолчанию
              </span>
            )}
          </button>
        ))}
        <button type="button" onClick={() => switchTo(emptyDraft())}
          className={`${BTN_IDLE} justify-start ${draft.id === NEW_ID ? 'border-[var(--color-accent)]' : ''}`}>
          <Plus size={16} /> Новый шаблон
        </button>
      </div>

      {/* Редактор */}
      <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Название</span>
          <input value={draft.name} maxLength={120} onChange={e => { setDraft(d => ({ ...d, name: e.target.value })); setMsg(null); }}
            placeholder="Например: «Повторная — прораб»" className={fieldCls} />
        </label>

        <div className="flex flex-col gap-1">
          <span className="font-medium">Вставить данные заказчика</span>
          <div className="flex flex-wrap gap-1.5">
            {PLACEHOLDERS.map(p => (
              <button key={p.key} type="button" onClick={() => insert(p.label)} title={p.hint}
                className="inline-flex min-h-11 items-center rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-xs text-[var(--color-text)] hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] sm:min-h-9">
                + {p.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-medium">Текст задачи</span>
          <textarea ref={areaRef} value={draft.body} rows={10} maxLength={5000}
            onChange={e => { setDraft(d => ({ ...d, body: e.target.value })); setMsg(null); }}
            placeholder="Заказчик брал {{Последняя покупка}}. Скорее всего, сейчас ему нужны {{Рекомендуемые материалы}} — позвони и предложи."
            className={`${fieldCls} min-h-[200px] resize-y font-[inherit] leading-relaxed`} />
          <span className="text-xs text-[var(--color-text-muted)]">
            Данные в двойных фигурных скобках подставятся по конкретному заказчику, когда РОП ставит задачу.
          </span>
        </label>

        <label className="flex min-h-11 cursor-pointer items-center gap-2">
          <input type="checkbox" checked={draft.isDefault} disabled={!!original?.isDefault}
            onChange={e => setDraft(d => ({ ...d, isDefault: e.target.checked }))} className="h-5 w-5 shrink-0" />
          <span>
            По умолчанию — подставляется в окно задачи сам
            {original?.isDefault && <span className="text-[var(--color-text-muted)]"> (чтобы снять — отметьте другой шаблон)</span>}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={busy || !dirty || !draft.name.trim() || !draft.body.trim()} className={BTN_PRIMARY}>
            <Save size={16} /> {busy ? 'Сохраняю…' : draft.id === NEW_ID ? 'Создать' : 'Сохранить'}
          </button>
          {draft.id !== NEW_ID && (
            <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy} className={BTN_DANGER}>
              <Trash2 size={16} /> Удалить
            </button>
          )}
          {msg && <span className={msg.ok ? 'text-[var(--color-positive)]' : 'text-[var(--color-negative)]'}>{msg.text}</span>}
        </div>
      </div>

      <TemplatePreview body={draft.body} />

      <ConfirmDialog open={pendingSwitch !== null} title="Несохранённые изменения"
        description="Изменения в текущем шаблоне не сохранены и пропадут. Перейти?"
        confirmLabel="Перейти" tone="danger"
        onConfirm={() => { if (pendingSwitch) setDraft(pendingSwitch); setPendingSwitch(null); setMsg(null); }}
        onCancel={() => setPendingSwitch(null)} />
      <ConfirmDialog open={confirmDelete} title="Удалить шаблон?"
        description={`«${draft.name}» удалится без возможности вернуть.${original?.isDefault ? ' Отметка «по умолчанию» перейдёт к первому оставшемуся шаблону.' : ''}`}
        confirmLabel="Удалить" tone="danger" pending={busy}
        onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
    </div>
  );
}

/** Предпросмотр несохранённого текста на реальном заказчике: ключ c123/k456/x789
 *  (видно в ссылке карточки клиента) или «Пример» — любой с последней отгрузкой. */
function TemplatePreview({ body }: { body: string }) {
  const [clientKey, setClientKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (sample: boolean) => {
    setBusy(true); setErr(null);
    try {
      const key = clientKey.trim().toLowerCase();
      const r = await renderText({ body: toStoredBody(body), ...(sample || !key ? { sample: true } : { clientKey: key }) });
      setResult(r);
      if (sample || !key) setClientKey(r.clientKey);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось собрать текст');
    } finally { setBusy(false); }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <span className="font-medium">Предпросмотр на заказчике</span>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={clientKey} onChange={e => setClientKey(e.target.value)} placeholder="Ключ заказчика: c123 или k456"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void run(false); } }}
          className={`${fieldCls} sm:flex-1`} aria-label="Ключ заказчика" />
        <div className="flex gap-2">
          <button type="button" onClick={() => run(false)} disabled={busy || !body.trim()} className={`${BTN_IDLE} flex-1 sm:flex-none`}>
            <Eye size={16} /> Показать
          </button>
          <button type="button" onClick={() => run(true)} disabled={busy || !body.trim()} className={`${BTN_IDLE} flex-1 sm:flex-none`} title="Любой заказчик с последней отгрузкой">
            <Shuffle size={16} /> Пример
          </button>
        </div>
      </div>
      {busy && <p className="text-[var(--color-text-muted)]">Собираю текст… (рекомендации считаются как в карточке клиента — до нескольких секунд)</p>}
      {err && <p className="text-[var(--color-negative)]">{err}</p>}
      {result && !busy && (
        <div className="min-w-0 whitespace-pre-wrap break-words rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-3 leading-relaxed">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Заказчик {result.clientKey}{result.managerId ? ` · менеджер ${result.managerId}` : ''}</div>
          {result.text}
        </div>
      )}
    </div>
  );
}

// ── Пикер шаблона для окна постановки задачи ───────────────────────────────

/**
 * Выбор шаблона в окне задачи: SearchSelect со списком (выбран «по умолчанию»); при выборе
 * собирает текст по заказчику и отдаёт onChange(текст). При открытии, если value пустое,
 * сразу подставляет отрендеренный шаблон по умолчанию. Сам textarea — у вызывающего.
 */
export function TemplatePicker({ clientKey, managerId, value, onChange }: {
  clientKey: string; managerId: string; value: string; onChange: (text: string) => void;
}) {
  const { data, error } = useKanbanSettings();
  const templates = useMemo(() => data?.templates ?? [], [data]);
  const defaultId = templates.find(t => t.isDefault)?.id ?? templates[0]?.id ?? null;
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);
  const autoFor = useRef<string | null>(null);
  // Свежие value/onChange — в ref, чтобы автоподстановка не перезапускалась от каждой буквы.
  const valueRef = useRef(value); valueRef.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;

  const apply = async (templateId: number, onlyIfEmpty: boolean) => {
    const my = ++seq.current;
    setBusy(true); setErr(null);
    try {
      const r = await renderText({ clientKey, managerId, templateId });
      if (my !== seq.current) return;
      if (onlyIfEmpty && valueRef.current.trim()) return; // пока считали, РОП начал писать сам
      onChangeRef.current(r.text);
    } catch (e) {
      if (my === seq.current) setErr(e instanceof Error ? e.message : 'Не удалось собрать текст');
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  // Открыли окно (или сменился заказчик): выбран «по умолчанию»; пустое поле — подставляем.
  useEffect(() => {
    if (defaultId === null || !clientKey) return;
    const key = `${clientKey}:${managerId}`;
    if (autoFor.current === key) return;
    autoFor.current = key;
    setSelected(defaultId);
    if (!valueRef.current.trim()) void apply(defaultId, true);
  }, [defaultId, clientKey, managerId]);

  if (error || (data && templates.length === 0)) return null;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <SearchSelect ariaLabel="Шаблон сообщения" placeholder={data ? 'Шаблон сообщения' : 'Загружаю шаблоны…'}
          disabled={!data || busy}
          options={templates.map(t => ({ value: String(t.id), label: t.name, hint: t.isDefault ? 'по умолчанию' : null }))}
          value={selected !== null ? String(selected) : ''}
          onChange={v => { const id = Number(v); if (!id) return; setSelected(id); void apply(id, false); }}
          className="w-full min-w-0 sm:w-auto sm:min-w-[240px] sm:max-w-full" />
        {busy && <span className="text-xs text-[var(--color-text-muted)]">Собираю текст по заказчику…</span>}
      </div>
      {err && <span className="text-xs text-[var(--color-negative)]">{err}</span>}
    </div>
  );
}
