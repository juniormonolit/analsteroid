'use client';
// Модуль «Карточка клиента» (ТЗ владельца 13.10) — сам виджет. Один и тот же в
// «Ещё → Модули» (превью для админов) и во вкладке карточки контакта/компании
// Битрикса (/bx/client-card). Самодостаточен: на вход только ID клиента.
//
// v3 (20.10): ЕДИНАЯ карточка клиента — она же открывается панелью в приложении
// (ClientCardDrawer) вместо карточки «Моих заказчиков»; добавлены «Покупки» (путь
// клиента), «Звонки» (лента по всем сделкам) и «Кто вёл» (HistoryTabs.tsx).
// v2 (13.10, вечер): «идеальная карточка» — соединение ТЗ, карточки «Моих
// заказчиков» и развёрнутой карточки Монолитики; табы как в Монолитике, без
// звонков: «Обзор» (сводка, заметки, показатели, что предложить) → «Сделки»
// (таблица с фильтрами, раскрытие в товары) → «Объекты» (агрегат по объектам,
// лестница стадий, цепочка сделок). Юзкейс: менеджер зашёл и понял, что и когда
// заказчику отгружалось и что и куда хорошо бы предложить.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Building2, User } from 'lucide-react';
import { apiFetch } from '@/lib/client/apiFetch';
import { type ClientModuleData } from '../engine/types';
import { ClientBar } from './parts';
import { OverviewTab } from './OverviewTab';
import { DealsTab } from './DealsTab';
import { ObjectsTab } from './ObjectsTab';
import { CallsTab, ManagersBlock, PurchasesTab } from './HistoryTabs';
import { DealOpenerContext } from './dealLink';
import { AiAnalysisTab, useAiAnalysisAccess } from '@/features/ai-analysis/ui/AiAnalysisTab';

type Tab = 'overview' | 'deals' | 'purchases' | 'objects' | 'calls' | 'ai';

export function ClientModuleWidget({ contactId, companyId, onDealOpen }: {
  contactId?: string; companyId?: string;
  /** В приложении: открыть сделку карточкой Монолитики. Нет — ссылки ведут в Битрикс. */
  onDealOpen?: (dealId: number) => void;
}) {
  const params: Record<string, string> = companyId ? { companyId } : contactId ? { contactId } : {};
  const qs = new URLSearchParams(params).toString();
  const { data, isLoading, error, refetch } = useQuery<ClientModuleData>({
    queryKey: ['client-module', qs],
    enabled: qs.length > 0,
    queryFn: async () => {
      const r = await apiFetch(`/api/modules/client-card?${qs}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Ошибка загрузки');
      return j;
    },
  });
  const [tab, setTab] = useState<Tab>('overview');
  // «ИИ-анализ» — только у кого есть право (решение владельца 22.10: «видят ТОЛЬКО РОПЫ»):
  // без права API отдаёт 403 и вкладки нет. Во вкладке Битрикса сессии Монолитики нет — тоже нет.
  const ai = useAiAnalysisAccess(qs);
  const [focusObject, setFocusObject] = useState<string | null>(null);
  const [editClient, setEditClient] = useState(0);
  const [dealsFilter, setDealsFilter] = useState<{ object?: string; n: number }>({ n: 0 });
  useEffect(() => { setTab('overview'); setFocusObject(null); setDealsFilter({ n: 0 }); }, [qs]);

  if (!qs) return null;
  if (isLoading) return <SlowLoading onRetry={() => void refetch()} />;
  if (error || !data) return <div className="p-4 text-sm" style={{ color: 'var(--color-negative, #e03131)' }}>{error instanceof Error ? error.message : 'Ошибка загрузки'}</div>;

  const bitrixUrl = `https://td.monolit-crm.ru/crm/${data.clientType}/details/${data.clientId}/`;
  const title = data.name ?? (data.clientType === 'contact' ? `Контакт #${data.clientId}` : `Компания #${data.clientId}`);
  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'Обзор' },
    { key: 'deals', label: `Сделки · ${data.deals.length}` },
    { key: 'purchases', label: `Покупки · ${data.deals.filter(d => d.deliveredAt).length}` },
    { key: 'objects', label: `Объекты · ${data.objects.length}` },
    { key: 'calls', label: 'Звонки' },
    ...(ai.allowed ? [{ key: 'ai' as const, label: 'ИИ-анализ' }] : []),
  ];

  return (
    <DealOpenerContext.Provider value={onDealOpen ?? null}>
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          {data.clientType === 'company' ? <Building2 size={18} className="shrink-0 text-[var(--color-text-muted)]" /> : <User size={18} className="shrink-0 text-[var(--color-text-muted)]" />}
          <h2 className="min-w-0 break-words text-[17px] font-bold">{title}</h2>
          <a href={bitrixUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex min-h-9 items-center gap-1 text-[12px] text-[var(--color-accent)] hover:underline">
            Битрикс <ExternalLink size={12} />
          </a>
        </div>
        <ClientBar data={data} params={params} openSignal={editClient} />
      </div>

      {/* Вкладки — переносом, без горизонтальной ленты (правило 12 CLAUDE.md). */}
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-[var(--color-border)]">
        {tabs.map(t => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`-mb-px min-h-11 border-b-2 px-3 text-[13.5px] outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${tab === t.key ? 'border-[var(--color-accent)] font-semibold text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
            {t.label}
          </button>
        ))}
      </div>


      {tab === 'overview' && <OverviewTab data={data} params={params} onEditClient={() => setEditClient(n => n + 1)}
        onOpenObject={k => { setFocusObject(k || null); setTab('objects'); }}
        onOpenDeals={f => { setDealsFilter(prev => ({ object: f.object, n: prev.n + 1 })); setTab('deals'); }} />}
      {tab === 'deals' && <DealsTab key={dealsFilter.n} data={data} params={params} initialObject={dealsFilter.object ?? null} />}
      {tab === 'objects' && <ObjectsTab data={data} params={params} focus={focusObject} onOpenDeals={k => { setDealsFilter(prev => ({ object: k, n: prev.n + 1 })); setTab('deals'); }} />}
      {tab === 'purchases' && <PurchasesTab qs={qs} />}
      {tab === 'calls' && <CallsTab qs={qs} />}
      {tab === 'ai' && ai.allowed && <AiAnalysisTab qs={qs} params={params} cardClientType={data.profile.clientType} />}
      {tab === 'overview' && <ManagersBlock qs={qs} />}
    </div>
    </DealOpenerContext.Provider>
  );
}

/** Холодная загрузка карточки после выкатки доходит до ~30 с (Битрикс + сверки): без пояснения кажется,
 *  что всё зависло (аудит ИИ-анализа 23.10). Через 3 с — объяснение, через 20 с — «Повторить». */
function SlowLoading({ onRetry }: { onRetry: () => void }) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSec(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-col gap-2 p-4 text-sm text-[var(--color-text-muted)]">
      <div>Загружаем клиента…</div>
      {sec >= 3 && <div className="text-[12.5px]">Собираем сделки, объекты и звонки из Битрикса — иногда это занимает до минуты.</div>}
      {sec >= 20 && (
        <button type="button" onClick={() => { setSec(0); onRetry(); }}
          className="min-h-11 self-start rounded-lg border border-[var(--color-border)] px-3 text-[13px] text-[var(--color-text)]">Повторить</button>
      )}
    </div>
  );
}
