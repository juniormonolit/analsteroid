'use client';
// Вкладка «Как дела?» панели бота «Аналитик» (задача владельца 15.09): расписание,
// получатели, конструктор фраз с превью и пробная отправка себе. Рубильник и
// получатели — те же строки реестра функций (bot_channels.how_are_we), что и во
// вкладке «Функции»: меняются через тот же PATCH, чтобы не было двух правд.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Eye, Send, Save, RotateCcw, Users, X, BellOff } from 'lucide-react';
import type { PhraseBlock } from '@/features/how-are-we/engine/phrases';

interface Recipient { bitrixId: string; name: string; login: string }
interface Settings { hours: number[]; weekdaysOnly: boolean; phrases: Record<string, string[]>; updatedAt: string | null; updatedBy: string | null }
interface Data { settings: Settings; recipients: string[]; enabled: boolean; blocks: PhraseBlock[] }

const cardCls = 'rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4';
const inputCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base sm:text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const btnCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40 transition-colors';
const btnPrimaryCls = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-[var(--color-text-inverse)] hover:bg-[var(--color-accent-hover)] disabled:opacity-40 transition-colors';
const HOURS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** bbcode чата Битрикса → безопасный HTML для превью (только теги, которые мы сами пишем). */
function bbToHtml(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .replace(/\[B\]([\s\S]*?)\[\/B\]/g, '<b>$1</b>')
    .replace(/\[I\]([\s\S]*?)\[\/I\]/g, '<i>$1</i>')
    .replace(/\[SIZE=(\d+)\]([\s\S]*?)\[\/SIZE\]/g, '<span style="font-size:$1px">$2</span>')
    .replace(/\[COLOR=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/COLOR\]/g, '<span style="color:$1">$2</span>')
    .replace(/\[URL=([^\]]+)\]([\s\S]*?)\[\/URL\]/g, '<a href="$1" target="_blank" rel="noreferrer" class="underline text-[var(--color-accent)]">$2</a>')
    .replace(/\[USER=\d+\]([\s\S]*?)\[\/USER\]/g, '<span class="underline decoration-dotted text-[var(--color-accent)]">$1</span>')
    .replace(/\n/g, '<br/>');
}

export function HowAreWeTab() {
  const qc = useQueryClient();
  const { data, error } = useQuery<Data>({
    queryKey: ['how-are-we-settings'],
    queryFn: () => fetch('/api/settings/bots/how-are-we').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });
  const { data: opts } = useQuery<{ recipients: Recipient[] }>({
    queryKey: ['bot-schedule-options'],
    queryFn: () => fetch('/api/settings/bots/report-schedules/options').then(jsonOrThrow),
    refetchOnWindowFocus: false,
  });

  // Локальная копия настроек — правки копятся до «Сохранить».
  const [hours, setHours] = useState<number[]>([]);
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [phrases, setPhrases] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!data) return;
    setHours(data.settings.hours); setWeekdaysOnly(data.settings.weekdaysOnly); setPhrases(data.settings.phrases ?? {}); setDirty(false);
  }, [data]);

  const save = useMutation({
    mutationFn: () => fetch('/api/settings/bots/how-are-we', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours, weekdaysOnly, phrases }),
    }).then(jsonOrThrow),
    onSuccess: () => { setDirty(false); void qc.invalidateQueries({ queryKey: ['how-are-we-settings'] }); },
  });
  const patchFn = useMutation({
    mutationFn: (body: { enabled?: boolean; config?: { recipients: string[] } }) => fetch('/api/settings/bots/channels', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'how_are_we', ...body }),
    }).then(jsonOrThrow),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['how-are-we-settings'] }); void qc.invalidateQueries({ queryKey: ['bot-functions'] }); },
  });

  // Превью и пробная отправка.
  const [previewHour, setPreviewHour] = useState(15);
  const preview = useMutation({
    mutationFn: () => fetch('/api/settings/bots/how-are-we/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hour: previewHour, phrases }),
    }).then(jsonOrThrow) as Promise<{ message: string; details: string; imageUrl: string | null }>,
  });
  const sendMe = useMutation({
    mutationFn: () => fetch('/api/settings/bots/how-are-we/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hour: previewHour }),
    }).then(jsonOrThrow) as Promise<{ ok: true; to: string }>,
  });

  const recipientsById = useMemo(() => new Map((opts?.recipients ?? []).map(r => [r.bitrixId, r])), [opts]);

  if (error) return <section className={cardCls}><div className="text-sm text-[var(--color-negative)]">{(error as Error).message}</div></section>;
  if (!data) return <section className={cardCls}><div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div></section>;

  return (
    <div className="flex flex-col gap-4">
      <div className="text-xs text-[var(--color-text-muted)] leading-relaxed">
        Бот «Аналитик» по расписанию рассказывает, как идут продажи дня: компания, филиалы, кто тащит и кто проседает,
        герои дня, картинка с полосами факт/план. В вечернем выпуске — темп месяца. Раскладка по командам — по кнопке
        «Детально» под сообщением. Фразы ниже — конструктор: бот берёт случайный вариант из каждого блока, поэтому
        выпуски читаются по-разному; плейсхолдеры в фигурных скобках подставляются цифрами.
      </div>

      {/* ── Рубильник, расписание, получатели ── */}
      <section className={cardCls}>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={data.enabled} disabled={patchFn.isPending}
              onChange={() => patchFn.mutate({ enabled: !data.enabled })}
              className="tap-target h-4 w-4 cursor-pointer accent-[var(--color-accent)]" />
            <span className="text-sm font-bold text-[var(--color-text)]">Дайджест включён</span>
          </label>
          {!data.enabled && (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"><BellOff size={11} /> выключено — по расписанию ничего не уходит, пробные себе — можно</span>
          )}
        </div>

        <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)] inline-flex items-center gap-1"><Clock size={11} /> Часы отправки (МСК)</div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {HOURS.map(h => {
            const on = hours.includes(h);
            return (
              <button key={h} onClick={() => { setHours(on ? hours.filter(x => x !== h) : [...hours, h].sort((a, b) => a - b)); setDirty(true); }}
                className={`min-h-11 min-w-11 rounded-lg border px-2 text-sm tabular-nums transition-colors ${on
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)] font-semibold'
                  : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]'}`}>
                {h}:00
              </button>
            );
          })}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text)] mb-3">
          <input type="checkbox" checked={weekdaysOnly} onChange={e => { setWeekdaysOnly(e.target.checked); setDirty(true); }}
            className="tap-target h-4 w-4 cursor-pointer accent-[var(--color-accent)]" />
          Только по будням
        </label>
        <div className="text-[11px] text-[var(--color-text-muted)] mb-3">
          Выпуск в 18:00 и позже — с итогом дня и темпом месяца (продажи и отгрузки отдельно). Более ранние — только день.
        </div>

        <RecipientsEditor value={data.recipients} all={opts?.recipients ?? []} byId={recipientsById}
          busy={patchFn.isPending} onChange={list => patchFn.mutate({ config: { recipients: list } })} />
        {patchFn.isError && <div className="mt-2 text-xs text-[var(--color-negative)]">{(patchFn.error as Error).message}</div>}
      </section>

      {/* ── Пример и пробная отправка ── */}
      <section className={cardCls}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="text-base font-bold text-[var(--color-text)] inline-flex items-center gap-2"><Eye size={16} /> Пример выпуска</h2>
          <span className="text-xs text-[var(--color-text-muted)]">на сегодняшних данных, с фразами как они сейчас в редакторе</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={previewHour} onChange={e => setPreviewHour(Number(e.target.value))} className={`${inputCls} w-auto`}>
            {HOURS.map(h => <option key={h} value={h}>{h}:00</option>)}
          </select>
          <button onClick={() => preview.mutate()} disabled={preview.isPending} className={btnCls}><Eye size={14} /> {preview.isPending ? 'Собираю…' : 'Показать пример'}</button>
          <button onClick={() => sendMe.mutate()} disabled={sendMe.isPending} className={btnPrimaryCls} title="Только вам в личку — получатели из настроек не тронуты">
            <Send size={14} /> {sendMe.isPending ? 'Отправляю…' : 'Отправить пробное мне'}
          </button>
          {sendMe.isSuccess && <span className="text-xs text-[var(--color-positive,#16a34a)]">Ушло в Битрикс (#{sendMe.data.to})</span>}
          {sendMe.isError && <span className="text-xs text-[var(--color-negative)]">{(sendMe.error as Error).message}</span>}
        </div>
        {preview.isError && <div className="mt-2 text-xs text-[var(--color-negative)]">{(preview.error as Error).message}</div>}
        {preview.data && (
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">Сообщение</div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm leading-relaxed text-[var(--color-text)] break-words"
                dangerouslySetInnerHTML={{ __html: bbToHtml(preview.data.message) }} />
              {preview.data.imageUrl && (
                <img src={preview.data.imageUrl} alt="График выпуска" className="mt-2 rounded-xl border border-[var(--color-border)] max-w-full" />
              )}
            </div>
            <div>
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">По кнопке «Детально»</div>
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm leading-relaxed text-[var(--color-text)] break-words"
                dangerouslySetInnerHTML={{ __html: bbToHtml(preview.data.details) }} />
            </div>
          </div>
        )}
      </section>

      {/* ── Конструктор фраз ── */}
      <section className={cardCls}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div>
            <h2 className="text-base font-bold text-[var(--color-text)]">Конструктор фраз</h2>
            <div className="text-xs text-[var(--color-text-muted)]">Один вариант на строку. Пустой блок — стандартные фразы. Плейсхолдер — в фигурных скобках.</div>
          </div>
          <div className="flex items-center gap-2">
            {data.settings.updatedBy && <span className="text-[10px] text-[var(--color-text-muted)]">менял {data.settings.updatedBy}</span>}
            <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className={btnPrimaryCls}><Save size={14} /> {save.isPending ? 'Сохраняю…' : 'Сохранить'}</button>
          </div>
        </div>
        {save.isError && <div className="mb-2 text-xs text-[var(--color-negative)]">{(save.error as Error).message}</div>}
        <div className="flex flex-col gap-3">
          {data.blocks.map(b => {
            const own = phrases[b.key];
            const value = (own?.length ? own : b.defaults).join('\n');
            return (
              <div key={b.key} className="rounded-xl border border-[var(--color-border)] p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 mb-1">
                  <span className="text-sm font-semibold text-[var(--color-text)]">{b.title}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)]">{own?.length ? 'свои фразы' : 'стандартные'}</span>
                </div>
                <div className="text-[11px] text-[var(--color-text-muted)] mb-1.5">{b.hint}</div>
                {b.placeholders.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {b.placeholders.map(ph => (
                      <code key={ph} className="rounded bg-[var(--color-bg-hover)] px-1.5 py-0.5 text-[11px] text-[var(--color-text)]">{`{${ph}}`}</code>
                    ))}
                  </div>
                )}
                <textarea value={value} rows={Math.min(8, Math.max(2, value.split('\n').length))}
                  onChange={e => { setPhrases(p => ({ ...p, [b.key]: e.target.value.split('\n') })); setDirty(true); }}
                  className={`${inputCls} font-mono text-[13px] leading-relaxed`} />
                {own?.length ? (
                  <button onClick={() => { setPhrases(p => { const n = { ...p }; delete n[b.key]; return n; }); setDirty(true); }}
                    className="tap-target mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]">
                    <RotateCcw size={11} /> вернуть стандартные
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {dirty && (
          <div className="sticky bottom-2 mt-3 flex justify-end">
            <button onClick={() => save.mutate()} disabled={save.isPending} className={btnPrimaryCls}><Save size={14} /> Сохранить изменения</button>
          </div>
        )}
      </section>
    </div>
  );
}

function RecipientsEditor({ value, all, byId, busy, onChange }: {
  value: string[]; all: Recipient[]; byId: Map<string, Recipient>; busy: boolean; onChange: (list: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return all.filter(r => !value.includes(r.bitrixId) && (r.name.toLowerCase().includes(needle) || r.login.toLowerCase().includes(needle))).slice(0, 8);
  }, [all, value, q]);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)] inline-flex items-center gap-1"><Users size={11} /> Получатели</div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {value.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">пока никого — по расписанию слать некому</span>}
        {value.map(id => (
          <span key={id} className="inline-flex items-center gap-1 rounded-md bg-[var(--color-bg-hover)] px-2 py-1 text-[12px] text-[var(--color-text)]">
            {byId.get(id)?.name ?? `#${id}`}
            <button disabled={busy} onClick={() => onChange(value.filter(x => x !== id))} className="tap-target text-[var(--color-text-muted)] hover:text-[var(--color-negative)]"><X size={12} /></button>
          </span>
        ))}
      </div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Найти сотрудника…" className={inputCls} />
      {candidates.length > 0 && (
        <div className="mt-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
          {candidates.map(r => (
            <button key={r.bitrixId} disabled={busy} onClick={() => { onChange([...value, r.bitrixId]); setQ(''); }}
              className="min-h-11 px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]">
              {r.name} <span className="text-[11px] text-[var(--color-text-muted)]">{r.login}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
