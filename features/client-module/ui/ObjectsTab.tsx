'use client';
// Таб «Объекты» карточки клиента (правка владельца 13.10): объекты ведутся в
// Монолитике. Крупные карточки — адрес (проставлен автоматически из заявки 1С
// или адреса сделки, с плашкой «Проверь адрес»), статус «Новый / В работе /
// Завершён», что брали, лестница стадий (текущая группа в центре, выше — что
// предложить, ниже — что скорее всего уже купил), раскрытие в цепочку сделок.

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, MapPin, Plus, ArrowUp, CircleDot, Check } from 'lucide-react';
import { fmtMoney, fmtDate, dealBitrixUrl } from '@/features/customers/ui/shared';
import { AddressPicker, type GeoValue, type GeoHint } from '@/features/geo/ui/AddressPicker';
import {
  type ClientModuleData, type ModuleObject, type StageLadder, type BuildStage, type HouseType,
  BUILD_STAGES, HOUSE_TYPES, EMPTY_OBJECT_PROFILE, NEW_OBJECT_KEY, ADDRESS_SOURCE_LABEL,
  computeStats, objectStatus,
} from '../engine/types';
import { Section, Chip, StatusChip, StageChip, OptionRow, SaveBar, useSave, savedLine, inputCls, shortGroup } from './parts';

const DAY_MS = 86_400_000;

// ── Лестница стадий ──────────────────────────────────────────────────────────

function Ladder({ ladder }: { ladder: StageLadder | undefined }) {
  if (!ladder?.current) {
    return <div className="text-[12.5px] text-[var(--color-text-muted)]">На этот объект ещё ничего не отгружали — лестница появится после первой отгрузки.</div>;
  }
  const rail = 'relative pl-6 before:absolute before:left-[9px] before:top-0 before:bottom-0 before:w-px before:bg-[var(--color-border)]';
  return (
    <div className="flex flex-col">
      {/* Выше — что предложить (самое вероятное — ближе к текущему этапу). */}
      {[...ladder.next].reverse().map(r => (
        <div key={r.group} className={`${rail} pb-2`}>
          <ArrowUp size={14} className="absolute left-[3px] top-1 rounded-full bg-[var(--color-bg-surface)] text-[var(--color-warning,#e8590c)]" />
          <div className="rounded-lg border border-dashed border-[color-mix(in_srgb,var(--color-warning,#e8590c)_50%,transparent)] px-2.5 py-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warning,#e8590c)]">Предложить</span>
              <span className="min-w-0 flex-1 text-[13px] font-semibold">{r.group}</span>
              {r.pct !== null && <Chip title={`После «${r.pctAfter}» следующей покупкой берут «${r.group}» в ${r.pct}% случаев (по всей базе)`}>{r.pct}%</Chip>}
              {r.sources.includes('priority') && <Chip tone="accent">приоритет</Chip>}
            </div>
            {r.ask && <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-text-muted)]">Спросите: <span className="text-[var(--color-text)]">«{r.ask.replace(/^[-–—\s]+/, '')}»</span></div>}
          </div>
        </div>
      ))}
      {ladder.next.length === 0 && (
        <div className={`${rail} pb-2 text-[12px] text-[var(--color-text-muted)]`}>Что предложить следующим — подсказок нет.</div>
      )}

      {/* Центр — текущая группа. */}
      <div className={`${rail} pb-2`}>
        <CircleDot size={16} className="absolute left-[2px] top-2 rounded-full bg-[var(--color-bg-surface)] text-[var(--color-accent)]" />
        <div className="rounded-lg border-2 border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] px-2.5 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">Сейчас</div>
          <div className="text-[14px] font-bold">{ladder.current.group}</div>
          <div className="text-[11.5px] text-[var(--color-text-muted)]">
            последняя отгрузка {fmtDate(ladder.current.date)} · <a href={dealBitrixUrl(ladder.current.dealId)} target="_blank" rel="noreferrer" className="font-mono text-[var(--color-accent)] hover:underline">#{ladder.current.dealId}</a>
          </div>
        </div>
      </div>

      {/* Ниже — что, скорее всего, уже купил. */}
      {ladder.before.map(s => (
        <div key={s.group} className={`${rail} pb-1.5`}>
          <span className={`absolute left-[5px] top-2.5 h-2 w-2 rounded-full ${s.deal ? 'bg-[var(--color-positive,#2f9e44)]' : 'bg-[var(--color-text-muted)]'}`} />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 py-1 text-[12.5px]">
            <span className={`min-w-0 flex-1 basis-[150px] ${s.deal ? '' : 'text-[var(--color-text-muted)]'}`}>{s.group}</span>
            {s.deal ? (
              <span className="inline-flex items-center gap-1 text-[11.5px] text-[var(--color-positive,#2f9e44)]">
                <Check size={12} /> у нас: <a href={dealBitrixUrl(s.deal.dealId)} target="_blank" rel="noreferrer" className="font-mono hover:underline">#{s.deal.dealId}</a> {fmtDate(s.deal.date)}{s.deal.amount > 0 ? ` · ${fmtMoney(s.deal.amount)}` : ''}
              </span>
            ) : (
              <Chip tone="warn" title="По цепочке стройки этот этап идёт раньше текущего, но у нас отгрузки не было — вероятно, брал в другом месте">скорее всего купил не у нас</Chip>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Редактирование объекта ───────────────────────────────────────────────────

function ObjectEditor({ data, object, params, onCreated, onCancel }: {
  data: ClientModuleData; object: ModuleObject | null; params: Record<string, string>; onCreated?: (key: string) => void; onCancel?: () => void;
}) {
  const key = object?.key ?? NEW_OBJECT_KEY;
  const prof = data.objectProfiles[key] ?? EMPTY_OBJECT_PROFILE;
  const [geo, setGeo] = useState<GeoValue | null>(null);
  const [stage, setStage] = useState<BuildStage | null>(prof.buildStage);
  const [house, setHouse] = useState<HouseType | null>(prof.houseType);
  const [note, setNote] = useState(prof.note);
  useEffect(() => { setStage(prof.buildStage); setHouse(prof.houseType); setNote(prof.note); }, [prof]);
  const { save, saving, error } = useSave(params);
  const selfBuilder = data.profile.clientType === 'self_builder';
  const dirty = !!geo || stage !== prof.buildStage || house !== prof.houseType || note !== prof.note;
  const blocked = !!geo && !geo.confirmed;
  const hints: GeoHint[] = object && object.lat !== null && object.lon !== null
    ? [{ label: object.source === '1c' ? 'Точка из заявки 1С' : 'Точка из адреса сделки', lat: object.lat, lon: object.lon }] : [];

  const onSave = async () => {
    const r = await save({ object: {
      key,
      ...(selfBuilder ? { buildStage: stage, houseType: house } : {}),
      note,
      ...(geo ? { ideal: { address: geo.address, lat: geo.lat, lon: geo.lon } } : {}),
    } });
    if (!r) return;
    if (!object && r.objectKey) onCreated?.(r.objectKey);
    setGeo(null);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <div className="mb-1 text-[12px] text-[var(--color-text-muted)]">{object ? 'Поправить адрес' : 'Адрес нового объекта'}</div>
        <AddressPicker value={geo} onChange={setGeo} hints={hints} seedQuery={object && !object.manual ? object.address : null} />
      </div>
      {selfBuilder ? (
        <>
          <div>
            <div className="mb-1 text-[12px] text-[var(--color-text-muted)]">Стадия строительства</div>
            <div className="flex flex-col gap-1.5">
              {BUILD_STAGES.map(st => (
                <OptionRow key={st.value} name={`bs-${key}`} label={st.label} hint={st.hint} checked={stage === st.value} onSelect={() => setStage(st.value)} />
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[12px] text-[var(--color-text-muted)]">Тип дома</div>
            <div className="grid grid-cols-2 gap-1.5">
              {HOUSE_TYPES.map(h => (
                <button key={h.value} type="button" onClick={() => setHouse(house === h.value ? null : h.value)}
                  className={`min-h-11 rounded-lg border px-2 text-sm ${house === h.value ? 'border-[var(--color-accent)] font-semibold text-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
                  {h.label}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="text-[12px] text-[var(--color-text-muted)]">Стадия стройки и тип дома — когда тип клиента «Строит себе» (вкладка «Обзор»).</div>
      )}
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-muted)]">Заметка по объекту</span>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} className={inputCls} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SaveBar dirty={dirty && (!!object || !!geo)} saving={saving}
          error={error ?? (!data.profilesAvailable ? 'Хранилище недоступно' : blocked ? 'Точка стоит неточно — перетащите её на объект или отметьте «Точка стоит верно»' : !object && !geo ? 'Найдите адрес нового объекта' : null)}
          disabled={!data.profilesAvailable || blocked || (!object && !geo)} savedAt={object ? savedLine(prof.updatedBy, prof.updatedAt) : null}
          label={object ? 'Сохранить' : 'Создать объект'} onSave={() => void onSave()} />
        {onCancel && <button type="button" onClick={onCancel} className="mt-2 min-h-11 rounded-lg px-3 text-sm text-[var(--color-text-muted)]">Отмена</button>}
      </div>
    </div>
  );
}

// ── Карточка объекта ─────────────────────────────────────────────────────────

function ObjectCard({ data, object, params, defaultOpen }: { data: ClientModuleData; object: ModuleObject; params: Record<string, string>; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [editing, setEditing] = useState(false);
  const prof = data.objectProfiles[object.key] ?? EMPTY_OBJECT_PROFILE;
  const deals = useMemo(() => data.deals.filter(d => d.objectKey === object.key), [data.deals, object.key]);
  const s = computeStats(deals);
  const status = objectStatus(deals, { manual: object.manual, doneManual: prof.doneManual }, data.activeDays);
  const address = prof.idealAddress || object.address;
  const needsCheck = !object.manual && !prof.addressConfirmed;
  const { save, saving, error } = useSave(params);
  const chain = [...deals].sort((a, b) => (a.deliveredAt ?? a.createdAt ?? '').localeCompare(b.deliveredAt ?? b.createdAt ?? ''));

  return (
    <section id={`obj-${object.key}`} className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex w-full items-start gap-2 px-3.5 py-3 text-left">
        <MapPin size={16} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[14px] font-semibold">{address}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
            <StatusChip s={status} />
            {needsCheck && <Chip tone="warn">проверь адрес</Chip>}
            <span>отгружено {s.shipped} на <b className="tabular-nums text-[var(--color-text)]">{fmtMoney(s.ltv)}</b></span>
            {s.open > 0 && <span>· в работе {s.open}</span>}
            {s.lastShippedAt && <span>· посл. отгрузка {fmtDate(s.lastShippedAt)}</span>}
          </span>
          {s.groups.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {s.groups.slice(0, 6).map(g => <Chip key={g.group}>{shortGroup(g.group)}</Chip>)}
            </span>
          )}
        </span>
        {open ? <ChevronDown size={18} className="mt-0.5 shrink-0" /> : <ChevronRight size={18} className="mt-0.5 shrink-0" />}
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-[var(--color-border)] px-3.5 py-3">
          {needsCheck && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-warning,#e8590c)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning,#e8590c)_8%,transparent)] px-3 py-2 text-[12.5px]">
              <div className="flex items-start gap-1.5">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--color-warning,#e8590c)]" />
                <span>Проверь адрес, он проставлен автоматически ({ADDRESS_SOURCE_LABEL[object.source]}). Если не тот — поправь вручную.</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2 pl-5">
                <button type="button" disabled={saving || !data.v2Available} onClick={() => void save({ object: { key: object.key, confirmAddress: true } })}
                  className="min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-[12px] font-semibold disabled:opacity-40">Адрес верный</button>
                <button type="button" onClick={() => setEditing(true)} className="min-h-9 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-[12px]">Поправить</button>
                {!data.v2Available && <span className="self-center text-[11.5px] text-[var(--color-text-muted)]">«Адрес верный» — после миграции 006</span>}
              </div>
            </div>
          )}
          {object.requests.length > 0 && (
            <div className="text-[11.5px] text-[var(--color-text-muted)]">
              Заявки 1С: {object.requests.map(r => `№${r.number.replace(/^0+/, '')}${r.date ? ` от ${fmtDate(r.date)}` : ''}`).join(', ')}
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Стадии и что предложить</div>
              <Ladder ladder={data.recommendations.byObject[object.key]} />
            </div>
            <div className="min-w-0">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Цепочка сделок · {chain.length}</div>
              {chain.length === 0 ? <div className="text-[12.5px] text-[var(--color-text-muted)]">Сделок по объекту нет</div> : (
                <div className="flex flex-col divide-y divide-[var(--color-border)] text-[12.5px]">
                  {chain.map((d, i) => {
                    const prev = i > 0 ? chain[i - 1] : null;
                    const gap = prev?.deliveredAt && d.deliveredAt ? Math.round((new Date(d.deliveredAt).getTime() - new Date(prev.deliveredAt).getTime()) / DAY_MS) : null;
                    return (
                      <div key={d.dealId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                        <span className="tabular-nums text-[var(--color-text-muted)]">{fmtDate(d.deliveredAt ?? d.createdAt)}</span>
                        <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="font-mono text-[var(--color-accent)] hover:underline">#{d.dealId}</a>
                        <StageChip s={d.stage} />
                        {gap !== null && <Chip>↓ {gap} дн.</Chip>}
                        <span className="ml-auto font-semibold tabular-nums">{d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
                        <span className="basis-full truncate text-[12px] text-[var(--color-text-muted)]" title={d.groups.join(', ')}>{d.groups.length ? d.groups.map(shortGroup).join(', ') : (d.name ?? '')}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-2.5">
            <span className="text-[12px] text-[var(--color-text-muted)]">Статус: <StatusChip s={status} />{prof.doneManual ? ' (вручную)' : ' (автоматически)'}</span>
            {prof.doneManual ? (
              <button type="button" disabled={saving || !data.v2Available} onClick={() => void save({ object: { key: object.key, done: false } })}
                className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-[12px] disabled:opacity-40">Вернуть автоматический статус</button>
            ) : status !== 'done' ? (
              <button type="button" disabled={saving || !data.v2Available} onClick={() => void save({ object: { key: object.key, done: true } })}
                className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-[12px] disabled:opacity-40">Завершить объект</button>
            ) : null}
            {!editing && <button type="button" onClick={() => setEditing(true)} className="min-h-9 rounded-lg border border-[var(--color-border)] px-3 text-[12px]">Адрес, стадия, заметка</button>}
            {error && <span className="text-[12px]" style={{ color: 'var(--color-negative, #e03131)' }}>{error}</span>}
          </div>
          {prof.note && !editing && <div className="whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] px-2.5 py-2 text-[12.5px]">{prof.note}</div>}
          {editing && <ObjectEditor data={data} object={object} params={params} onCancel={() => setEditing(false)} />}
        </div>
      )}
    </section>
  );
}

export function ObjectsTab({ data, params, focus }: { data: ClientModuleData; params: Record<string, string>; focus: string | null }) {
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const order = { active: 0, new: 1, done: 2 } as const;
  const objects = useMemo(() => data.objects.map(o => {
    const deals = data.deals.filter(d => d.objectKey === o.key);
    const prof = data.objectProfiles[o.key] ?? EMPTY_OBJECT_PROFILE;
    return { o, st: objectStatus(deals, { manual: o.manual, doneManual: prof.doneManual }, data.activeDays), last: computeStats(deals).lastShippedAt ?? '' };
  }).sort((a, b) => order[a.st] - order[b.st] || b.last.localeCompare(a.last)), [data]);
  const noObject = data.deals.filter(d => !d.objectKey).length;

  useEffect(() => {
    const k = focus ?? justCreated;
    if (k) document.getElementById(`obj-${k}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus, justCreated]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-[var(--color-text-muted)]">
          Объектов: {objects.length} · в работе {objects.filter(x => x.st === 'active').length}
          {noObject > 0 && <> · сделок без объекта: {noObject}</>}
        </span>
        {data.profilesAvailable && !creating && (
          <button type="button" onClick={() => setCreating(true)} className="ml-auto inline-flex min-h-10 items-center gap-1 rounded-lg border border-dashed border-[var(--color-border)] px-3 text-[12.5px]">
            <Plus size={14} /> Новый объект
          </button>
        )}
      </div>
      {!data.addressesAvailable && <div className="text-[12px] text-[var(--color-text-muted)]">Адреса заявок 1С и сделок сейчас недоступны — объекты показаны не все.</div>}
      {creating && (
        <Section title="Новый объект">
          <ObjectEditor data={data} object={null} params={params} onCancel={() => setCreating(false)} onCreated={k => { setCreating(false); setJustCreated(k); }} />
        </Section>
      )}
      {objects.length === 0 && !creating && <div className="py-6 text-center text-[13px] text-[var(--color-text-muted)]">Объектов нет: адресов в заявках и сделках не нашлось.</div>}
      {objects.map(({ o }) => (
        <ObjectCard key={o.key} data={data} object={o} params={params} defaultOpen={o.key === focus || o.key === justCreated || objects.length === 1} />
      ))}
    </div>
  );
}
