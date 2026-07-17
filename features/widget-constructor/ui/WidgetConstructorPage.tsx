'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  type WidgetConfig, type WidgetFamily, type WidgetScopeKind, type WidgetTheme,
  WIDGET_FAMILIES, defaultWidgetConfig,
} from '@/lib/widget/config';
import type { WidgetMetricId } from '@/lib/widget/metrics';
import { GsSwatch, GsPalettePopover } from '@/components/ui/GsColorPicker';

interface MetricDef { id: WidgetMetricId; label: string; shortLabel: string; kind: 'completion' | 'money' | 'percent'; yearOnly: boolean }
interface ScopeOpt { id: string; name: string; branch?: string }
interface Catalog {
  metrics: MetricDef[];
  periods: { key: string; label: string }[];
  scopes: { updated_at: string | null; branches: ScopeOpt[]; departments: ScopeOpt[] };
}
interface SliceItem { id: string; value: number | null; kind: string; fact?: number; plan?: number | null }
interface Slice { updated_at: string; scope_name: string; values: SliceItem[] }

const FAMILY_LABELS: Record<WidgetFamily, string> = { small: 'Small', medium: 'Medium', large: 'Large' };
// Кураторский ряд акцентов (палитра GS) + «…» открывает полную сетку 10×8.
const ACCENT_PRESETS = ['#ffffff', '#4dabf7', '#40c057', '#fab005', '#fd7e14', '#fa5252', '#e64980', '#9775fa', '#22b8cf'];

function fmtMoney(n: number | null): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  const f = (x: number, s: string) => x.toFixed(1).replace('.', ',').replace(',0', '') + s;
  if (a >= 1e9) return f(n / 1e9, ' млрд');
  if (a >= 1e6) return f(n / 1e6, ' млн');
  if (a >= 1e3) return Math.round(n / 1e3) + ' тыс';
  return String(Math.round(n));
}
function fmtMoneyShort(n: number | null): string {
  if (n == null) return '—';
  const a = Math.abs(n);
  const f = (x: number) => x.toFixed(1).replace('.', ',').replace(',0', '');
  if (a >= 1e9) return f(n / 1e9);
  if (a >= 1e6) return f(n / 1e6);
  return String(Math.round(n / 1e3));
}
const fmtPct = (n: number | null) => (n == null ? '—' : Math.round(n) + '%');

// SVG-кольцо, зеркалящее рендер Scriptable-скрипта: адаптивный кегль (текст всегда
// влезает), закруглённые концы дуги, мелкая подпись факт/план внутри.
function PreviewRing({ label, fill, center, sub, accent, theme }: {
  label: string; fill: number | null; center: string; sub: string | null; accent: string; theme: WidgetTheme;
}) {
  const size = 104, sw = Math.round(size * 0.085), r = (size - sw) / 2, c = 2 * Math.PI * r;
  const frac = fill == null ? 0 : Math.max(0.02, Math.min(1, fill / 100));
  const innerW = (size - sw * 4) * 0.92;
  const mainSize = Math.max(10, Math.min(size * 0.24, innerW / (Math.max(1, center.length) * 0.56)));
  const track = theme === 'dark' ? '#ffffff20' : '#00000012';
  const text = theme === 'dark' ? '#ffffff' : '#1a1b26';
  const muted = theme === 'dark' ? '#9aa0ad' : '#6b7280';
  const hasSub = !!sub;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={sw} />
        {fill != null && (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={accent} strokeWidth={sw} strokeLinecap="round"
            strokeDasharray={`${c * frac} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        )}
        <text x="50%" y={hasSub ? '48%' : '50%'} dominantBaseline="central" textAnchor="middle"
          fill={text} fontSize={mainSize} fontWeight="700">{center}</text>
        {hasSub && (
          <text x="50%" y="66%" dominantBaseline="central" textAnchor="middle" fill={muted} fontSize="9" fontWeight="500">{sub}</text>
        )}
      </svg>
      <span className="text-[10px] font-medium" style={{ color: muted }}>{label}</span>
    </div>
  );
}

export function WidgetConstructorPage() {
  const [family, setFamily] = useState<WidgetFamily>('medium');
  const [configs, setConfigs] = useState<Record<WidgetFamily, WidgetConfig>>({
    small: defaultWidgetConfig('small'),
    medium: defaultWidgetConfig('medium'),
    large: defaultWidgetConfig('large'),
  });
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [sendMsg, setSendMsg] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const cfg = configs[family];
  const setCfg = (patch: Partial<WidgetConfig>) =>
    setConfigs(prev => ({ ...prev, [family]: { ...prev[family], ...patch } }));

  const { data: catalog } = useQuery<Catalog>({
    queryKey: ['widget-catalog'],
    queryFn: () => fetch('/api/widget-constructor/catalog').then(r => r.json()),
    staleTime: 60_000,
  });

  const { data: saved } = useQuery<{ configs: WidgetConfig[] }>({
    queryKey: ['widget-configs'],
    queryFn: () => fetch('/api/widget-constructor/config').then(r => r.json()),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!saved?.configs) return;
    setConfigs(prev => {
      const next = { ...prev };
      for (const c of saved.configs) if (c.param === '' && WIDGET_FAMILIES.includes(c.family)) next[c.family] = c;
      return next;
    });
  }, [saved]);

  const cfgKey = JSON.stringify(cfg);
  const { data: slice, error: sliceErr } = useQuery<Slice>({
    queryKey: ['widget-preview', cfgKey],
    queryFn: async () => {
      const res = await fetch('/api/widget-constructor/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cfgKey,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'preview error');
      return res.json();
    },
    retry: false,
  });

  const metrics = catalog?.metrics ?? [];
  const isYear = cfg.period_preset === 'this_year';
  const itemsById = useMemo(() => new Map((slice?.values ?? []).map(it => [it.id, it])), [slice]);

  function ringOf(id: WidgetMetricId): { fill: number | null; center: string; sub: string | null } {
    const it = itemsById.get(id);
    if (!it) return { fill: null, center: '—', sub: null };
    if (it.kind === 'completion') {
      return {
        fill: it.value,
        center: fmtPct(it.value),
        sub: it.plan != null ? `${fmtMoneyShort(it.fact ?? null)} / ${fmtMoney(it.plan)}` : null,
      };
    }
    if (it.kind === 'money') {
      const fill = it.plan != null && it.plan > 0 ? ((it.fact ?? 0) / it.plan) * 100 : null;
      return { fill, center: fmtMoney(it.value), sub: it.plan != null ? `план ${fmtMoney(it.plan)}` : null };
    }
    return { fill: it.value, center: it.value == null ? '—' : (Math.round(it.value * 10) / 10 + '%').replace('.', ','), sub: null };
  }

  const maxRings = family === 'small' ? 1 : family === 'medium' ? 2 : 4;
  const shownMetrics = cfg.metrics.slice(0, maxRings);

  const toggleMetric = (id: WidgetMetricId) => {
    const has = cfg.metrics.includes(id);
    const next = has ? cfg.metrics.filter(m => m !== id) : [...cfg.metrics, id];
    if (next.length === 0) return;
    setCfg({ metrics: next });
  };

  const setPeriod = (preset: WidgetConfig['period_preset']) => {
    // При уходе с «года» абсолютные ₽-метрики недоступны — снимаем их сами.
    const metricsNext = preset === 'this_year'
      ? cfg.metrics
      : cfg.metrics.filter(m => !metrics.find(d => d.id === m)?.yearOnly);
    setCfg({ period_preset: preset, metrics: metricsNext.length ? metricsNext : ['sales_completion'] });
  };

  async function save() {
    setSaving(true); setSavedMsg(null);
    try {
      const res = await fetch('/api/widget-constructor/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
      });
      const j = await res.json();
      setSavedMsg(res.ok ? 'Сохранено' : (j.error || 'Ошибка'));
    } finally { setSaving(false); }
  }

  async function sendToPhone() {
    setSendMsg('Отправляю…');
    const res = await fetch('/api/widget-constructor/send-script', { method: 'POST' });
    const j = await res.json().catch(() => ({}));
    setSendMsg(res.ok ? 'Отправлено в Битрикс — откройте чат с ботом «Аналитик»' : (j.message || j.error || 'Ошибка'));
  }

  const previewBg = cfg.colors.theme === 'dark'
    ? 'linear-gradient(165deg,#1b1d26,#13141b)'
    : 'linear-gradient(165deg,#ffffff,#eef0f5)';
  const previewMuted = cfg.colors.theme === 'dark' ? '#9aa0ad' : '#6b7280';

  return (
    <div className="flex flex-col h-dvh overflow-auto bg-[var(--color-bg)]">
      <div className="px-4 py-3 bg-[var(--color-bg-surface)] border-b border-[var(--color-border)] sticky top-0 z-10">
        <h1 className="text-sm font-semibold text-[var(--color-text)]">Конструктор виджетов</h1>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Соберите виджет для iPhone и отправьте себе одним сообщением</p>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-5 max-w-md mx-auto w-full">
        {/* Превью */}
        <div className="rounded-2xl p-5 shadow-sm" style={{ background: previewBg }}>
          <div className="text-[11px] font-medium mb-3" style={{ color: previewMuted }}>{slice?.scope_name ?? '—'}</div>
          {sliceErr ? (
            <p className="text-xs" style={{ color: '#fa5252' }}>
              {(sliceErr as Error).message === 'preview error' ? 'Данные ещё не рассчитаны — превью появится после первого прогона джобы.' : (sliceErr as Error).message}
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-4 justify-center">
              {shownMetrics.map(id => {
                const v = ringOf(id);
                const def = metrics.find(m => m.id === id);
                return (
                  <PreviewRing key={id} label={def?.shortLabel ?? id} fill={v.fill} center={v.center} sub={v.sub}
                    accent={cfg.colors.accent} theme={cfg.colors.theme} />
                );
              })}
            </div>
          )}
          {slice && (
            <div className="text-[10px] mt-3 text-center" style={{ color: previewMuted }}>
              обновлено {slice.updated_at?.slice(11, 16)}
            </div>
          )}
        </div>

        {/* Размер */}
        <Field label="Размер виджета">
          <div className="flex gap-2">
            {WIDGET_FAMILIES.map(f => (
              <button key={f} onClick={() => setFamily(f)}
                className={`flex-1 py-2 rounded-lg text-sm border ${family === f ? 'bg-[var(--color-accent)] text-white border-transparent' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
                {FAMILY_LABELS[f]}
              </button>
            ))}
          </div>
        </Field>

        {/* Период */}
        <Field label="Период">
          <select value={cfg.period_preset} onChange={e => setPeriod(e.target.value as WidgetConfig['period_preset'])}
            className="w-full py-2 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-base sm:text-sm text-[var(--color-text)]">
            {catalog?.periods.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </Field>

        {/* Показатели */}
        <Field label={`Показатели (до ${maxRings} на этом размере)`}>
          <div className="grid grid-cols-1 gap-1.5">
            {metrics.map(m => {
              const disabled = m.yearOnly && !isYear;
              return (
                <label key={m.id} className={`flex items-center gap-2 text-sm ${disabled ? 'opacity-40' : ''} text-[var(--color-text)]`}>
                  <input type="checkbox" disabled={disabled} checked={cfg.metrics.includes(m.id)} onChange={() => toggleMetric(m.id)} />
                  {m.label}
                  {m.yearOnly && <span className="text-[10px] text-[var(--color-text-muted)]">только «Этот год»</span>}
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
            «Вып. плана» — одно кольцо: заполнение дуги = % выполнения к текущему дню, факт/план подписью внутри.
          </p>
        </Field>

        {/* Разрез */}
        <Field label="Разрез">
          <div className="flex gap-2 mb-2">
            {(['russia', 'branch', 'department'] as WidgetScopeKind[]).map(sk => (
              <button key={sk} onClick={() => setCfg({ scope_kind: sk, scope_id: sk === 'russia' ? null : (sk === 'branch' ? catalog?.scopes.branches[0]?.id ?? null : catalog?.scopes.departments[0]?.id ?? null) })}
                className={`flex-1 py-2 rounded-lg text-sm border ${cfg.scope_kind === sk ? 'bg-[var(--color-accent)] text-white border-transparent' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
                {sk === 'russia' ? 'Россия' : sk === 'branch' ? 'Филиал' : 'Отдел'}
              </button>
            ))}
          </div>
          {cfg.scope_kind !== 'russia' && (
            <select value={cfg.scope_id ?? ''} onChange={e => setCfg({ scope_id: e.target.value })}
              className="w-full py-2 px-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] text-base sm:text-sm text-[var(--color-text)]">
              {(cfg.scope_kind === 'branch' ? catalog?.scopes.branches : catalog?.scopes.departments)?.map(o => (
                <option key={o.id} value={o.id}>{o.name}{o.branch ? ` (${o.branch})` : ''}</option>
              ))}
            </select>
          )}
        </Field>

        {/* Цвета */}
        <Field label="Оформление">
          <div className="flex gap-2 mb-3">
            {(['dark', 'light'] as WidgetTheme[]).map(t => (
              <button key={t} onClick={() => setCfg({ colors: { ...cfg.colors, theme: t } })}
                className={`flex-1 py-2 rounded-lg text-sm border ${cfg.colors.theme === t ? 'bg-[var(--color-accent)] text-white border-transparent' : 'border-[var(--color-border)] text-[var(--color-text)]'}`}>
                {t === 'dark' ? 'Тёмная' : 'Светлая'}
              </button>
            ))}
          </div>
          <div className="relative flex items-center gap-1.5 flex-wrap">
            {ACCENT_PRESETS.map(c => (
              <GsSwatch key={c} color={c} selected={cfg.colors.accent === c}
                onClick={() => setCfg({ colors: { ...cfg.colors, accent: c } })} />
            ))}
            <button type="button" onClick={() => setPaletteOpen(v => !v)}
              className="tap-target h-[22px] px-1.5 rounded-md border border-[var(--color-border)] text-[11px] text-[var(--color-text-muted)]">
              ещё…
            </button>
            {paletteOpen && (
              <div className="absolute z-20 top-7 left-0 max-w-[94vw]">
                <GsPalettePopover
                  value={cfg.colors.accent}
                  onChange={c => { setCfg({ colors: { ...cfg.colors, accent: c } }); setPaletteOpen(false); }}
                  onClose={() => setPaletteOpen(false)}
                />
              </div>
            )}
          </div>
        </Field>

        {/* Действия */}
        <div className="flex flex-col gap-2 pt-1">
          <button onClick={save} disabled={saving}
            className="w-full py-2.5 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium disabled:opacity-50">
            {saving ? 'Сохранение…' : `Сохранить (${FAMILY_LABELS[family]})`}
          </button>
          {savedMsg && <p className="text-xs text-center text-[var(--color-text-muted)]">{savedMsg}</p>}
          <button onClick={sendToPhone}
            className="w-full py-2.5 rounded-lg border border-[var(--color-accent)] text-[var(--color-accent)] text-sm font-medium">
            Отправить себе в Битрикс
          </button>
          {sendMsg && <p className="text-xs text-center text-[var(--color-text-muted)]">{sendMsg}</p>}
          <p className="text-[11px] text-[var(--color-text-muted)] text-center mt-1">
            Бот «Аналитик» пришлёт готовый скрипт. Скопируйте его в приложение Scriptable и добавьте виджет на экран.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[var(--color-text-muted)] mb-1.5">{label}</div>
      {children}
    </div>
  );
}
