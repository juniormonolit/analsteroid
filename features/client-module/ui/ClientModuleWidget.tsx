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

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/client/apiFetch';
import { type ClientModuleData } from '../engine/types';
import { ClientBar } from './parts';
import { OverviewTab } from './OverviewTab';
import { DealsTab } from './DealsTab';
import { ObjectsTab } from './ObjectsTab';
import { CallsTab, ManagersBlock, PurchasesTab } from './HistoryTabs';
import { DealOpenerContext } from './dealLink';
import { AiAnalysisTab, useAiAnalysisAccess } from '@/features/ai-analysis/ui/AiAnalysisTab';
import { ClientQuestionnaire } from '@/features/questionnaires/ui/ClientQuestionnaire';
import { useAppMode } from '@/lib/hooks/useAppMode';
import { BitrixLink, CardHeader, TabsRibbon } from './CardHeader';

export type ClientCardTab = 'overview' | 'deals' | 'purchases' | 'objects' | 'calls' | 'questionnaire' | 'ai';
type Tab = ClientCardTab;

export function ClientModuleWidget({ contactId, companyId, onDealOpen, initialTab, onTabChange, stickyHeader = false, headerExtra }: {
  contactId?: string; companyId?: string;
  /** С какой вкладки открыть (канбан повторных: значок разбора → сразу «ИИ-анализ»). */
  initialTab?: ClientCardTab;
  /** В приложении: открыть сделку карточкой Монолитики. Нет — ссылки ведут в Битрикс. */
  onDealOpen?: (dealId: number) => void;
  /** Смена вкладки — наружу (канбан пишет её в адрес: ссылка на карточку с открытой вкладкой, владелец 23.10). */
  onTabChange?: (tab: ClientCardTab) => void;
  /** Закреплённая шапка (выдвижная панель: прокрутка внутри неё, data-card-scroll). */
  stickyHeader?: boolean;
  /** Главное действие раздела, откуда открыли (канбан) — в строке статуса шапки. */
  headerExtra?: React.ReactNode;
}) {
  const { isBitrixIframe } = useAppMode();
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
  const [tab, setTabState] = useState<Tab>(initialTab ?? 'overview');
  const setTab = (t: Tab) => { setTabState(t); onTabChange?.(t); };
  const initialTabRef = useRef(initialTab);
  initialTabRef.current = initialTab;
  // «ИИ-анализ» — только у кого есть право (решение владельца 22.10: «видят ТОЛЬКО РОПЫ»):
  // без права API отдаёт 403 и вкладки нет. Во вкладке Битрикса сессии Монолитики нет — тоже нет.
  const ai = useAiAnalysisAccess(qs, !isBitrixIframe);
  const [focusObject, setFocusObject] = useState<string | null>(null);
  const [editClient, setEditClient] = useState(0);
  const [dealsFilter, setDealsFilter] = useState<{ object?: string; n: number }>({ n: 0 });
  // Другой клиент — сброс; вкладка снаружи (адрес) поменялась — только вкладка, без сброса фильтров объекта/сделок.
  useEffect(() => { setTabState(initialTabRef.current ?? 'overview'); setFocusObject(null); setDealsFilter({ n: 0 }); }, [qs]);
  useEffect(() => { if (initialTab) setTabState(initialTab); }, [initialTab]);

  if (!qs) return null;
  if (isLoading) return <SlowLoading onRetry={() => void refetch()} />;
  if (error || !data) return <div className="p-4 text-sm" style={{ color: 'var(--color-negative, #e03131)' }}>{error instanceof Error ? error.message : 'Ошибка загрузки'}</div>;

  // Счётчики — отдельно от названия (лента вкладок, аудит 23.10).
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'overview', label: 'Обзор' },
    { key: 'deals', label: 'Сделки и задачи', count: data.deals.length },
    { key: 'purchases', label: 'Покупки', count: data.deals.filter(d => d.deliveredAt).length },
    { key: 'objects', label: 'Объекты', count: data.objects.length },
    { key: 'calls', label: 'Звонки' },
    // Анкета по товарным группам (миграция 249, владелец 23.10): ответы менеджера и «по разговорам».
    { key: 'questionnaire', label: 'Анкета' },
    ...(ai.allowed ? [{ key: 'ai' as const, label: 'ИИ-анализ' }] : []),
  ];

  return (
    <DealOpenerContext.Provider value={onDealOpen ?? null}>
    <div className="flex min-w-0 flex-col gap-3">
      {/* Шапка (аудит 23.10): имя · тип · менеджер · статус и вкладки закреплены; блок клиента (тип, заметка) —
          под ней и уезжает при прокрутке. Во вкладке Битрикса — без закрепления и без «Битрикс ↗». */}
      <CardHeader data={data} sticky={stickyHeader && !isBitrixIframe} extra={headerExtra}
        actions={isBitrixIframe ? undefined : <BitrixLink data={data} />}
        tabs={<TabsRibbon tabs={tabs} active={tab} onChange={setTab} />}>
        {tab === 'overview' && <ClientBar data={data} params={params} openSignal={editClient} />}
      </CardHeader>

      {tab === 'overview' && <OverviewTab data={data} params={params} onEditClient={() => setEditClient(n => n + 1)}
        onOpenObject={k => { setFocusObject(k || null); setTab('objects'); }}
        onOpenDeals={f => { setDealsFilter(prev => ({ object: f.object, n: prev.n + 1 })); setTab('deals'); }} />}
      {tab === 'deals' && <DealsTab key={dealsFilter.n} data={data} params={params} qs={qs} initialObject={dealsFilter.object ?? null} />}
      {tab === 'objects' && <ObjectsTab data={data} params={params} focus={focusObject} onOpenDeals={k => { setDealsFilter(prev => ({ object: k, n: prev.n + 1 })); setTab('deals'); }} />}
      {tab === 'purchases' && <PurchasesTab qs={qs} card={data} />}
      {tab === 'calls' && <CallsTab qs={qs} />}
      {tab === 'questionnaire' && (
        <ClientQuestionnaire params={params}
          shippedGroups={[...new Set(data.deals.filter(d => d.deliveredAt).sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!)).flatMap(d => d.groups))]}
          offeredGroups={data.recommendations.client.map(r => r.group)} />
      )}
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
