'use client';
// Вкладка «ИИ-анализ» карточки клиента (BACKLOG «ИИ-анализ звонков заказчика», этап 1).
// Видят и запускают только РОПы (право action.ai_call_analysis): без права API отвечает 403 и
// виджет вкладку не показывает (useAiAnalysisAccess). Анализ идёт в фоне (~1 мин), вкладку можно
// закрыть — отчёт сохранится; прогресс честный — этапы, а не выдуманные проценты.
//
// Отчёт — markdown модели с фиксированными разделами «### N.»; каждую «цитату» код проверил по
// расшифровкам (engine/verify.ts): ✓ — найдена (клик ведёт к звонку и подсвечивает место),
// ⚠ — не найдена в звонках (возможна ошибка модели — проверить по записи).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Phone, PhoneMissed, ThumbsDown, ThumbsUp, TriangleAlert } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { MonolitikHelper } from '@/components/mascot/MonolitikHelper';
import type { CallListItem } from '../engine/collect';
import type { AnalysisRow } from '../engine/store';
import type { QuoteCheck } from '../engine/verify';

interface ClientPayload {
  ref: string;
  calls: CallListItem[];
  analyses: AnalysisRow[];
  promptVersion: string;
  quota: { used: number; max: number };
}

const SECTIONS: { n: number; title: string; tone?: 'danger' }[] = [
  { n: 1, title: 'Кто заказчик' },
  { n: 2, title: 'Объекты' },
  { n: 3, title: 'Что предложить дальше' },
  { n: 4, title: 'Риски и обещания' },
  { n: 5, title: 'Оценка работы менеджера' },
  { n: 6, title: 'Нарушения и тревожные сигналы', tone: 'danger' },
  { n: 7, title: 'Качество данных' },
];

const PHASE_TEXT: Record<string, string> = {
  queued: 'Анализ в очереди — сейчас начну.',
  collecting: 'Собираю сделки и звонки заказчика, убираю телефоны и адреса…',
  thinking: 'Читаю разговоры…',
  writing: 'Пишу отчёт…',
};

const fmtDT = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
const fmtD = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

async function getJson<T>(url: string): Promise<T> {
  const r = await apiFetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error ?? 'Ошибка загрузки'), { status: r.status });
  return j as T;
}

/** Есть ли у пользователя вкладка: тот же запрос, что у самой вкладки (кэш общий). */
export function useAiAnalysisAccess(qs: string) {
  const q = useQuery<ClientPayload>({
    queryKey: ['ai-analysis-client', qs],
    enabled: qs.length > 0,
    retry: false,
    staleTime: 60_000,
    queryFn: () => getJson(`/api/ai-analysis/client?${qs}`),
  });
  return { allowed: q.isSuccess, data: q.data };
}

/** Разделы «### N.» отчёта. */
function splitSections(md: string): Map<number, string> {
  const out = new Map<number, string>();
  const parts = md.split(/^#{2,4}\s*(\d)\.\s*[^\n]*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(Number(parts[i]), parts[i + 1].trim());
  return out;
}

/** Строка markdown → React: **жирный**, *курсив*, «цитата» со значком проверки. */
function Inline({ text, quotes, onQuote }: { text: string; quotes: Map<string, QuoteCheck>; onQuote: (q: QuoteCheck) => void }) {
  const nodes: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|«[^«»\n]+»|\*[^*\n]+\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) nodes.push(<b key={k++}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith('*')) nodes.push(<i key={k++}>{tok.slice(1, -1)}</i>);
    else {
      const q = quotes.get(tok.slice(1, -1).trim());
      nodes.push(
        <span key={k++}>
          {tok}
          {q?.found && q.calledAt && (
            <button type="button" onClick={() => onQuote(q)} title="Найдено в звонке — открыть"
              className="tap-target ml-1 inline-flex items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--color-positive)_14%,transparent)] px-1 align-baseline text-[11px] text-[var(--color-positive)]">
              <Check size={11} />{fmtD(q.calledAt)}
            </button>
          )}
          {q && !q.found && q.kind === 'call' && (
            <span title="Цитата не найдена в расшифровках — проверьте по записи звонка"
              className="ml-1 inline-flex items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--color-warning,#e8a317)_16%,transparent)] px-1 align-baseline text-[11px] text-[var(--color-warning,#b7791f)]">
              <TriangleAlert size={11} />не найдено
            </span>
          )}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function SectionBody({ md, quotes, onQuote, danger }: { md: string; quotes: Map<string, QuoteCheck>; onQuote: (q: QuoteCheck) => void; danger?: boolean }) {
  const lines = md.split('\n');
  return (
    <div className="flex flex-col gap-1.5 text-[13.5px] leading-relaxed">
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return null;
        const bullet = /^[-*•]\s+/.test(line), num = /^\d+[.)]\s+/.test(line);
        const body = line.replace(/^[-*•]\s+|^\d+[.)]\s+/, '');
        const found = danger && /НАЙДЕНО|НЕ ПОДТВЕРЖД/i.test(body) && !/НЕ НАЙДЕНО/i.test(body);
        const cls = found
          ? 'rounded-lg border border-[color-mix(in_srgb,var(--color-negative)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-negative)_8%,transparent)] px-2.5 py-1.5'
          : danger && /НЕ НАЙДЕНО/i.test(body) ? 'text-[var(--color-text-muted)]' : '';
        return (
          <div key={i} className={`flex min-w-0 gap-2 ${cls}`}>
            {(bullet || num) && <span className="shrink-0 text-[var(--color-text-muted)]">{num ? line.match(/^\d+/)![0] + '.' : '•'}</span>}
            <div className="min-w-0 break-words"><Inline text={body} quotes={quotes} onQuote={onQuote} /></div>
          </div>
        );
      })}
    </div>
  );
}

/** Памятка менеджеру: «что предложить» + «риски», без оценки менеджера. */
function memoText(a: AnalysisRow): string {
  const s = splitSections(a.reportMd ?? '');
  const clean = (t: string | undefined) => (t ?? '—').replace(/\*\*/g, '').replace(/^\s*[-*•]\s+/gm, '— ').trim();
  return `Памятка ИИ (анализ звонков от ${fmtD(a.createdAt)}):\n\nЧто предложить:\n${clean(s.get(3))}\n\nРиски и обещания:\n${clean(s.get(4))}`;
}

function CallsList({ qs, calls, openId, highlights }: { qs: string; calls: CallListItem[]; openId: string | null; highlights: QuoteCheck[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const isOpen = (id: string) => open.has(id) || openId === id;
  const anyOpen = open.size > 0 || openId !== null;
  const texts = useQuery<ClientPayload>({
    queryKey: ['ai-analysis-texts', qs],
    enabled: anyOpen,
    staleTime: 5 * 60_000,
    queryFn: () => getJson(`/api/ai-analysis/client?${qs}&texts=1`),
  });
  const textOf = useMemo(() => new Map((texts.data?.calls ?? []).map(c => [c.id, c])), [texts.data]);
  const marks = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const q of highlights) if (q.found && q.callId) {
      const head = norm(q.quote.split(/…|\.\.\./)[0]).split(' ').slice(0, 4).join(' ');
      if (head) m.set(q.callId, [...(m.get(q.callId) ?? []), head]);
    }
    return m;
  }, [highlights]);
  const withText = calls.filter(c => c.hasText);

  return (
    <div className="flex flex-col divide-y divide-[var(--color-border)]">
      {withText.map(c => {
        const opened = isOpen(c.id);
        const full = textOf.get(c.id);
        const heads = marks.get(c.id) ?? [];
        return (
          <div key={c.id} id={`ai-call-${c.id}`} className="py-1">
            <button type="button" aria-expanded={opened}
              onClick={() => setOpen(prev => { const n = new Set(prev); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })}
              className="flex min-h-11 w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-left text-[12.5px]">
              <span className="w-[110px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDT(c.calledAt)}</span>
              <span className="text-[var(--color-text-muted)]">{c.result === 'completed' ? <Phone size={13} /> : <PhoneMissed size={13} />}</span>
              <span className="min-w-0 flex-1">
                {c.direction === 'inbound' ? 'Входящий' : 'Исходящий'} · {c.durationSec ? `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}` : '—'} · #{c.dealId}
                {heads.length > 0 && <span className="ml-1 text-[var(--color-positive)]">· цитируется в отчёте</span>}
              </span>
              {c.manager && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{c.manager}</span>}
              <ChevronDown size={14} className={`shrink-0 transition-transform ${opened ? 'rotate-180' : ''}`} />
            </button>
            {opened && (
              <div className="mb-2 mt-1 rounded-lg bg-[var(--color-surface-2,var(--color-bg))] p-2.5 text-[13px] leading-relaxed">
                {!full ? <span className="text-[var(--color-text-muted)]">{texts.isError ? 'Не удалось загрузить текст' : 'Загружаем текст…'}</span> : (
                  <>
                    {!full.hasRoles && <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Роли не размечены распознаванием — сплошной текст</div>}
                    {full.text!.split('\n').map((ln, i) => {
                      const hit = heads.some(h => norm(ln).includes(h));
                      const speaker = ln.match(/^\s*"?(Менеджер|Клиент|Спикер \d)"?\s*[:：]/);
                      return (
                        <div key={i} className={`break-words ${hit ? 'rounded bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] px-1' : ''}`}>
                          {speaker ? <><b className="text-[var(--color-text-muted)]">{speaker[1]}:</b>{ln.slice(speaker[0].length)}</> : ln}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AiAnalysisTab({ qs, params }: { qs: string; params: Record<string, string> }) {
  const qc = useQueryClient();
  const client = useQuery<ClientPayload>({
    queryKey: ['ai-analysis-client', qs],
    retry: false,
    staleTime: 60_000,
    queryFn: () => getJson(`/api/ai-analysis/client?${qs}`),
  });
  const latest = client.data?.analyses[0] ?? null;
  const active = latest && (latest.status === 'queued' || latest.status === 'running') ? latest : null;
  const lastDone = client.data?.analyses.find(a => a.status === 'done') ?? null;
  const [openCall, setOpenCall] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');

  const job = useQuery<AnalysisRow>({
    queryKey: ['ai-analysis', active?.id],
    enabled: !!active,
    refetchInterval: q => (q.state.data && (q.state.data.status === 'done' || q.state.data.status === 'error') ? false : 4000),
    queryFn: () => getJson(`/api/ai-analysis/${active!.id}`),
  });
  const jobFinished = !!job.data && (job.data.status === 'done' || job.data.status === 'error');
  useEffect(() => { if (jobFinished) void qc.invalidateQueries({ queryKey: ['ai-analysis-client', qs] }); }, [jobFinished, qc, qs]);

  const run = useMutation({
    mutationFn: async () => {
      const r = await apiFetch('/api/ai-analysis/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? 'Не удалось запустить анализ');
      return j as { id: number };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-analysis-client', qs] }),
  });
  const feedback = useMutation({
    mutationFn: async (v: { id: number; feedback: 'useful' | 'inaccurate'; note?: string }) => {
      const r = await apiFetch(`/api/ai-analysis/${v.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
      if (!r.ok) throw new Error('Не удалось сохранить отзыв');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-analysis-client', qs] }),
  });

  const quotes = useMemo(() => new Map((lastDone?.quotes ?? []).map(q => [q.quote, q])), [lastDone]);
  const sections = useMemo(() => splitSections(lastDone?.reportMd ?? ''), [lastDone]);

  if (client.isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загружаем звонки…</div>;
  if (client.error || !client.data) return <div className="text-sm text-[var(--color-negative)]">{client.error instanceof Error ? client.error.message : 'Ошибка'}</div>;

  const { calls, quota } = client.data;
  const withText = calls.filter(c => c.hasText).length;
  const completed = calls.filter(c => c.result === 'completed').length;
  const newSince = lastDone ? calls.filter(c => c.hasText && c.calledAt > lastDone.createdAt).length : 0;
  const quotaLeft = Math.max(0, quota.max - quota.used);
  const shownJob = job.data ?? active;
  const failed = latest?.status === 'error' ? latest : null;
  const goQuote = (q: QuoteCheck) => {
    if (!q.callId) return;
    setOpenCall(q.callId);
    requestAnimationFrame(() => document.getElementById(`ai-call-${q.callId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  const copyMemo = async () => {
    if (!lastDone) return;
    try { await navigator.clipboard.writeText(memoText(lastDone)); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* нет доступа к буферу */ }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Сводка и запуск */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[var(--color-border)] p-3">
        <div className="min-w-0 flex-1 text-[13px]">
          <div className="font-semibold">Звонков с заказчиком: {calls.length}</div>
          <div className="text-[var(--color-text-muted)]">
            Состоялось {completed}, расшифровано {withText}
            {lastDone && <> · анализ от {fmtDT(lastDone.createdAt)}{newSince > 0 && <b className="text-[var(--color-text)]"> · с тех пор +{newSince} звонков</b>}</>}
          </div>
        </div>
        {withText > 0 && !active && (
          <button type="button" disabled={run.isPending || quotaLeft === 0} onClick={() => run.mutate()}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-[13.5px] font-semibold text-white disabled:opacity-50">
            {run.isPending ? 'Запускаю…' : lastDone ? 'Обновить анализ' : 'Запустить анализ'}
          </button>
        )}
        <div className="basis-full text-[11.5px] text-[var(--color-text-muted)]">
          Анализ займёт около минуты, вкладку можно закрыть — отчёт сохранится. Осталось запусков сегодня: {quotaLeft} из {quota.max}.
          Телефоны и адреса перед отправкой модели вырезаются.
        </div>
      </div>
      {run.error && <div className="text-sm text-[var(--color-negative)]">{run.error.message}</div>}

      {/* Монолитик */}
      {withText === 0 && (
        <MonolitikHelper pose="sleep" title="Анализировать пока нечего" text="У заказчика нет расшифрованных звонков: короткие разговоры и недозвоны не расшифровываются." closable={false} />
      )}
      {shownJob && (shownJob.status === 'queued' || shownJob.status === 'running') && (
        <MonolitikHelper pose={shownJob.phase === 'collecting' || shownJob.status === 'queued' ? 'think' : 'work'}
          title="Проверяю звонки…" text={PHASE_TEXT[shownJob.phase ?? shownJob.status] ?? PHASE_TEXT.thinking}
          progress="indeterminate" closable={false} />
      )}
      {failed && !active && (
        <MonolitikHelper pose="alert" title="Анализ не получился" text={failed.error ?? 'Неизвестная ошибка'} closable={false} />
      )}
      {lastDone && !active && !failed && (
        <MonolitikHelper pose="done" title="Отчёт готов"
          text={`Прочитал ${lastDone.callsCount ?? withText} разговоров. Цитаты с ✓ найдены в звонках — по клику откроется место.`}
          actions={
            <button type="button" onClick={copyMemo} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-3 text-[13px]">
              {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Скопировано' : 'Скопировать памятку'}
            </button>
          } />
      )}

      {/* Отчёт */}
      {lastDone && (
        <div className="flex flex-col gap-2.5">
          {SECTIONS.map(s => {
            const md = sections.get(s.n);
            if (!md) return null;
            return (
              <section key={s.n} className={`min-w-0 rounded-xl border p-3 ${s.tone === 'danger' ? 'border-[color-mix(in_srgb,var(--color-negative)_30%,var(--color-border))]' : 'border-[var(--color-border)]'}`}>
                <h3 className="mb-2 text-[14px] font-bold">{s.title}</h3>
                <SectionBody md={md} quotes={quotes} onQuote={goQuote} danger={s.tone === 'danger'} />
              </section>
            );
          })}
          <div className="text-[11.5px] text-[var(--color-text-muted)]">
            Это мнение модели по автоматическим расшифровкам — в них бывают ошибки распознавания и перепутанные роли. Нарушения перед разбором с менеджером проверьте по записи звонка.
            {' '}Модель {lastDone.model ?? '—'}, промпт {lastDone.promptVersion}{lastDone.costRub !== null ? `, ${lastDone.costRub} ₽` : ''}. Запустил(а): {lastDone.createdByName ?? lastDone.createdBy}.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px]">Отчёт полезен?</span>
            <button type="button" onClick={() => feedback.mutate({ id: lastDone.id, feedback: 'useful' })}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-[13px] ${lastDone.feedback === 'useful' ? 'border-[var(--color-positive)] text-[var(--color-positive)]' : 'border-[var(--color-border)]'}`}>
              <ThumbsUp size={14} />Полезно
            </button>
            <button type="button" onClick={() => feedback.mutate({ id: lastDone.id, feedback: 'inaccurate', note })}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-[13px] ${lastDone.feedback === 'inaccurate' ? 'border-[var(--color-negative)] text-[var(--color-negative)]' : 'border-[var(--color-border)]'}`}>
              <ThumbsDown size={14} />Неточно
            </button>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Что не так (необязательно)"
              className="min-h-11 min-w-0 flex-1 basis-56 rounded-lg border border-[var(--color-border)] bg-transparent px-3 text-base sm:text-sm" />
          </div>
          {lastDone.feedbackNote && <div className="text-[12px] text-[var(--color-text-muted)]">Отзыв: {lastDone.feedbackNote}</div>}
        </div>
      )}

      {/* Звонки */}
      {withText > 0 && (
        <section className="min-w-0 rounded-xl border border-[var(--color-border)] p-3">
          <h3 className="mb-1 text-[14px] font-bold">Расшифровки · {withText}</h3>
          <div className="mb-1 text-[11.5px] text-[var(--color-text-muted)]">Свежие сверху. Подсвечены места, которые цитирует отчёт.</div>
          <CallsList key={openCall ?? 'none'} qs={qs} calls={calls} openId={openCall} highlights={lastDone?.quotes ?? []} />
        </section>
      )}
    </div>
  );
}

