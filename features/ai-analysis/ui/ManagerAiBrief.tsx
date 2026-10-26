'use client';
// «ИИ-анализ» для менеджера (владелец 26.10): только разделы про заказчика из последнего разбора — кто он, объекты,
// что нужно дальше, риски и договорённости, памятка. Без запуска, без оценки менеджера и нарушений, без звонков и
// расшифровок (сервер их не отдаёт: engine/managerBrief.ts). Работает и во вкладке Битрикса (пропуск карточки).
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/client/apiFetch';
import type { ManagerBrief } from '../engine/managerBrief';

export function useManagerBrief(qs: string, enabled: boolean) {
  return useQuery<ManagerBrief | null>({
    queryKey: ['client-ai-brief', qs],
    enabled: enabled && !!qs,
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card/ai-brief?${qs}`);
      if (!r.ok) return null;
      return ((await r.json()) as { brief: ManagerBrief | null }).brief;
    },
    staleTime: 5 * 60_000,
  });
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

export function ManagerAiBrief({ brief }: { brief: ManagerBrief }) {
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
