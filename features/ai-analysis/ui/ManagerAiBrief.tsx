'use client';
// «ИИ-анализ» для менеджера (владелец 26.10): только разделы про заказчика из последнего разбора — кто он, объекты,
// что нужно дальше, риски и договорённости, памятка. Без запуска, без оценки менеджера и нарушений, без звонков и
// расшифровок (сервер их не отдаёт: engine/managerBrief.ts). Работает и во вкладке Битрикса (пропуск карточки).
// «Запросить разбор» (26.10): разбора не было или есть разговоры, не попавшие в прошлый разбор — менеджер просит,
// РОП видит запрос в канбане (индикатор, фильтр, «Сегодня») и запускает.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import type { ManagerBrief } from '../engine/managerBrief';
import type { AiRequestState } from '../engine/requests';

export interface BriefPayload { brief: ManagerBrief | null; request: AiRequestState | null }

export function useManagerBrief(qs: string, enabled: boolean) {
  return useQuery<BriefPayload | null>({
    queryKey: ['client-ai-brief', qs],
    enabled: enabled && !!qs,
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card/ai-brief?${qs}`);
      if (!r.ok) return null;
      return (await r.json()) as BriefPayload;
    },
    staleTime: 60_000,
  });
}

/** Показывать вкладку менеджеру: есть разбор, или можно запросить, или уже запрошено. */
export const briefTabVisible = (d: BriefPayload | null | undefined) => !!d && (!!d.brief || !!d.request?.canRequest || !!d.request?.pending);

const plural = (n: number, a: string, b: string, c: string) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

function RequestBlock({ qs, params, req }: { qs: string; params: Record<string, string>; req: AiRequestState }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await apiFetch('/api/modules/client-card/ai-brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...params, comment }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
      await qc.invalidateQueries({ queryKey: ['client-ai-brief', qs] });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  if (req.pending) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-dashed border-[var(--color-accent)] p-3 text-[13px]">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
        <div className="min-w-0">
          <div className="font-semibold text-[var(--color-text)]">Разбор запрошен — {req.pending.by}, {new Date(req.pending.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' })}</div>
          <div className="text-[var(--color-text-muted)]">РОП увидит запрос в канбане и запустит разбор. Готовый появится здесь.</div>
          {req.pending.comment && <div className="mt-1 italic text-[var(--color-text-secondary)]">«{req.pending.comment}»</div>}
        </div>
      </div>
    );
  }
  if (!req.canRequest) return null;
  const why = req.lastAnalysisAt
    ? `После прошлого разбора ${req.freshCalls} ${plural(req.freshCalls, 'новый разговор', 'новых разговора', 'новых разговоров')} — в разбор они не попали.`
    : `Разбора по заказчику ещё не было, разговоров за год — ${req.freshCalls}.`;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] p-3 text-[13px]">
      <div className="flex items-start gap-2">
        <Sparkles size={16} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
        <span className="min-w-0 text-[var(--color-text-secondary)]">{why} Можно попросить РОПа сделать разбор: что заказчику нужно, о чём договаривались, с чего зайти.</span>
      </div>
      <input value={comment} onChange={e => setComment(e.target.value)} maxLength={500} placeholder="Зачем нужен (необязательно): «звоню в четверг, не помню, о чём договаривались»"
        className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-base text-[var(--color-text)] sm:text-sm" />
      {err && <p className="text-[var(--color-negative)]">{err}</p>}
      <button type="button" onClick={send} disabled={busy}
        className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg bg-[var(--color-accent)] px-4 font-semibold text-white disabled:opacity-60">
        <Sparkles size={14} /> {busy ? 'Отправляю…' : 'Запросить разбор'}
      </button>
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[0].startsWith('**') ? <b key={k++}>{m[0].slice(2, -2)}</b> : <i key={k++}>{m[0].slice(1, -1)}</i>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function Body({ md }: { md: string }) {
  return (
    <div className="flex flex-col gap-1.5 text-[14px] leading-relaxed sm:text-[13.5px]">
      {md.split('\n').map(l => l.trim()).filter(Boolean).map((line, i) => {
        const bullet = /^[-*•—]\s+/.test(line), num = /^\d+[.)]\s+/.test(line);
        const body = line.replace(/^[-*•—]\s+|^\d+[.)]\s+/, '');
        return (
          <div key={i} className="flex min-w-0 gap-2">
            {(bullet || num) && <span className="shrink-0 text-[var(--color-text-muted)]">{num ? `${line.match(/^\d+/)![0]}.` : '•'}</span>}
            <div className="min-w-0 break-words"><Inline text={body} /></div>
          </div>
        );
      })}
    </div>
  );
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Moscow' });

export function ManagerAiBrief({ data, qs, params }: { data: BriefPayload; qs: string; params: Record<string, string> }) {
  const brief = data.brief;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {data.request && <RequestBlock qs={qs} params={params} req={data.request} />}
      {brief && <BriefBody brief={brief} />}
    </div>
  );
}

function BriefBody({ brief }: { brief: ManagerBrief }) {
  const memo = brief.sections.find(s => s.n === 8);
  const rest = brief.sections.filter(s => s.n !== 8);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-[12.5px] text-[var(--color-text-muted)]">Разбор разговоров от {fmt(brief.createdAt)}. Его готовит ИИ по звонкам — проверяйте в разговоре, а важное записывайте в сделку и анкету, как обычно.</p>
      {memo && (
        <section className="rounded-xl border border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_6%,transparent)] p-3">
          <h3 className="mb-1.5 text-[13px] font-bold text-[var(--color-text)]">Перед звонком</h3>
          <Body md={memo.md} />
        </section>
      )}
      {rest.map(s => (
        <section key={s.n} className="rounded-xl border border-[var(--color-border)] p-3">
          <h3 className="mb-1.5 text-[13px] font-bold text-[var(--color-text)]">{s.title}</h3>
          <Body md={s.md} />
        </section>
      ))}
    </div>
  );
}
