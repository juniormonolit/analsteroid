'use client';
// Вкладка «Звонки» открытой карточки задачи канбана больших чеков (собрание РОПов 18.11): «просто звонки,
// как в карточке клиента; все друг за другом, с датой; большим текстом во всю ширину; разговор — пузыри
// чата слева/справа; "Спикер 1/2" → "Менеджер/Клиент"; кнопка отправить на транскрибацию звонков без текста».
// Данные — GET /api/ai-analysis/client?…&texts=1 (право action.ai_call_analysis, без него 403).
// Расшифровка — POST /api/big-deals-kanban/transcribe (общая очередь сервера транскрибации), готовность —
// опрос раз в 10 с, не дольше 10 минут.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FileAudio, Loader2, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import type { CallListItem } from '@/features/ai-analysis/engine/collect';
import { labelSpeakers, ROLE_LABEL, type SpeakerRole } from '@/features/ai-analysis/engine/speakers';
import { plural } from './format';

const POLL_MS = 10_000;
const POLL_LIMIT_MS = 10 * 60_000;
const OPEN_BY_DEFAULT = 3;

async function getJson<T>(url: string): Promise<T> {
  const r = await apiFetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? 'Ошибка загрузки'), { status: r.status });
  return j as T;
}

const tz = { timeZone: 'Europe/Moscow' } as const;
const dayKey = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayTitle = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { ...tz, weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { ...tz, hour: '2-digit', minute: '2-digit' });
const dur = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '—');
const isTalk = (c: CallListItem) => c.result === 'completed' && (c.durationSec ?? 0) > 15;

// ── Мок: показ вкладки локально без БД ─────────────────────────────────────
const MOCK_TEXT_1 = [
  'Спикер 1: Алло, да.',
  'Спикер 2: Добрый день! Меня зовут Анна, компания Монолит, звоню по вашей заявке на бетон М300.',
  'Спикер 1: Да-да, помню. Нам на объект в Химках, кубов сорок, на следующую неделю.',
  'Спикер 2: Отлично. Подача миксером или нужен насос? Какая длина стрелы?',
  'Спикер 1: Насос нужен, метров двадцать восемь. И пришлите счёт на почту, пожалуйста.',
  'Спикер 2: Хорошо, сегодня до вечера пришлю КП и счёт, и наберу вас завтра уточнить дату.',
].join('\n');
const MOCK_TEXT_2 = [
  'Спикер 1: Монолит, отдел продаж, Анна, здравствуйте.',
  'Спикер 2: Здравствуйте, я по счёту за бетон. Можно сдвинуть поставку на четверг?',
  'Спикер 1: Да, давайте на четверг, на восемь утра. Насос тот же.',
  'Спикер 2: Да, спасибо, тогда ждём.',
].join('\n');
const MOCK_TEXT_3 = [
  'Спикер 1: Алло.',
  'Спикер 2: Добрый день, это Анна. Подскажите, бетон приняли, всё в порядке?',
  'Спикер 1: Всё хорошо. Скоро будем лить второй этаж, я вам наберу.',
].join('\n');
function mockCalls(transcribed: boolean): CallListItem[] {
  const now = Date.now(), d = 86_400_000;
  const base = { manager: 'Иванова Анна', dealId: 412233 };
  return [
    { ...base, id: 'mock-4', calledAt: new Date(now - 2 * 3_600_000).toISOString(), direction: 'outbound', result: 'completed', durationSec: 95, hasText: true, textChars: MOCK_TEXT_3.length, text: MOCK_TEXT_3, hasRoles: true },
    { ...base, id: 'mock-3', calledAt: new Date(now - 1 * d).toISOString(), direction: 'outbound', result: 'completed', durationSec: 212,
      ...(transcribed
        ? { hasText: true, textChars: 60, text: 'Добрый день, по оплате счёта всё прошло, ждём машину к восьми, спасибо, до свидания.', hasRoles: false }
        : { hasText: false, textChars: 0 }) },
    { ...base, id: 'mock-2', calledAt: new Date(now - 3 * d).toISOString(), direction: 'inbound', result: 'completed', durationSec: 64, hasText: true, textChars: MOCK_TEXT_2.length, text: MOCK_TEXT_2, hasRoles: true },
    { ...base, id: 'mock-0', calledAt: new Date(now - 6 * d + 3_600_000).toISOString(), direction: 'outbound', result: 'missed', durationSec: 0, hasText: false, textChars: 0 },
    { ...base, id: 'mock-1', calledAt: new Date(now - 6 * d).toISOString(), direction: 'outbound', result: 'completed', durationSec: 183, hasText: true, textChars: MOCK_TEXT_1.length, text: MOCK_TEXT_1, hasRoles: true },
  ];
}

// ── Текст разговора: пузыри чата ──────────────────────────────────────────
interface Bubble { role: SpeakerRole | null; who: string | null; text: string }

function toBubbles(text: string, direction: string | null): Bubble[] {
  const out: Bubble[] = [];
  for (const l of labelSpeakers(text, direction)) {
    const t = l.text.trim();
    if (!t) continue;
    // Строка без метки — продолжение предыдущей реплики.
    if (!l.speaker && out.length) { out[out.length - 1].text += `\n${t}`; continue; }
    out.push({ role: l.role, who: l.role ? ROLE_LABEL[l.role] : l.speaker, text: t });
  }
  return out;
}

function Dialogue({ call }: { call: CallListItem }) {
  const bubbles = useMemo(() => (call.hasRoles ? toBubbles(call.text ?? '', call.direction) : []), [call]);
  if (!call.hasRoles || !bubbles.length) {
    return (
      <div className="mt-1">
        <div className="mb-1 text-[12px] text-[var(--color-text-muted)]">Роли не размечены распознаванием — сплошной текст</div>
        <div className="whitespace-pre-wrap break-words rounded-xl bg-[var(--color-bg-hover)] px-3 py-2 text-[14px] leading-relaxed sm:text-[15px]">{call.text}</div>
      </div>
    );
  }
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {bubbles.map((b, i) => {
        const mine = b.role === 'manager';
        const showWho = i === 0 || bubbles[i - 1].who !== b.who;
        return (
          <div key={i} className={`flex min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
            {showWho && b.who && <span className="mb-0.5 px-1 text-[11px] text-[var(--color-text-muted)]">{b.who}</span>}
            <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[14px] leading-relaxed sm:text-[15px] ${
              mine ? 'rounded-br-md bg-[var(--color-accent-soft,color-mix(in_srgb,var(--color-accent)_16%,transparent))]'
                : 'rounded-bl-md bg-[var(--color-bg-hover)]'}`}>
              {b.text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Расшифровка ───────────────────────────────────────────────────────────
interface TrJob { ids: string[]; startedAt: number; sent: number }
type TrState = { ready: string[]; failed: string[]; pending: string[] };

export function CallsTab({ contactId, companyId, mock }: { contactId: number | null; companyId: number | null; mock?: boolean }) {
  const qc = useQueryClient();
  // Один параметр: компания, если есть, иначе контакт (как ClientSummaryPanel).
  const qs = companyId ? `companyId=${companyId}` : contactId ? `contactId=${contactId}` : '';
  const body = companyId ? { companyId } : { contactId };
  const listKey = ['big-deals-calls', qs, !!mock];

  const [mockTranscribed, setMockTranscribed] = useState(false);
  const list = useQuery<{ calls: CallListItem[] }>({
    queryKey: [...listKey, mockTranscribed],
    enabled: !!mock || !!qs,
    retry: false,
    staleTime: 60_000,
    queryFn: () => (mock ? Promise.resolve({ calls: mockCalls(mockTranscribed) }) : getJson(`/api/ai-analysis/client?${qs}&texts=1`)),
  });
  const calls = useMemo(() => list.data?.calls ?? [], [list.data]);

  // Развёрнуты по умолчанию последние 3 с текстом; клик переключает (храним отличия от умолчания).
  const defaultOpen = useMemo(() => new Set(calls.filter(c => c.hasText).slice(0, OPEN_BY_DEFAULT).map(c => c.id)), [calls]);
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const isOpen = (id: string) => defaultOpen.has(id) !== toggled.has(id);
  const toggle = (id: string) => setToggled(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const days = useMemo(() => {
    const out: { key: string; title: string; items: CallListItem[] }[] = [];
    for (const c of calls) {
      const k = dayKey(c.calledAt);
      if (out.at(-1)?.key !== k) out.push({ key: k, title: dayTitle(c.calledAt), items: [] });
      out.at(-1)!.items.push(c);
    }
    return out;
  }, [calls]);

  // Расшифровка звонков без текста.
  const [job, setJob] = useState<TrJob | null>(null);
  const [trMsg, setTrMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const noText = calls.filter(c => !c.hasText && isTalk(c)).length;

  const state = useQuery<TrState>({
    queryKey: ['big-deals-transcribe', job?.ids.join(',')],
    enabled: !!job && !mock && job.ids.length > 0,
    refetchInterval: POLL_MS,
    retry: false,
    queryFn: () => getJson(`/api/big-deals-kanban/transcribe?ids=${encodeURIComponent(job!.ids.join(','))}`),
  });
  const lastReady = useRef(0);
  useEffect(() => {
    if (!job || mock || !state.data) return;
    const { ready, failed, pending } = state.data;
    if (ready.length !== lastReady.current) { lastReady.current = ready.length; void qc.invalidateQueries({ queryKey: listKey }); }
    const timedOut = Date.now() - job.startedAt > POLL_LIMIT_MS;
    if (!pending.length || timedOut) {
      setJob(null);
      void qc.invalidateQueries({ queryKey: listKey });
      setTrMsg(!pending.length
        ? `Готово: расшифровано ${ready.length}${failed.length ? `, не удалось ${failed.length} (нет записи)` : ''}.`
        : `Готово ${ready.length} из ${job.ids.length}; остальные расшифруются позже — обновите вкладку.`);
    }
    // listKey — производная от qs/mock, отдельно в зависимостях не нужна.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data, job, mock, qc]);

  async function transcribe() {
    setTrMsg(null);
    if (mock) {
      setJob({ ids: ['mock-3'], startedAt: Date.now(), sent: 1 });
      setTimeout(() => { setMockTranscribed(true); setJob(null); setTrMsg('Готово: расшифровано 1.'); }, 3000);
      return;
    }
    setSending(true);
    try {
      const r = await apiFetch('/api/big-deals-kanban/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})) as { sent?: number; inWork?: number; ids?: string[]; rateLimitedSec?: number; error?: string };
      if (r.status === 429) {
        setTrMsg(`Сервис расшифровки занят, попробуйте через ${Math.max(1, Math.ceil((j.rateLimitedSec ?? 60) / 60))} мин.`);
        return;
      }
      if (!r.ok) { setTrMsg(j.error ?? 'Не удалось отправить на расшифровку'); return; }
      const ids = j.ids ?? [];
      if (!ids.length) { setTrMsg('Расшифровывать нечего: у остальных звонков нет записи или они старше окна расшифровки.'); return; }
      lastReady.current = 0;
      setJob({ ids, startedAt: Date.now(), sent: j.sent ?? 0 });
    } catch {
      setTrMsg('Не удалось отправить на расшифровку');
    } finally {
      setSending(false);
    }
  }

  if (!mock && !qs) return <div className="p-4 text-[14px] text-[var(--color-text-muted)]">У задачи нет заказчика — звонков не найти.</div>;
  if (list.isLoading) return <div className="flex items-center gap-2 p-4 text-[14px] text-[var(--color-text-muted)]"><Loader2 size={16} className="animate-spin" /> Загружаем звонки…</div>;
  if (list.isError) {
    const status = (list.error as { status?: number }).status;
    return <div className="p-4 text-[14px] text-[var(--color-text-muted)]">{status === 403 ? 'Звонки видят только РОПы' : (list.error as Error).message}</div>;
  }
  if (!calls.length) return <div className="p-4 text-[14px] text-[var(--color-text-muted)]">Звонков по заказчику нет.</div>;

  const pendingN = job ? (state.data?.pending.length ?? job.ids.length) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-[var(--color-text-muted)]">
        <span>{calls.length} {plural(calls.length, 'звонок', 'звонка', 'звонков')} · с текстом {calls.filter(c => c.hasText).length}</span>
        {job ? (
          <span className="flex min-h-11 items-center gap-2 text-[var(--color-text)]">
            <Loader2 size={15} className="animate-spin" /> Расшифровываю {pendingN} {plural(pendingN, 'звонок', 'звонка', 'звонков')}…
          </span>
        ) : noText > 0 && (
          <button type="button" onClick={transcribe} disabled={sending}
            className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-60">
            {sending ? <Loader2 size={15} className="animate-spin" /> : <FileAudio size={15} />}
            Расшифровать звонки без текста ({noText})
          </button>
        )}
      </div>
      {trMsg && <div className="rounded-lg bg-[var(--color-bg-hover)] px-3 py-2 text-[13px]">{trMsg}</div>}

      {days.map(d => (
        <section key={d.key} className="min-w-0">
          <h4 className="sticky top-0 z-[1] bg-[var(--color-bg-surface,var(--color-bg))] py-1 text-[12px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{d.title}</h4>
          <div className="flex flex-col divide-y divide-[var(--color-border)]">
            {d.items.map(c => {
              const opened = c.hasText && isOpen(c.id);
              const Icon = c.result !== 'completed' ? PhoneMissed : c.direction === 'inbound' ? PhoneIncoming : c.direction === 'outbound' ? PhoneOutgoing : Phone;
              const head = (
                <>
                  <span className="w-12 shrink-0 tabular-nums font-medium">{timeOf(c.calledAt)}</span>
                  <Icon size={15} className={`shrink-0 ${c.result === 'completed' ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-negative)]'}`} />
                  <span className="min-w-0 flex-1 break-words">
                    {c.direction === 'inbound' ? 'Входящий' : 'Исходящий'}
                    {c.result !== 'completed' ? ' · не дозвонились' : ` · ${dur(c.durationSec)}`}
                    {' · '}#{c.dealId}
                    {c.manager && <span className="text-[var(--color-text-muted)]"> · {c.manager}</span>}
                    {!c.hasText && isTalk(c) && <span className="text-[var(--color-text-muted)]"> · без текста</span>}
                  </span>
                </>
              );
              return (
                <div key={c.id} className="min-w-0 py-1">
                  {c.hasText ? (
                    <button type="button" aria-expanded={opened} onClick={() => toggle(c.id)}
                      className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left text-[14px]">
                      {head}
                      <ChevronDown size={16} className={`shrink-0 transition-transform ${opened ? 'rotate-180' : ''}`} />
                    </button>
                  ) : (
                    <div className="flex min-h-11 w-full min-w-0 items-center gap-2 text-[14px]">{head}</div>
                  )}
                  {opened && <div className="pb-2"><Dialogue call={c} /></div>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
