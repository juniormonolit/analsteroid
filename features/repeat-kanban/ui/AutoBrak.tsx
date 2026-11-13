'use client';
// «Фильтр на колонке с автобраком» (владелец, собрание 12.11 п. 4+7, ответы 13.11; миграция 265). РОП открывает
// настройки колонки, ставит фильтр и сразу видит, сколько останется и сколько уйдёт в брак (заказчики, LTV, потенциал,
// список уходящих). «Применить» — с двойным подтверждением; «Применять автоматически» — будни 8:00 МСК, кандидаты с доски
// скрыты (режим «Показывать автобрак» — показать). Журнал партий, откат партии (только снять брак).
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { BRAK_REASONS } from '../engine/config';
import type { CustomFilters } from '../engine/customColumns';
import type { BrakPreview } from '../engine/autoBrakTypes';
import type { BrakBatch, BrakRule } from '../engine/autoBrak';
import type { TagDef } from '../engine/tagColors';
import { FilterFields } from './CustomColumns';

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1).replace('.', ',')} млрд ₽` : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} млн ₽` : n >= 1000 ? `${Math.round(n / 1000)} тыс. ₽` : `${rub.format(n)} ₽`);
const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm';
const IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] hover:bg-[var(--color-bg-hover)]`;
const ON = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`;

/** Кнопка в заголовке колонки: шестерёнка; если правило с авто что-то скрыло — «скрыто N». */
export function AutoBrakButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Фильтр колонки и автобрак" aria-label="Фильтр колонки и автобрак"
      className="tap-target inline-flex items-center gap-1 rounded px-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)]">
      <SlidersHorizontal size={13} />{hidden > 0 && <span title="Скрыто с доски: кандидаты на автобрак">автобрак {rub.format(hidden)}</span>}
    </button>
  );
}

export function AutoBrakModal({ column, title, scopeQs, tagDefs, showAutoBrak, onShowAutoBrak, onClose, onChanged }: {
  column: string; title: string; scopeQs: string; tagDefs: TagDef[];
  showAutoBrak: boolean; onShowAutoBrak: (v: boolean) => void; onClose: () => void; onChanged: () => void;
}) {
  const qc = useQueryClient();
  const data = useQuery<{ rule: BrakRule | null; batches: BrakBatch[] }>({
    queryKey: ['auto-brak', column],
    queryFn: async () => { const r = await fetch(`/api/repeat-kanban/auto-brak?column=${column}`); const j = await r.json(); if (!r.ok) throw new Error(j.error ?? 'Ошибка'); return j; },
    // Партия идёт — опрашиваем прогресс.
    refetchInterval: q => (q.state.data?.batches.some(b => b.status === 'running') ? 3000 : false),
  });
  const [mode, setMode] = useState<'brak' | 'keep'>('brak');
  const [f, setF] = useState<CustomFilters>({});
  const [reason, setReason] = useState('nothing_needed');
  const [comment, setComment] = useState('');
  const [auto, setAuto] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<BrakPreview | null>(null);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<number | null>(null);

  useEffect(() => {
    if (loaded || !data.data) return;
    const r = data.data.rule;
    if (r) { setMode(r.mode); setF(r.filters); setReason(r.reason); setComment(r.comment ?? ''); setAuto(r.auto); }
    setLoaded(true);
  }, [data.data, loaded]);

  const set = (patch: Partial<CustomFilters>) => setF(prev => {
    const n = { ...prev, ...patch } as Record<string, unknown>;
    for (const k of Object.keys(n)) if (n[k] === undefined || (Array.isArray(n[k]) && !(n[k] as unknown[]).length)) delete n[k];
    return n as CustomFilters;
  });
  const empty = !Object.keys(f).length;

  // Живой предпросмотр: сколько останется / уйдёт — по доске зоны (без фильтров доски, только отделы/менеджеры).
  useEffect(() => {
    if (empty) { setPreview(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/repeat-kanban?${scopeQs}${scopeQs ? '&' : ''}abPreview=${encodeURIComponent(JSON.stringify({ column, mode, filters: f }))}`).catch(() => null);
      const j = r ? await r.json().catch(() => null) : null;
      setPreview(j?.brak ?? null);
    }, 700);
    return () => clearTimeout(t);
  }, [f, mode, column, empty, scopeQs]);

  const body = { column, mode, filters: f, reason, comment, auto };
  const post = async (payload: Record<string, unknown>) => {
    const r = await fetch('/api/repeat-kanban/auto-brak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
    return j;
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['auto-brak', column] }); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const reasonLabel = BRAK_REASONS.find(r => r.value === reason)?.label ?? reason;
  const running = data.data?.batches.find(b => b.status === 'running');

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Фильтр колонки «${title}»`} desktopWidth="sm:max-w-2xl">
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <p className="text-[12.5px] text-[var(--color-text-muted)]">Задайте условия — сразу видно, сколько заказчиков колонки останется, а сколько уйдёт в брак. Брак — как «Сразу в брак»: отметка, открытая повторная сделка закроется в отказ по причине, открытые задачи закроются. Считается по вашей зоне (отделы и менеджеры доски), без остальных фильтров доски.</p>
        <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-2" role="radiogroup" aria-label="Что выбирает фильтр">
          <button type="button" role="radio" aria-checked={mode === 'brak'} onClick={() => setMode('brak')} className={mode === 'brak' ? ON : IDLE}>Фильтр выбирает, кто уходит в брак</button>
          <button type="button" role="radio" aria-checked={mode === 'keep'} onClick={() => setMode('keep')} className={mode === 'keep' ? ON : IDLE}>Фильтр выбирает, кто остаётся</button>
        </div>
        {!empty || loaded ? <FilterFields f={f} set={set} tagDefs={tagDefs} /> : null}
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">Причина брака (стадия отказа)
            <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason} options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))}
              className={`${IDLE} w-full justify-start`} />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[13px] text-[var(--color-text-secondary)]">Комментарий (в сделку и задачу)
            <input value={comment} onChange={e => setComment(e.target.value)} maxLength={500} placeholder="Мелкие: < 500 тыс., ≤ 3 отгрузок"
              className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base sm:text-sm" />
          </label>
        </div>

        {/* Предпросмотр. */}
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-[var(--color-border)] px-3 py-2">
            <div className="text-[12px] text-[var(--color-text-muted)]">Останется в колонке</div>
            {empty ? <div className="text-[var(--color-text-muted)]">Задайте условия</div> : preview ? <div><b className="text-lg tabular-nums">{rub.format(preview.keepN)}</b> · LTV {money(preview.keepLtv)}</div> : <div className="text-[var(--color-text-muted)]">Считаю…</div>}
          </div>
          <div className="rounded-lg border border-[#e06666] bg-[color-mix(in_srgb,#f4cccc_45%,transparent)] px-3 py-2">
            <div className="text-[12px] text-[#990000]">Уйдёт в брак</div>
            {empty ? <div className="text-[var(--color-text-muted)]">—</div> : preview ? <div><b className="text-lg tabular-nums text-[#990000]">{rub.format(preview.brakN)}</b> · LTV {money(preview.brakLtv)}{preview.brakPotential ? ` · потенциал ${money(preview.brakPotential)}` : ''}</div> : <div className="text-[var(--color-text-muted)]">Считаю…</div>}
          </div>
        </div>
        {preview && preview.candidates.length > 0 && (
          <details className="rounded-lg border border-[var(--color-border)]">
            <summary className="min-h-11 cursor-pointer px-3 py-2 text-[13px]">Кто уйдёт в брак{preview.brakN > preview.candidates.length ? ` (первые ${preview.candidates.length} по LTV из ${rub.format(preview.brakN)})` : ''}</summary>
            <ul className="max-h-60 overflow-y-auto px-3 pb-2 text-[12.5px]">
              {preview.candidates.map(c => (
                <li key={c.clientKey} className="flex min-w-0 justify-between gap-2 border-t border-[var(--color-border)] py-1">
                  <span className="min-w-0 truncate">{c.name ?? c.clientKey}<span className="text-[var(--color-text-muted)]"> · {c.managerName ?? '—'}{c.dealOpen ? ' · сделка открыта' : ''}</span></span>
                  <span className="shrink-0 tabular-nums">{money(c.ltv)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <label className="flex min-h-11 items-start gap-2">
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} className="mt-1 h-4 w-4" />
          <span>Применять автоматически — по будням в 8:00 МСК. <span className="text-[12px] text-[var(--color-text-muted)]">Пока правило с авто, кандидаты на брак скрыты из этой колонки.</span></span>
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" checked={showAutoBrak} onChange={e => onShowAutoBrak(e.target.checked)} className="h-4 w-4" />
          Показывать автобрак (кандидатов, скрытых правилами с авто, — на доске и в «Сегодня»)
        </label>

        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        {step === 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {data.data?.rule && <button type="button" disabled={busy} onClick={() => act(async () => { await post({ action: 'delete', column }); setF({}); setAuto(false); })} className={`${IDLE} text-[var(--color-text-muted)]`}>Удалить правило</button>}
            <button type="button" disabled={busy || empty} onClick={() => act(async () => { await post({ action: 'save', ...body }); })} className={IDLE}>Сохранить правило</button>
            <button type="button" disabled={busy || empty || !preview || preview.brakN === 0 || !!running} onClick={() => { setStep(1); setSure(false); }}
              className={`${BTN} border-[#990000] bg-[#990000] text-white disabled:opacity-50`}><Ban size={14} /> Применить сейчас…</button>
          </div>
        )}
        {/* Двойное подтверждение (собрание 12.11: «дополнительные окна подтверждения»). */}
        {step >= 1 && preview && (
          <div className="flex flex-col gap-2 rounded-lg border-2 border-[#990000] p-3">
            <b className="text-[#990000]">Забраковать {rub.format(preview.brakN)} заказчиков колонки «{title}»?</b>
            <ul className="list-disc pl-5 text-[13px]">
              <li>каждый уйдёт в «Брак» с причиной «{reasonLabel}»;</li>
              <li>открытая повторная сделка закроется в Битриксе в эту отказную стадию, комментарий — в ленту сделки;</li>
              <li>открытые задачи проекта по заказчику закроются с комментарием;</li>
              <li>идёт в фоне, по одному (Битрикс — вежливо); прогресс — в журнале ниже;</li>
              <li>откат партии вернёт заказчиков в канбан (снимет брак), но сделки и задачи в Битриксе останутся закрытыми.</li>
            </ul>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setStep(0)} className={IDLE}>Отмена</button>
              <button type="button" onClick={() => { setSure(false); setStep(2); }} className={`${BTN} border-[#990000] text-[#990000]`}>Да, дальше</button>
            </div>
          </div>
        )}

        {/* Отдельное окно «Я подтверждаю» (владелец 13.11: «отдельное окошко подтверждения, чтобы человеку было написано
            „Я подтверждаю, что отправится в брак столько-то…“»). Сервер сверяет число с подтверждённым (expectN). */}
        {step === 2 && preview && (
          <Modal open onOpenChange={o => { if (!o && !busy) setStep(0); }} title="Подтвердите автобрак" desktopWidth="sm:max-w-md">
            <div className="flex flex-col gap-3 text-sm">
              <div className="rounded-lg border-2 border-[#990000] bg-[color-mix(in_srgb,#f4cccc_35%,transparent)] p-3 text-[13.5px] leading-relaxed">
                Колонка «{title}», причина «{reasonLabel}».<br />
                В брак уйдут <b className="text-[#990000]">{rub.format(preview.brakN)}</b> {plural(preview.brakN, 'заказчик', 'заказчика', 'заказчиков')} с LTV <b>{money(preview.brakLtv)}</b>.<br />
                В Битриксе закроются в отказ <b className="text-[#990000]">{rub.format(preview.brakDealsOpen ?? 0)}</b> {plural(preview.brakDealsOpen ?? 0, 'открытая сделка', 'открытые сделки', 'открытых сделок')}
                {preview.brakTasksOpen ? <> и <b className="text-[#990000]">{rub.format(preview.brakTasksOpen)}</b> {plural(preview.brakTasksOpen, 'открытая задача', 'открытые задачи', 'открытых задач')}</> : null}.<br />
                Откат вернёт заказчиков в канбан, но сделки и задачи в Битриксе <b>останутся закрытыми</b>.
              </div>
              <label className="flex min-h-11 cursor-pointer items-start gap-2 text-[13.5px]">
                <input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} className="mt-1 h-4 w-4" />
                <span>Я подтверждаю, что в брак отправятся {rub.format(preview.brakN)} {plural(preview.brakN, 'заказчик', 'заказчика', 'заказчиков')}, в Битриксе закроются {rub.format(preview.brakDealsOpen ?? 0)} {plural(preview.brakDealsOpen ?? 0, 'сделка', 'сделки', 'сделок')}{preview.brakTasksOpen ? ` и ${rub.format(preview.brakTasksOpen)} ${plural(preview.brakTasksOpen, 'задача', 'задачи', 'задач')}` : ''}, и это нельзя отменить в Битриксе.</span>
              </label>
              {err && <p className="text-[var(--color-negative)]">{err}</p>}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => setStep(0)} className={IDLE}>Отмена</button>
                <button type="button" disabled={!sure || busy} onClick={() => act(async () => { await post({ action: 'save', ...body }); await post({ action: 'apply', ...body, expectN: preview.brakN }); setStep(0); })}
                  className={`${BTN} border-[#990000] bg-[#990000] text-white disabled:opacity-50`}><Ban size={14} /> {busy ? 'Запускаю…' : `Забраковать ${rub.format(preview.brakN)}`}</button>
              </div>
            </div>
          </Modal>
        )}

        {/* Журнал автобрака. */}
        <section className="flex min-w-0 flex-col gap-1.5">
          <h3 className="text-[13px] font-semibold">Журнал автобрака колонки</h3>
          {(data.data?.batches.length ?? 0) === 0 ? <p className="text-[12.5px] text-[var(--color-text-muted)]">Пока не применяли.</p> : (
            <ul className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] text-[12.5px]">
              {data.data!.batches.map(b => (
                <li key={b.id} className="flex min-w-0 flex-col gap-1 px-3 py-2">
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <b>{fmtDT(b.startedAt)}</b> · {b.auto ? 'автоматически' : b.runByName ?? 'вручную'} · {rub.format(b.done)}{b.status === 'running' ? ` из ${rub.format(b.total)}…` : ''} в брак{b.failed ? `, не вышло ${b.failed}` : ''} · LTV {money(b.ltv)}
                      {b.revertedAt && <span className="text-[var(--color-text-muted)]"> · откатил {b.revertedBy} {fmtDT(b.revertedAt)}</span>}
                    </span>
                    <span className="flex shrink-0 gap-1">
                      <button type="button" onClick={() => setOpenBatch(o => (o === b.id ? null : b.id))} className="min-h-9 rounded px-2 text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Кто</button>
                      {!b.revertedAt && b.status !== 'running' && b.done > 0 && (
                        <button type="button" disabled={busy} onClick={() => { if (confirm(`Откатить партию: снять брак с ${b.done} заказчиков? Сделки и задачи в Битриксе останутся закрытыми.`)) void act(async () => { await post({ action: 'revert', batchId: b.id }); }); }}
                          className="inline-flex min-h-9 items-center gap-1 rounded px-2 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"><RotateCcw size={13} /> Откатить</button>
                      )}
                    </span>
                  </div>
                  {openBatch === b.id && <BatchItems id={b.id} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

function BatchItems({ id }: { id: number }) {
  const q = useQuery<{ items: { clientKey: string; name: string | null; ltv: number; ok: boolean | null; dealClosed: string | null; tasksClosed: number | null; error: string | null }[] }>({
    queryKey: ['auto-brak-items', id],
    queryFn: async () => (await fetch(`/api/repeat-kanban/auto-brak?batch=${id}`)).json(),
  });
  if (!q.data) return <p className="text-[var(--color-text-muted)]">Загружаю…</p>;
  return (
    <ul className="max-h-48 overflow-y-auto">
      {q.data.items.map(i => (
        <li key={i.clientKey} className="flex min-w-0 justify-between gap-2 py-0.5">
          <span className="min-w-0 truncate">{i.name ?? i.clientKey}{i.ok === false ? <span className="text-[var(--color-negative)]"> · {i.error ?? 'ошибка'}</span> : i.ok === null ? <span className="text-[var(--color-text-muted)]"> · в очереди</span> : null}
            {i.dealClosed === 'closed' ? <span className="text-[var(--color-text-muted)]"> · сделка закрыта</span> : null}{i.tasksClosed ? <span className="text-[var(--color-text-muted)]"> · задач закрыто {i.tasksClosed}</span> : null}</span>
          <span className="shrink-0 tabular-nums">{money(i.ltv)}</span>
        </li>
      ))}
    </ul>
  );
}
