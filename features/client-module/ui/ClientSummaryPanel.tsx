'use client';
// Компактная «Карточка клиента» для узкой колонки чужого экрана (канбан больших чеков, владелец 18.11: «не нравится,
// что карточку клиента надо отдельно открывать — собрать всё на одном экране»; план Fable 18.11).
// Не ClientModuleWidget целиком: его вёрстка завязана на ширину вьюпорта, а не колонки (сетки md:/sm:, отступы шапки),
// и холодная загрузка до ~30 с. Здесь — сводка (имя, чипы статуса, «Сейчас», цифры) и мини-вкладки «Звонки / Сделки /
// ИИ-анализ», данные из того же кэша ['client-module', qs] — полная карточка потом открывается мгновенно.
// Сделки — ссылками в Битрикс (DealOpenerContext = null): карточка сделки Монолитики поверх Radix-модалки была бы мёртвой.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, ExternalLink, Lightbulb, User } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { fmtMoney } from '@/features/customers/ui/shared';
import { AiAnalysisTab, useAiAnalysisAccess } from '@/features/ai-analysis/ui/AiAnalysisTab';
import { type ClientModuleData, computeStats } from '../engine/types';
import { buildAdvice } from '../engine/advice';
import { Chip, Stat, StageChip, TabLoading, fmtD, shortGroup } from './parts';
import { statusChips, TabsRibbon } from './CardHeader';
import { CallTimingLine } from './CallTimingLine';
import { LastDealLine } from './LastDealLine';
import { CallsTab } from './HistoryTabs';
import { DealLink, DealOpenerContext } from './dealLink';
import type { ClientCardTab } from './ClientModuleWidget';

type MiniTab = 'summary' | 'calls' | 'deals' | 'ai';

/** Тот же запрос, что у ClientModuleWidget (общий кэш). */
export function useClientModule(qs: string, enabled = true) {
  return useQuery<ClientModuleData>({
    queryKey: ['client-module', qs],
    enabled: enabled && qs.length > 0,
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка загрузки');
      return j;
    },
  });
}

export function ClientSummaryPanel({ contactId, companyId, fallbackName, enabled = true, onOpenFull }: {
  contactId?: string | number | null;
  companyId?: string | number | null;
  /** Имя до загрузки (из задачи) — чтобы колонка не была пустой первые секунды. */
  fallbackName?: string | null;
  /** Грузить ли (на телефоне — при первом открытии вкладки «Клиент»). */
  enabled?: boolean;
  /** «Полная карточка» — вторично, своим окном. */
  onOpenFull?: (tab?: ClientCardTab) => void;
}) {
  const params: Record<string, string> = companyId ? { companyId: String(companyId) } : contactId ? { contactId: String(contactId) } : {};
  const qs = new URLSearchParams(params).toString();
  const q = useClientModule(qs, enabled);
  const ai = useAiAnalysisAccess(qs, enabled);
  const [tab, setTab] = useState<MiniTab>('summary');

  if (!qs) {
    return <p className="text-[13px] text-[var(--color-text-muted)]">{fallbackName ? `${fallbackName} — ` : ''}в сделке нет контакта или компании, карточку клиента не открыть.</p>;
  }
  const data = q.data;
  const title = data?.name ?? fallbackName ?? 'Клиент';
  const tabs: { key: MiniTab; label: string; count?: number }[] = [
    { key: 'summary', label: 'Сводка' },
    { key: 'calls', label: 'Звонки' },
    { key: 'deals', label: 'Сделки', count: data?.deals.length },
    ...(ai.allowed ? [{ key: 'ai' as const, label: 'ИИ-анализ' }] : []),
  ];

  return (
    <DealOpenerContext.Provider value={null}>
      <div className="flex min-w-0 flex-col gap-3 text-[13px]">
        <div className="flex min-w-0 items-start gap-2">
          {data?.clientType === 'company' || (!data && companyId) ? <Building2 size={17} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" /> : <User size={17} className="mt-0.5 shrink-0 text-[var(--color-text-muted)]" />}
          <h3 className="min-w-0 flex-1 break-words text-[15px] font-bold leading-snug" title={title}>{title}</h3>
          {onOpenFull && (
            <button type="button" onClick={() => onOpenFull(tab === 'summary' ? 'overview' : tab)}
              title="Вся карточка клиента: объекты, покупки, анкета"
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-2.5 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] sm:min-h-8">
              <ExternalLink size={12} /> Полная
            </button>
          )}
        </div>

        {q.isLoading && <TabLoading text="Загружаем клиента — сделки, объекты, звонки (до минуты после выкатки)…" />}
        {q.error && (
          <div className="flex flex-col gap-2 text-[var(--color-negative)]">
            <span>{q.error instanceof Error ? q.error.message : 'Ошибка загрузки'}</span>
            <button type="button" onClick={() => void q.refetch()} className="min-h-11 self-start rounded-md border border-[var(--color-border)] px-3 text-[var(--color-text)]">Повторить</button>
          </div>
        )}

        {data && (
          <>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {statusChips(data).map(c => <Chip key={c.key} tone={c.tone} title={c.title}>{c.text}</Chip>)}
            </div>
            <TabsRibbon tabs={tabs} active={tab} onChange={setTab} />
            {tab === 'summary' && <Summary data={data} />}
            {tab === 'calls' && <CallsTab qs={qs} />}
            {tab === 'deals' && <DealsList data={data} />}
            {tab === 'ai' && ai.allowed && <AiAnalysisTab qs={qs} params={params} cardClientType={data.profile.clientType} />}
          </>
        )}
      </div>
    </DealOpenerContext.Provider>
  );
}

function Summary({ data }: { data: ClientModuleData }) {
  const s = computeStats(data.deals);
  const advice = buildAdvice(data, shortGroup);
  const rec = data.recommendations.client.slice(0, 3);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="LTV" value={s.ltv ? fmtMoney(s.ltv) : '—'} hint="Сумма отгруженных сделок" />
        <Stat label="Отгрузок" value={s.shipped} sub={s.avgCheck ? `чек ${fmtMoney(s.avgCheck)}` : undefined} />
        <Stat label="Объектов" value={data.objects.length} />
      </div>
      <section className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] px-3 [&>*]:py-2">
        <CallTimingLine deals={data.deals} bare />
        <LastDealLine data={data} bare />
        {advice.map(a => (
          <div key={a.id} className="flex gap-2 leading-snug" style={a.alarm ? { color: 'var(--color-negative, #e03131)' } : undefined}>
            <Lightbulb size={14} className="mt-0.5 shrink-0 text-[var(--color-warning,#e8590c)]" />
            <span className="min-w-0">{a.text}</span>
          </div>
        ))}
      </section>
      {data.profile.note && (
        <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-bg-hover)] px-3 py-2 text-[12.5px]" title="Заметка о клиенте">{data.profile.note}</p>
      )}
      {rec.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Предложить клиенту</div>
          {rec.map(r => (
            <div key={r.group} className="min-w-0 leading-snug">
              <b>{shortGroup(r.group)}</b>{r.pct != null ? <span className="text-[var(--color-text-muted)]"> · {r.pct}%</span> : null}
              {r.ask && <span className="text-[var(--color-text-secondary)]"> — «{r.ask}»</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Сделки клиента списком (не DealsTab: его таблица и фильтры рассчитаны на ширину панели). */
function DealsList({ data }: { data: ClientModuleData }) {
  if (!data.deals.length) return <p className="text-[var(--color-text-muted)]">Сделок нет</p>;
  return (
    <ul className="flex min-w-0 flex-col divide-y divide-[var(--color-border)]">
      {data.deals.slice(0, 30).map(d => (
        <li key={d.dealId} className="flex min-w-0 flex-col gap-0.5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <DealLink dealId={d.dealId} className="min-w-0 flex-1 truncate text-left text-[var(--color-accent)] hover:underline">
              {shortGroup(d.topGroup) || d.name || `Сделка ${d.dealId}`}
            </DealLink>
            <span className="shrink-0 font-semibold tabular-nums">{fmtMoney(d.amount)}</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
            <StageChip s={d.stage} />
            <span>{fmtD(d.deliveredAt ?? d.soldAt ?? d.lostAt ?? d.createdAt)}</span>
            {d.managerName && <span className="truncate">· {d.managerName}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
