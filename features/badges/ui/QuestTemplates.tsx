'use client';

// Конструктор квестов (задача 60, миграция 164). Владелец собирает шаблон
// выдачи: на чём квест, за какой период, как считать цель, кому и с каким
// весом. Два вида шаблонов — на встроенной категории и на ПРОИЗВОЛЬНОЙ метрике
// каталога (это и есть «уровень 3» из решения владельца).
//
// Ключевая часть экрана — предпросмотр: показывает, что шаблон выдал бы прямо
// сейчас сильному, среднему и слабому менеджеру. Считает его тот же движок, что
// реальную выдачу, поэтому «в предпросмотре было другое» невозможно.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

type Kind = 'category' | 'metric';
type Period = 'day' | 'week' | 'month';
type TargetMode = 'personal_p75' | 'personal_median' | 'company_median' | 'fixed';
type Tier = 'white' | 'green' | 'blue' | 'epic' | 'legendary';

interface Template {
  id: number; enabled: boolean; name: string; kind: Kind;
  category: string | null; metricId: string | null; periodType: Period;
  targetMode: TargetMode; targetFixed: number | null;
  targetFloor: number | null; targetCeiling: number | null;
  rewardEballs: number | null; weight: number;
  audience: { deptIds?: string[]; managerIds?: number[]; minLevel?: number };
  titleTemplate: string | null;
}
interface MetricOpt { id: string; name: string; category: string | null; dataType: string }
interface PreviewRow {
  mgr: number; ok: boolean; title: string; target: number;
  tier: Tier; reward: number; rewardXp: number; note: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  sales_count: 'Продажи, шт',
  sales_amount: 'Продажи, ₽',
  bookings_count: 'Брони, шт',
  repeat_sales: 'Повторные продажи, шт',
  distinct_groups: 'Разных товарных групп',
  group_sales: 'Продажи товарной группы (шаблоном не выдаётся)',
  crosssell: 'Допродажа пары (шаблоном не выдаётся)',
};
// Категории, где цель — это пара «товарная группа × клиенты», которую движок
// подбирает по данным менеджера. Формой такое не задать, поэтому в списке они
// есть только чтобы не выглядеть пропавшими, но выбрать их нельзя.
const CATEGORY_DISABLED = new Set(['group_sales', 'crosssell']);

const PERIOD_LABELS: Record<Period, string> = { day: 'День', week: 'Неделя', month: 'Месяц' };
const MODE_LABELS: Record<TargetMode, string> = {
  personal_p75: 'Личный p75 (как у встроенных)',
  personal_median: 'Личная медиана + 1',
  company_median: 'Медиана компании (всем одинаково)',
  fixed: 'Фиксированное число',
};
const TIER_LABELS: Record<Tier, string> = {
  white: 'Обычный', green: 'Необычный', blue: 'Редкий', epic: 'Эпический', legendary: 'Легендарный',
};
const TIER_COLORS: Record<Tier, string> = {
  white: '#9ca3af', green: '#2f9e44', blue: '#1c7ed6', epic: '#9c36b5', legendary: '#e8590c',
};

// Кегль 16px на мобильном — иначе iOS зумит при фокусе (правило 9 CLAUDE.md;
// `text-base` в этом проекте = 14px и от зума не спасает).
const fieldCls = 'w-full min-h-11 sm:min-h-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[16px] sm:text-xs';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
      <span>{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-tight opacity-80">{hint}</span>}
    </label>
  );
}

const emptyDraft = (): Template => ({
  id: 0, enabled: true, name: '', kind: 'category', category: 'bookings_count', metricId: null,
  periodType: 'week', targetMode: 'personal_p75', targetFixed: null, targetFloor: null,
  targetCeiling: null, rewardEballs: null, weight: 1, audience: {}, titleTemplate: null,
});

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === '') return null;
  const v = Number(t.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};

export function QuestTemplatesBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<{ templates: Template[]; metrics: MetricOpt[]; error?: string }>({
    queryKey: ['quest-templates'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/quest-templates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<Template | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);

  const save = useMutation({
    mutationFn: async (t: Template) => {
      const res = await fetch('/api/settings/badges/quest-templates', {
        method: t.id > 0 ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(t),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => { setDraft(null); void qc.invalidateQueries({ queryKey: ['quest-templates'] }); },
  });
  const toggle = useMutation({
    mutationFn: async (t: Template) => {
      await fetch('/api/settings/badges/quest-templates', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, enabled: !t.enabled }),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['quest-templates'] }),
  });
  const remove = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`/api/settings/badges/quest-templates?id=${id}`, { method: 'DELETE' });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['quest-templates'] }),
  });

  if (!data) return null;
  const metricsById = new Map(data.metrics.map(m => [m.id, m]));
  const what = (t: Template) => t.kind === 'metric'
    ? (metricsById.get(t.metricId ?? '')?.name ?? t.metricId ?? '—')
    : (CATEGORY_LABELS[t.category ?? ''] ?? t.category ?? '—');

  return (
    <section className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-bold text-[var(--color-text)]">🛠 Конструктор квестов</h2>
          <span className="text-xs text-[var(--color-text-muted)]">
            шаблоны выдачи: на чём, за какой период, кому, с каким весом
          </span>
        </div>
        {!draft && (
          <button
            type="button"
            onClick={() => setDraft(emptyDraft())}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] sm:min-h-9"
          >
            <Plus size={14} /> Добавить шаблон
          </button>
        )}
      </div>

      {data.error && (
        <div className="mb-3 rounded-lg border border-[var(--color-border)] p-2 text-xs text-[var(--color-text-muted)]">
          {data.error}
        </div>
      )}

      <p className="mb-3 text-[11px] leading-snug text-[var(--color-text-muted)]">
        Шаблон не заменяет движок, а настраивает его: подбор цели, тиры и награды остаются общими.
        Вес — балл в сортировке кандидатов; у встроенных он лежит в диапазоне 0,25–1,3, поэтому
        вес 1 ставит шаблон выше обычной продажной цели, но ниже ярко выраженной слабости.
        Пустой список = движок работает только на встроенных кандидатах, как до конструктора.
      </p>

      {data.templates.length > 0 && (
        <div className="scroll-x">
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th className="py-1 pr-2 font-medium">Вкл</th>
                <th className="py-1 pr-2 font-medium">Название</th>
                <th className="py-1 pr-2 font-medium">На чём</th>
                <th className="py-1 pr-2 font-medium">Период</th>
                <th className="py-1 pr-2 font-medium">Цель</th>
                <th className="py-1 pr-2 text-right font-medium">Вес</th>
                <th className="py-1 pr-2 text-right font-medium">Награда</th>
                <th className="py-1 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map(t => (
                <tr key={t.id} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2">
                    <input
                      type="checkbox" checked={t.enabled} onChange={() => toggle.mutate(t)}
                      className="tap-target h-4 w-4 cursor-pointer"
                      aria-label={t.enabled ? 'Выключить шаблон' : 'Включить шаблон'}
                    />
                  </td>
                  <td className="py-1.5 pr-2 font-medium text-[var(--color-text)]">{t.name}</td>
                  <td className="py-1.5 pr-2">
                    {what(t)}
                    {t.kind === 'metric' && <span className="ml-1 opacity-60">(метрика)</span>}
                  </td>
                  <td className="py-1.5 pr-2">{PERIOD_LABELS[t.periodType]}</td>
                  <td className="py-1.5 pr-2">
                    {MODE_LABELS[t.targetMode]}
                    {t.targetMode === 'fixed' && t.targetFixed != null && ` = ${t.targetFixed}`}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{t.weight}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {t.rewardEballs != null ? t.rewardEballs : 'по тиру'}
                  </td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button" onClick={() => setDraft(t)}
                        className="tap-target rounded p-1 hover:bg-[var(--color-bg-hover)]" aria-label="Изменить"
                      ><Pencil size={13} /></button>
                      <button
                        type="button" onClick={() => setDeleteTarget(t)}
                        className="tap-target rounded p-1 hover:bg-[var(--color-bg-hover)]" aria-label="Удалить"
                      ><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft && (
        <TemplateForm
          value={draft}
          metrics={data.metrics}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSave={() => save.mutate(draft)}
          saving={save.isPending}
          error={save.isError ? (save.error instanceof Error ? save.error.message : 'Ошибка сохранения') : null}
        />
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="Удалить шаблон?"
        description={deleteTarget
          ? `Удалить шаблон «${deleteTarget.name}»?\n\nНовые квесты по нему выдаваться перестанут. Уже выданные останутся у людей и дойдут до конца своего периода — их прогресс считается по самому квесту, а не по шаблону.`
          : ''}
        confirmLabel="Удалить"
        tone="danger"
        pending={remove.isPending}
        onConfirm={() => { if (deleteTarget) { remove.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}

function TemplateForm({ value, metrics, onChange, onCancel, onSave, saving, error }: {
  value: Template; metrics: MetricOpt[];
  onChange: (t: Template) => void; onCancel: () => void; onSave: () => void;
  saving: boolean; error: string | null;
}) {
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const set = <K extends keyof Template>(k: K, v: Template[K]) => onChange({ ...value, [k]: v });

  const runPreview = useMutation({
    mutationFn: async () => {
      setPreviewError(null);
      const res = await fetch('/api/settings/badges/quest-templates/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      return j as { rows: PreviewRow[] };
    },
    onSuccess: (j) => setPreview(j.rows),
    onError: (e) => setPreviewError(e instanceof Error ? e.message : 'Ошибка предпросмотра'),
  });

  // Метрики каталога сгруппированы так же, как в отчётах, — иначе в плоском
  // списке из полутора сотен показателей ничего не найти.
  const byCategory = new Map<string, MetricOpt[]>();
  for (const m of metrics) {
    const k = m.category ?? 'Прочее';
    (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(m);
  }

  return (
    <div className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold">{value.id > 0 ? 'Изменить шаблон' : 'Новый шаблон'}</h3>
        <button type="button" onClick={onCancel} className="tap-target rounded p-1 hover:bg-[var(--color-bg-hover)]" aria-label="Закрыть">
          <X size={16} />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Название (видно только в админке)">
          <input className={fieldCls} value={value.name} onChange={e => set('name', e.target.value)} placeholder="Брони недели" />
        </Field>

        <Field label="На чём строим квест">
          <select
            className={fieldCls} value={value.kind}
            onChange={e => {
              const kind = e.target.value as Kind;
              onChange({
                ...value, kind,
                category: kind === 'category' ? (value.category ?? 'bookings_count') : null,
                metricId: kind === 'metric' ? (value.metricId ?? metrics[0]?.id ?? null) : null,
              });
            }}
          >
            <option value="category">Встроенная категория квестов</option>
            <option value="metric">Метрика каталога</option>
          </select>
        </Field>

        {value.kind === 'category' ? (
          <Field label="Категория">
            <select className={fieldCls} value={value.category ?? ''} onChange={e => set('category', e.target.value)}>
              {Object.entries(CATEGORY_LABELS).map(([k, l]) => (
                <option key={k} value={k} disabled={CATEGORY_DISABLED.has(k)}>{l}</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Метрика" hint="Только показатели по сделкам — их умеет считать общий вычислитель.">
            <select className={fieldCls} value={value.metricId ?? ''} onChange={e => set('metricId', e.target.value)}>
              {[...byCategory.entries()].map(([cat, list]) => (
                <optgroup key={cat} label={cat}>
                  {list.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
        )}

        <Field label="Период">
          <select className={fieldCls} value={value.periodType} onChange={e => set('periodType', e.target.value as Period)}>
            {(Object.keys(PERIOD_LABELS) as Period[]).map(p => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
          </select>
        </Field>

        <Field
          label="Как считать цель"
          hint={value.periodType === 'day' && value.kind === 'category' && value.category !== 'sales_count'
            ? 'У дневного периода личный ряд есть только по продажам — для остальных категорий цель встанет на пол.'
            : undefined}
        >
          <select className={fieldCls} value={value.targetMode} onChange={e => set('targetMode', e.target.value as TargetMode)}>
            {(Object.keys(MODE_LABELS) as TargetMode[]).map(m => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
          </select>
        </Field>

        {value.targetMode === 'fixed' && (
          <Field label="Фиксированная цель">
            <input
              className={`${fieldCls} text-right tabular-nums`} inputMode="decimal"
              value={value.targetFixed ?? ''} onChange={e => set('targetFixed', numOrNull(e.target.value))}
            />
          </Field>
        )}

        <Field label="Пол цели" hint="Пусто = медиана компании за период.">
          <input
            className={`${fieldCls} text-right tabular-nums`} inputMode="decimal"
            value={value.targetFloor ?? ''} onChange={e => set('targetFloor', numOrNull(e.target.value))}
          />
        </Field>
        <Field label="Потолок цели" hint="Пусто = личный p90 менеджера.">
          <input
            className={`${fieldCls} text-right tabular-nums`} inputMode="decimal"
            value={value.targetCeiling ?? ''} onChange={e => set('targetCeiling', numOrNull(e.target.value))}
          />
        </Field>

        <Field label="Награда, MLT" hint="Пусто = по тиру, как у встроенных квестов.">
          <input
            className={`${fieldCls} text-right tabular-nums`} inputMode="numeric"
            value={value.rewardEballs ?? ''} onChange={e => set('rewardEballs', numOrNull(e.target.value))}
          />
        </Field>
        <Field label="Вес в выдаче" hint="Встроенные: 0,25–1,3.">
          <input
            className={`${fieldCls} text-right tabular-nums`} inputMode="decimal"
            value={value.weight} onChange={e => set('weight', numOrNull(e.target.value) ?? 0)}
          />
        </Field>

        <Field label="Мин. XP-уровень" hint="0 = всем.">
          <input
            className={`${fieldCls} text-right tabular-nums`} inputMode="numeric"
            value={value.audience.minLevel ?? ''}
            onChange={e => set('audience', { ...value.audience, minLevel: numOrNull(e.target.value) ?? undefined })}
          />
        </Field>
        <Field label="Только этим менеджерам" hint="Bitrix ID через запятую. Пусто = всем.">
          <input
            className={fieldCls} value={(value.audience.managerIds ?? []).join(', ')}
            onChange={e => set('audience', {
              ...value.audience,
              managerIds: e.target.value.split(',').map(s => Number(s.trim())).filter(Number.isFinite),
            })}
          />
        </Field>
        <Field label="Только этим отделам" hint="ID отделов через запятую. Пусто = всем.">
          <input
            className={fieldCls} value={(value.audience.deptIds ?? []).join(', ')}
            onChange={e => set('audience', {
              ...value.audience,
              deptIds: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
            })}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="Формулировка (необязательно)"
          hint={'Подстановки: {target} — цель, {metric} — имя показателя, {when} — «до воскресенья» / «за месяц» / «сегодня». '
            + 'Со склонением: {target:бронь|брони|броней} — формы для 1 / 2–4 / 5+, иначе выйдет «3 броней». '
            + 'Пусто = движок сформулирует сам.'}
        >
          <input
            className={fieldCls} value={value.titleTemplate ?? ''}
            onChange={e => set('titleTemplate', e.target.value || null)}
            placeholder="Забронируй {target:сделку|сделки|сделок} {when}"
          />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-xs text-[var(--color-text)]">
        <input type="checkbox" className="tap-target h-4 w-4" checked={value.enabled} onChange={e => set('enabled', e.target.checked)} />
        Шаблон включён (участвует в выдаче)
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button" onClick={() => runPreview.mutate()} disabled={runPreview.isPending}
          className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-sm hover:bg-[var(--color-bg-hover)] disabled:opacity-50 sm:min-h-9"
        >
          {runPreview.isPending ? 'Считаю…' : 'Предпросмотр'}
        </button>
        <button
          type="button" onClick={onSave} disabled={saving}
          className="min-h-11 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-white disabled:opacity-50 sm:min-h-9"
        >
          {saving ? 'Сохраняю…' : 'Сохранить'}
        </button>
        <button
          type="button" onClick={onCancel}
          className="min-h-11 rounded-lg px-3 text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] sm:min-h-9"
        >
          Отмена
        </button>
      </div>

      {error && <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
      {previewError && <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">{previewError}</div>}

      {preview && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
            Что выдастся (сильный / средний / слабый по продажам за 90 дней)
          </div>
          <div className="scroll-x">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-left text-[var(--color-text-muted)]">
                  <th className="py-1 pr-2 font-medium">Менеджер</th>
                  <th className="py-1 pr-2 font-medium">Формулировка</th>
                  <th className="py-1 pr-2 text-right font-medium">Цель</th>
                  <th className="py-1 pr-2 font-medium">Тир</th>
                  <th className="py-1 text-right font-medium">Награда</th>
                </tr>
              </thead>
              <tbody>
                {preview.map(r => (
                  <tr key={r.mgr} className="border-t border-[var(--color-border)]">
                    <td className="py-1 pr-2 tabular-nums">{r.mgr}</td>
                    <td className="py-1 pr-2">{r.ok ? r.title : <span className="opacity-60">{r.note}</span>}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{r.ok ? r.target : '—'}</td>
                    <td className="py-1 pr-2">
                      {r.ok && <span style={{ color: TIER_COLORS[r.tier] }}>{TIER_LABELS[r.tier]}</span>}
                    </td>
                    <td className="py-1 text-right tabular-nums">{r.ok ? `${r.reward} MLT` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
