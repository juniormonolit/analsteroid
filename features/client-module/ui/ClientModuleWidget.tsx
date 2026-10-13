'use client';
// Модуль «Карточка клиента» (ТЗ владельца 13.10) — сам виджет. Сейчас рисуется
// в превью «Ещё → Модули», дальше этот же компонент встанет в карточку
// контакта/компании Битрикса. Поэтому он самодостаточен: на вход только ID,
// никакой зависимости от AppShell, ширина — «как вкладка Битрикса» и уже.
//
// Структура по ТЗ: сверху переключатель «Весь клиент / Объект N» — все цифры
// (а–ж) и список сделок пересчитываются по выбранному срезу одной функцией
// computeStats (engine/types.ts). Ручные поля: тип клиента — на клиенте,
// стадия стройки / тип дома — на объекте (решение владельца 13.10).

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, HelpCircle, MapPin, Building2, User } from 'lucide-react';
import {
  type ClientModuleData, type ModuleDeal, type ClientType, type BuildStage, type HouseType,
  CLIENT_TYPES, BUILD_STAGES, HOUSE_TYPES, TYPES_WITH_OCCUPATION, EMPTY_OBJECT_PROFILE,
  computeStats, dealStatus,
} from '../engine/types';
import { fmtMoney, fmtDate, dealBitrixUrl } from '@/features/customers/ui/shared';

const DAY_MS = 86_400_000;

type Tone = 'muted' | 'neg' | 'warn' | 'ok';
const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  muted: { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' },
  neg: { color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' },
  warn: { color: 'var(--color-warning, #e8590c)', backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 10%, transparent)' },
  ok: { color: 'var(--color-positive, #2f9e44)', backgroundColor: 'color-mix(in srgb, var(--color-positive, #2f9e44) 10%, transparent)' },
};

function Chip({ children, tone = 'muted' }: { children: React.ReactNode; tone?: Tone }) {
  return <span className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-semibold" style={TONE_STYLE[tone]}>{children}</span>;
}

function Section({ title, right, children }: { title: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3">
      <div className="mb-2 flex items-center gap-2">
        <div className="min-w-0 flex-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2">
      <div className="text-[11px] leading-tight text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-0.5 truncate text-[16px] font-bold leading-tight tabular-nums text-[var(--color-text)]">{value}</div>
      {sub && <div className="mt-0.5 truncate text-[11px] leading-tight text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

/** Вариант выбора с пояснением под «?» (ТЗ: «напротив каждого типа — пояснение
 *  по наведению на знак вопроса»). Hover на таче не работает (правило 5
 *  CLAUDE.md), поэтому «?» — кнопка: наведение показывает title, тап/клик
 *  раскрывает пояснение строкой под вариантом. */
function OptionRow({ name, label, hint, checked, onSelect }: { name: string; label: string; hint?: string; checked: boolean; onSelect: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${checked ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)]' : 'border-[var(--color-border)]'}`}>
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

const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 text-base sm:text-sm outline-none focus:border-[var(--color-accent)]';

function SaveBar({ dirty, saving, error, savedAt, onSave, disabled }: { dirty: boolean; saving: boolean; error: string | null; savedAt: string | null; onSave: () => void; disabled?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" onClick={onSave} disabled={!dirty || saving || disabled}
        className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-40">
        {saving ? 'Сохраняем…' : 'Сохранить'}
      </button>
      {error ? <span className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error}</span>
        : savedAt ? <span className="text-[12px] text-[var(--color-text-muted)]">{savedAt}</span> : null}
    </div>
  );
}

function useSave(params: Record<string, string>) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (payload: object) => {
    setSaving(true); setError(null);
    try {
      const r = await fetch('/api/modules/client-card/profile', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, ...payload }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось сохранить');
      await qc.invalidateQueries({ queryKey: ['client-module'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally { setSaving(false); }
  };
  return { save, saving, error };
}

const savedLine = (by: string | null, at: string | null) => (at ? `Сохранено ${fmtDate(at)}${by ? ` · ${by}` : ''}` : null);

// ── Ручные поля клиента ─────────────────────────────────────────────────────

function ClientFields({ data, params }: { data: ClientModuleData; params: Record<string, string> }) {
  const [type, setType] = useState<ClientType | null>(data.profile.clientType);
  const [occupation, setOccupation] = useState(data.profile.occupation);
  const [note, setNote] = useState(data.profile.note);
  useEffect(() => { setType(data.profile.clientType); setOccupation(data.profile.occupation); setNote(data.profile.note); }, [data.profile]);
  const { save, saving, error } = useSave(params);
  const dirty = type !== data.profile.clientType || occupation !== data.profile.occupation || note !== data.profile.note;
  return (
    <Section title="Тип клиента">
      <div className="flex flex-col gap-1.5">
        {CLIENT_TYPES.map(t => (
          <OptionRow key={t.value} name={`ct-${data.ref}`} label={t.label} hint={t.hint} checked={type === t.value} onSelect={() => setType(t.value)} />
        ))}
      </div>
      {type && TYPES_WITH_OCCUPATION.has(type) && (
        <label className="mt-2.5 block">
          <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Чем занимается</span>
          <input value={occupation} onChange={e => setOccupation(e.target.value)} maxLength={500} placeholder="Например: кровля и фасады, частные дома" className={inputCls} />
        </label>
      )}
      {type === 'self_builder' && (
        <div className="mt-2 text-[12px] text-[var(--color-text-muted)]">Стадию стройки и тип дома укажите у каждого объекта — переключатель объектов вверху.</div>
      )}
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Заметка</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} className={inputCls} />
      </label>
      <SaveBar dirty={dirty} saving={saving} error={error ?? (data.profilesAvailable ? null : 'Хранилище ручных полей ещё не создано — сохранение пока недоступно')}
        disabled={!data.profilesAvailable} savedAt={savedLine(data.profile.updatedBy, data.profile.updatedAt)}
        onSave={() => save({ client: { clientType: type, occupation: type && TYPES_WITH_OCCUPATION.has(type) ? occupation : '', note } })} />
    </Section>
  );
}

// ── Ручные поля объекта ─────────────────────────────────────────────────────

function ObjectFields({ data, objectKey, params }: { data: ClientModuleData; objectKey: string; params: Record<string, string> }) {
  const prof = data.objectProfiles[objectKey] ?? EMPTY_OBJECT_PROFILE;
  const [stage, setStage] = useState<BuildStage | null>(prof.buildStage);
  const [house, setHouse] = useState<HouseType | null>(prof.houseType);
  const [note, setNote] = useState(prof.note);
  useEffect(() => { setStage(prof.buildStage); setHouse(prof.houseType); setNote(prof.note); }, [prof]);
  const { save, saving, error } = useSave(params);
  const selfBuilder = data.profile.clientType === 'self_builder';
  const dirty = stage !== prof.buildStage || house !== prof.houseType || note !== prof.note;
  return (
    <Section title="Объект: заполняет менеджер">
      {selfBuilder ? (
        <>
          <div className="mb-1 text-[12px] text-[var(--color-text-muted)]">Стадия строительства</div>
          <div className="flex flex-col gap-1.5">
            {BUILD_STAGES.map(s => (
              <OptionRow key={s.value} name={`bs-${objectKey}`} label={s.label} hint={s.hint} checked={stage === s.value} onSelect={() => setStage(s.value)} />
            ))}
          </div>
          <div className="mb-1 mt-2.5 text-[12px] text-[var(--color-text-muted)]">Тип дома</div>
          <div className="grid grid-cols-2 gap-1.5">
            {HOUSE_TYPES.map(h => (
              <button key={h.value} type="button" onClick={() => setHouse(house === h.value ? null : h.value)}
                className={`min-h-11 rounded-lg border px-2 text-sm ${house === h.value ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                {h.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="text-[12px] text-[var(--color-text-muted)]">
          Стадия стройки и тип дома заполняются, когда тип клиента — «Строит себе» (переключитесь на «Весь клиент»).
        </div>
      )}
      <label className="mt-2.5 block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Заметка по объекту</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} className={inputCls} />
      </label>
      <SaveBar dirty={dirty} saving={saving} error={error ?? (data.profilesAvailable ? null : 'Хранилище ручных полей ещё не создано — сохранение пока недоступно')}
        disabled={!data.profilesAvailable} savedAt={savedLine(prof.updatedBy, prof.updatedAt)}
        onSave={() => save({ object: { key: objectKey, buildStage: selfBuilder ? stage : null, houseType: selfBuilder ? house : null, note } })} />
    </Section>
  );
}

// ── Строка сделки (ТЗ п. h: как на скрине + стрелка «все товары») ───────────

function DealRow({ d, gap, showStatus }: { d: ModuleDeal; gap: number | null; showStatus: boolean }) {
  const [open, setOpen] = useState(false);
  const st = dealStatus(d);
  const date = d.deliveredAt ?? d.soldAt ?? d.createdAt;
  const total = d.products.reduce((s, p) => s + p.sum, 0);
  return (
    <div className="py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={open ? 'Скрыть товары' : 'Показать товары'}
          className="tap-target -ml-1 shrink-0 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className="w-[76px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDate(date)}</span>
        <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[var(--color-accent)] hover:underline">#{d.dealId}</a>
        <span className="min-w-0 flex-1 basis-[180px] truncate" title={[...d.groups, d.name ?? ''].filter(Boolean).join(' · ')}>
          {d.groups.length > 0 ? d.groups.join(', ') : (d.name ?? 'без товарных групп')}
        </span>
        {showStatus && <Chip tone={st.tone}>{st.label}</Chip>}
        {gap !== null && <Chip>↓ {gap} дн.</Chip>}
        <span className="ml-auto whitespace-nowrap font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
      </div>
      {open && (
        <div className="mt-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] sm:ml-6">
          {d.products.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">В сделке нет товарных позиций</div>
          ) : d.products.map((p, i) => (
            <div key={i} className={`flex flex-wrap items-baseline gap-x-3 px-3 py-1.5 text-[12px] ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}>
              <span className="min-w-0 flex-1 basis-[200px] break-words">{p.name}</span>
              <span className="text-[var(--color-text-muted)] tabular-nums">{p.quantity.toLocaleString('ru-RU')} × {fmtMoney(p.price)}{p.group ? ` · ${p.group}` : ''}</span>
              <span className="ml-auto font-medium tabular-nums">{fmtMoney(p.sum)}</span>
            </div>
          ))}
          <div className="flex flex-wrap gap-x-3 border-t border-[var(--color-border)] px-3 py-1.5 text-[11.5px] text-[var(--color-text-muted)]">
            {d.name && <span className="min-w-0 break-words">{d.name}</span>}
            {d.managerName && <span>· {d.managerName}</span>}
            {!showStatus && <span>· {st.label}</span>}
            {d.products.length > 0 && <span className="ml-auto">Итого по товарам: <b className="text-[var(--color-text)] tabular-nums">{fmtMoney(total)}</b></span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Виджет ───────────────────────────────────────────────────────────────────

export function ClientModuleWidget({ contactId, companyId }: { contactId?: string; companyId?: string }) {
  const params: Record<string, string> = companyId ? { companyId } : contactId ? { contactId } : {};
  const qs = new URLSearchParams(params).toString();
  const { data, isLoading, error } = useQuery<ClientModuleData>({
    queryKey: ['client-module', qs],
    enabled: qs.length > 0,
    queryFn: async () => {
      const r = await fetch(`/api/modules/client-card?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка загрузки');
      return j;
    },
  });

  const [scope, setScope] = useState<string>('all');
  const [allDeals, setAllDeals] = useState(false);
  useEffect(() => { setScope('all'); setAllDeals(false); }, [qs]);

  const scopedDeals = useMemo(() => {
    if (!data) return [];
    return scope === 'all' ? data.deals : data.deals.filter(d => d.objectKeys.includes(scope));
  }, [data, scope]);
  const stats = useMemo(() => computeStats(scopedDeals), [scopedDeals]);

  // Объекты: сначала с отгрузками, по свежести последней сделки.
  const objectTabs = useMemo(() => {
    if (!data) return [];
    return data.objects.map(o => {
      const ds = data.deals.filter(d => d.objectKeys.includes(o.key));
      const s = computeStats(ds);
      const lastAt = ds.reduce<string>((m, d) => { const t = d.deliveredAt ?? d.soldAt ?? d.createdAt ?? ''; return t > m ? t : m; }, '');
      return { obj: o, deals: ds.length, shipped: s.shipped, lastAt };
    }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }, [data]);

  if (!qs) return null;
  if (isLoading) return <div className="p-4 text-sm text-[var(--color-text-muted)]">Загружаем клиента…</div>;
  if (error || !data) return <div className="p-4 text-sm" style={{ color: 'var(--color-negative, #e03131)' }}>{error instanceof Error ? error.message : 'Ошибка загрузки'}</div>;

  const bitrixUrl = `https://td.monolit-crm.ru/crm/${data.clientType}/details/${data.clientId}/`;
  const title = data.name ?? (data.clientType === 'contact' ? `Контакт #${data.clientId}` : `Компания #${data.clientId}`);
  const curObject = scope === 'all' ? null : data.objects.find(o => o.key === scope) ?? null;
  const noAddress = data.deals.filter(d => d.deliveredAt && d.objectKeys.length === 0).length;

  const listDeals = (allDeals ? scopedDeals : scopedDeals.filter(d => d.deliveredAt));
  const sortedList = [...listDeals].sort((a, b) => (a.deliveredAt ?? a.soldAt ?? a.createdAt ?? '').localeCompare(b.deliveredAt ?? b.soldAt ?? b.createdAt ?? ''));
  const groupMax = stats.groups[0]?.sum ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-2">
        {data.clientType === 'company' ? <Building2 size={18} className="shrink-0 text-[var(--color-text-muted)]" /> : <User size={18} className="shrink-0 text-[var(--color-text-muted)]" />}
        <h2 className="min-w-0 flex-1 break-words text-[16px] font-bold">{title}</h2>
        <a href={bitrixUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline">
          Битрикс <ExternalLink size={12} />
        </a>
      </div>

      {/* Срез: весь клиент / объект (flex-wrap — без горизонтальной ленты, правило 12) */}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setScope('all')}
          className={`min-h-9 rounded-lg border px-3 text-[12.5px] ${scope === 'all' ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
          Весь клиент · {data.deals.length}
        </button>
        {objectTabs.map(({ obj, deals, shipped }, i) => (
          <button key={obj.key} type="button" onClick={() => setScope(obj.key)} title={obj.address}
            className={`inline-flex min-h-9 max-w-full items-center gap-1 rounded-lg border px-3 text-[12.5px] ${scope === obj.key ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
            <MapPin size={12} className="shrink-0" />
            <span className="truncate max-w-[220px]">Объект {i + 1}: {obj.address}</span>
            <span className="shrink-0 text-[var(--color-text-muted)]">· {shipped}/{deals}</span>
          </button>
        ))}
      </div>
      {!data.addressesAvailable && (
        <div className="text-[12px] text-[var(--color-text-muted)]">Адреса заявок 1С сейчас недоступны — объекты не показаны.</div>
      )}

      {curObject && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px]">
          <div className="flex items-start gap-1.5"><MapPin size={14} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" /><span className="min-w-0 break-words">{curObject.address}</span></div>
          {curObject.requests.length > 0 && (
            <div className="mt-1 text-[11.5px] text-[var(--color-text-muted)]">
              Заявки 1С: {curObject.requests.map((r, i) => <Fragment key={`${r.number}-${i}`}>{i > 0 && ', '}<span className="tabular-nums">№{r.number.replace(/^0+/, '')}{r.date ? ` от ${fmtDate(r.date)}` : ''}</span></Fragment>)}
            </div>
          )}
        </div>
      )}

      {/* а–ж: автоматические поля */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Отгружено / всего сделок" value={<>{stats.shipped} / {stats.total}</>} sub={stats.total - stats.shipped > 0 ? `${stats.total - stats.shipped} в других статусах` : 'все отгружены'} />
        <Stat label="LTV (сумма отгрузок)" value={fmtMoney(stats.ltv)} />
        <Stat label="Средний чек отгрузки" value={stats.avgCheck !== null ? fmtMoney(stats.avgCheck) : '—'} />
        <Stat label="Цикл повторки" value={stats.cycleDays !== null ? `${stats.cycleDays} дн.` : '—'} sub={stats.cycleDays !== null ? 'среднее между отгрузками' : 'нужно 2+ отгрузки'} />
        <Stat label="Последняя отгрузка" value={fmtDate(stats.lastShippedAt)} sub={stats.daysSinceLast !== null ? `${stats.daysSinceLast} дн. назад` : undefined} />
        {scope === 'all'
          ? <Stat label="Объектов" value={data.addressesAvailable ? stats.objects : '—'} sub={noAddress > 0 ? `${noAddress} отгр. без адреса в 1С` : 'уникальные адреса отгрузок'} />
          : <Stat label="Заявок 1С по объекту" value={curObject?.requests.length ?? 0} />}
      </div>

      {/* Ручные поля */}
      {scope === 'all'
        ? <ClientFields data={data} params={params} />
        : <ObjectFields key={scope} data={data} objectKey={scope} params={params} />}

      {/* е: товарные группы по всем отгрузкам */}
      <Section title={`Товарные группы по отгрузкам · ${stats.groups.length}`}>
        {stats.groups.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Отгрузок с товарами нет</div> : (
          <div className="flex flex-col gap-1.5">
            {stats.groups.map(g => (
              <div key={g.group} className="text-[12.5px]">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate" title={g.group}>{g.group}</span>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{g.deals} отгр.</span>
                  <span className="shrink-0 font-semibold tabular-nums">{fmtMoney(g.sum)}</span>
                </div>
                <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-hover)]">
                  <div className="h-full rounded-full bg-[var(--color-accent)]" style={{ width: `${groupMax > 0 ? Math.max(2, (g.sum / groupMax) * 100) : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* h: список сделок */}
      <Section
        title={allDeals ? `Сделки · ${sortedList.length}` : `Покупки (отгрузки) · ${sortedList.length}`}
        right={
          <div className="flex shrink-0 rounded-lg border border-[var(--color-border)] p-0.5 text-[11.5px]">
            {[{ v: false, l: 'Отгрузки' }, { v: true, l: 'Все сделки' }].map(o => (
              <button key={String(o.v)} type="button" onClick={() => setAllDeals(o.v)}
                className={`min-h-8 rounded-md px-2 ${allDeals === o.v ? 'bg-[var(--color-bg-hover)] font-semibold' : 'text-[var(--color-text-muted)]'}`}>{o.l}</button>
            ))}
          </div>
        }
      >
        {sortedList.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">{allDeals ? 'Сделок нет' : 'Отгрузок нет'}</div> : (
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {sortedList.map((d, i) => {
              const prev = i > 0 ? sortedList[i - 1] : null;
              const gap = !allDeals && prev ? Math.round((new Date(d.deliveredAt!).getTime() - new Date(prev.deliveredAt!).getTime()) / DAY_MS) : null;
              return <DealRow key={d.dealId} d={d} gap={gap} showStatus={allDeals} />;
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
