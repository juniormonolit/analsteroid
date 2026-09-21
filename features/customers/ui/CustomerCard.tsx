'use client';
// Карточка клиента (фича Серёги 01.08): широкий drawer поверх «Моих заказчиков»
// (паттерн DrilldownDrawer — панель справа с подложкой). Шапка/активные сделки/
// рекомендации приходят из уже посчитанной строки списка (ApiRow), остальное
// (таймлайн покупок, звонки, отказы, история отметок) — /api/customers/card.
// ПДн: телефонов нет by construction — звонить менеджер идёт в Битрикс по ссылке.

import { Fragment, useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Deal } from '@/features/reports/ui/DrilldownDrawer';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import dynamic from 'next/dynamic';
import { X, ExternalLink, Phone, MessageCircle, Ban, Pause, RotateCcw, ShieldAlert, MapPin } from 'lucide-react';

// DealCard — динамически: карточки ссылаются друг на друга (сделка → заказчик →
// сделка, задача 17.08), статический импорт в обе стороны дал бы цикл модулей.
const DealCard = dynamic(() => import('@/features/reports/ui/DealCard').then(m => m.DealCard), { ssr: false });
import type { CustomerCardData } from '@/features/customers/engine/card';
import { objectKey, type ParsedAddress } from '@/lib/bitrix/addressUtils';
import type { CustomerContact } from '@/features/customers/engine/contactTypes';
import { CONTACT_CHANNEL_LABELS } from '@/features/customers/engine/contactTypes';
import { windowLine } from './QueueBoard';
import {
  type ApiRow, REASON_LABELS, fmtMoney, fmtDate, daysAgo,
  clientBitrixUrl, dealBitrixUrl, clientDisplayName,
  CATEGORY_LABELS, CATEGORY_STYLE, MODIFIER_LABELS,
} from './shared';

const DAY_MS = 86_400_000;

function Chip({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'neg' | 'warn' | 'ok'; title?: string }) {
  const style = tone === 'neg'
    ? { color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' }
    : tone === 'warn'
      ? { color: 'var(--color-warning, #e8590c)', backgroundColor: 'color-mix(in srgb, var(--color-warning, #e8590c) 10%, transparent)' }
      : tone === 'ok'
        ? { color: 'var(--color-positive, #2f9e44)', backgroundColor: 'color-mix(in srgb, var(--color-positive, #2f9e44) 10%, transparent)' }
        : { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' };
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded px-1.5 py-px text-[11px] font-semibold" style={style} title={title}>
      {children}
    </span>
  );
}

// Полиш 01.08 (правка владельца через Серёгу «наведи порядок»): секции — карточки
// с фоном/отступами (та же оболочка, что везде в ЛК — ManagerTabs.tsx), а не голый
// капс-заголовок + текст встык с предыдущим блоком. hintIcon — маленькая «ⓘ» с
// тултипом вместо приписки текстом в заголовке (пример: «цикл повторки… (по базе)»).
function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        {title}
        {hint && <span title={hint} className="cursor-help normal-case tracking-normal opacity-70">ⓘ</span>}
      </div>
      {children}
    </section>
  );
}

// Плашка ключевой цифры шапки (сетка 2×2/4, вместо строки-простыни «покупок N из
// M сделок на сумму… средний чек…»): крупное число, мелкая серая подпись.
function StatTile({ label, value, sub, hint }: { label: string; value: React.ReactNode; sub?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5" title={hint}>
      <div className="text-[10px] leading-tight text-[var(--color-text-muted)]">{label}</div>
      <div className="text-[14px] font-bold leading-tight text-[var(--color-text)] tabular-nums whitespace-nowrap">{value}</div>
      {sub && <div className="text-[10px] leading-tight text-[var(--color-text-muted)]">{sub}</div>}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  snooze: '⏸ Отложен', no_call: '🚫 Не звонить', wake: '⏰ Возвращён из спящих', clear: '↩ Отметка снята',
};

// ── «Путь клиента» (задача владельца 17.08): дерево развития заказчика ────────
// Читается сверху вниз: с чего клиент ЗАШЁЛ (категория КЦ первой сделки против
// фактически проданного), как покупки шли дальше (все группы каждой сделки с
// суммами по позициям), чем ритм закончился, и ВИЛКА вероятностей следующей
// покупки (матрица переходов «купил X → следом покупают Y» — та же, что в
// «Что предложить»). Внизу — клиентские показатели, посчитанные из этой же
// цепочки (LTV = сумма отгрузок и т.д. — определения те же, что в метриках
// сущности «Клиент»).
function fmtGap(days: number): string {
  if (days < 1) return 'в тот же день';
  if (days < 60) return `через ${Math.round(days)} дн.`;
  return `через ${(days / 30.44).toFixed(1).replace('.0', '')} мес.`;
}

// Адрес объекта строкой (задача владельца 21.09). Координат может не быть —
// тогда просто текст без ссылки на карту.
function AddressLine({ a, compact }: { a: ParsedAddress | null; compact?: boolean }) {
  if (!a?.address) return null;
  return (
    <div className={`mt-0.5 flex items-start gap-1 ${compact ? 'text-[11px]' : 'text-[11.5px]'} text-[var(--color-text-muted)]`}>
      <MapPin size={11} className="mt-[2px] shrink-0" />
      <span className="min-w-0 flex-1 break-words" title={a.address}>{a.address}</span>
      {a.lat !== null && a.lon !== null && (
        <a href={`https://yandex.ru/maps/?pt=${a.lon},${a.lat}&z=16&l=map`} target="_blank" rel="noopener noreferrer"
          title="Открыть на карте" className="tap-target shrink-0 text-[var(--color-accent)] hover:underline">
          <ExternalLink size={11} className="inline" />
        </a>
      )}
    </div>
  );
}

function JourneyTab({ purchases, loading, recommend, onDealOpen }: {
  purchases: { dealId: number; dealName: string | null; amount: number; deliveredAt: string;
    headGroup: string | null; kcCategory: string | null; groups: { name: string | null; sum: number }[] }[];
  loading: boolean;
  recommend: ApiRow['recommend'];
  onDealOpen: (id: number) => void;
}) {
  if (loading) {
    return <div className="text-sm text-[var(--color-text-muted)]">Собираем путь клиента…</div>;
  }
  if (purchases.length === 0) {
    return <div className="text-sm text-[var(--color-text-muted)]">Отгрузок ещё не было — путь начнётся с первой покупки.</div>;
  }

  const first = purchases[0];
  const last = purchases[purchases.length - 1];
  const statItems = (recommend?.items ?? []).filter(i => !i.manual);
  const ltv = purchases.reduce((s, p) => s + p.amount, 0);
  const distinctGroups = new Set(purchases.flatMap(p => p.groups.map(g => g.name ?? 'Без группы'))).size;
  const firstMs = new Date(first.deliveredAt).getTime();
  const lastMs = new Date(last.deliveredAt).getTime();
  const freqDays = purchases.length >= 2 ? (lastMs - firstMs) / DAY_MS / (purchases.length - 1) : null;
  const daysSince = (Date.now() - lastMs) / DAY_MS;
  const lifetimeMonths = (lastMs - firstMs) / DAY_MS / 30.44;
  const churnPct = freqDays && freqDays > 0 ? Math.round((daysSince / freqDays) * 100) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Вход: с чего зашёл (КЦ первой сделки) против фактически проданного. */}
      <Section title="Как зашёл" hint="Категория КЦ первой сделки — то, по чему клиент пришёл; группы по позициям — что реально продали">
        <div className="text-[12.5px] flex flex-col gap-0.5">
          <div>Зашёл по КЦ: <b className="text-[var(--color-text)]">{first.kcCategory ?? '—'}</b></div>
          <div>Продали: <b className="text-[var(--color-text)]">{first.groups.map(g => g.name ?? 'Без группы').join(', ') || first.headGroup || '—'}</b></div>
        </div>
      </Section>

      <Section title={`Цепочка покупок · ${purchases.length}`} hint="Каждая отгрузка со всеми товарными группами и суммами по позициям; между покупками — прошедшее время">
        <div className="flex flex-col">
          {purchases.map((p, i) => {
            const gapDays = i === 0 ? null : (new Date(p.deliveredAt).getTime() - new Date(purchases[i - 1].deliveredAt).getTime()) / DAY_MS;
            return (
              <Fragment key={p.dealId}>
                {gapDays !== null && (
                  <div className="pl-[7px] py-0.5 flex items-center gap-2">
                    <span className="block w-px h-4 bg-[var(--color-border-strong)]" />
                    <span className="text-[11px] text-[var(--color-text-muted)]">{fmtGap(gapDays)}</span>
                  </div>
                )}
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[var(--color-text-muted)] tabular-nums shrink-0">{fmtDate(p.deliveredAt)}</span>
                    <button onClick={() => onDealOpen(p.dealId)} className="text-[11px] font-mono text-[var(--color-accent)] hover:underline shrink-0">#{p.dealId}</button>
                    {i === 0 && p.kcCategory && (
                      <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft,#e7f1fb)] text-[var(--color-accent)] shrink-0" title="Категория КЦ — с чего клиент зашёл">
                        КЦ: {p.kcCategory}
                      </span>
                    )}
                    <span className="flex-1" />
                    <span className="text-[12.5px] font-bold text-[var(--color-text)] tabular-nums whitespace-nowrap">{fmtMoney(p.amount)}</span>
                  </div>
                  {/* Все группы сделки с суммами по позициям (правка владельца:
                      «если товарных групп несколько — отображать все и суммы») */}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.groups.length === 0 ? (
                      <span className="text-[11px] text-[var(--color-text-muted)]">{p.headGroup ?? 'Без товарных строк'}</span>
                    ) : p.groups.map(g => (
                      <span key={g.name ?? '—'} className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-hover)] text-[var(--color-text)]">
                        {g.name ?? 'Без группы'}
                        <b className="tabular-nums text-[var(--color-text-muted)]">{fmtMoney(g.sum)}</b>
                      </span>
                    ))}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      </Section>

      {/* Вилка вероятностей следующей покупки — финал дерева (та же матрица
          переходов, что «Что предложить», проценты по последним купленным группам). */}
      {/* Здесь именно ВЕРОЯТНОСТЬ, а не совет: ручные приоритеты из настроек
          (21.09) отфильтрованы — им место в «Что предложить», а в этой секции
          они выглядели бы строкой «—%» посреди матрицы переходов. */}
      <Section title="Вероятная следующая покупка" hint="Матрица переходов «купил X → следом покупают Y» по истории продаж всей базы">
        {!recommend || statItems.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Статистики переходов пока нет.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {recommend.fallback && <div className="text-[11px] text-[var(--color-text-muted)]">по группе клиента мало статистики — общий топ по базе</div>}
            {statItems.slice(0, 5).map(it => (
              <div key={it.group} className="flex items-center gap-2 text-[12.5px]">
                <span className="font-semibold tabular-nums text-[var(--color-accent)] w-10 shrink-0">{it.pct}%</span>
                <div className="flex-1 h-1.5 rounded bg-[var(--color-bg-hover)] overflow-hidden max-w-[220px]">
                  <div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.min(100, it.pct)}%` }} />
                </div>
                <span className="truncate">{it.group}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Показатели клиента" hint="Считаются из цепочки выше — те же определения, что у метрик сущности «Клиент»">
        <div className="flex flex-wrap gap-2">
          <StatTile label="LTV (вся история)" value={fmtMoney(ltv)} hint="Сумма всех отгрузок клиента" />
          <StatTile label="Покупок" value={String(purchases.length)} />
          <StatTile label="Средний чек" value={fmtMoney(Math.round(ltv / purchases.length))} />
          <StatTile label="Категорий куплено" value={String(distinctGroups)} />
          <StatTile label="Частота заказов" value={freqDays ? `${Math.round(freqDays)} дн.` : '—'} hint="Средний интервал между отгрузками" />
          <StatTile label="Дней с последней" value={`${Math.round(daysSince)}`} />
          <StatTile label="Время жизни" value={lifetimeMonths >= 1 ? `${lifetimeMonths.toFixed(1)} мес.` : '< месяца'} hint="От первой отгрузки до последней" />
          <StatTile label="Риск ухода" value={churnPct !== null ? `${churnPct}%` : '—'} hint="Дней с последней ÷ частота × 100: больше 100% — пора звонить" />
        </div>
      </Section>
    </div>
  );
}

/** Рендер в <body> — панель не должна зависеть от transform предка (см. DealCard). */
function usePortalToBody(): (node: React.ReactNode) => React.ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return node => (mounted && typeof document !== 'undefined' ? createPortal(node, document.body) : null);
}

export function CustomerCard({ row, managerId, isSelf, onClose, markControls, zIndex }: {
  row: ApiRow;
  managerId: string;
  isSelf: boolean;
  onClose: () => void;
  /** Кнопки «Связался»/«Отложить»/«Исключить»/«Вернуть» — те же контролы, что в списке. */
  markControls: React.ReactNode;
  /** Поверх чего открылись: из карточки сделки (z-70) нужен z выше её дефолтных 50. */
  zIndex?: number;
}) {
  const portal = usePortalToBody();
  const [openDealId, setOpenDealId] = useState<number | null>(null);
  // Вкладки по смыслу (правка владельца 17.09: «раздели всю инфу по смыслу на табы,
  // чтобы сделки не скроллились в щёлке»): Обзор — что делать сейчас; Сделки —
  // вся история сделок целиком; Покупки — путь клиента по товарным группам;
  // Контакты — звонки, ручные отметки «Связался», отметки и запросы РОПу одной лентой.
  type CardTab = 'overview' | 'deals' | 'journey' | 'contacts';
  const [cardTab, setCardTab] = useState<CardTab>('overview');

  const dealsQs = new URLSearchParams({
    from: '2015-01-01T00:00:00.000Z',
    to: new Date().toISOString(),
    scope: 'all',
    ...(row.clientKey.startsWith('k') ? { companyId: String(row.clientId) } : { contactId: String(row.clientId) }),
  }).toString();
  const { data: dealsData } = useQuery<{ deals: Deal[]; total_count: number }>({
    queryKey: ['customer-deals', row.clientKey],
    queryFn: () => fetch(`/api/reports/deals?${dealsQs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  const clientDeals = dealsData?.deals ?? [];

  interface JourneyPurchase {
    dealId: number; dealName: string | null; amount: number; deliveredAt: string;
    headGroup: string | null; kcCategory: string | null;
    groups: { name: string | null; sum: number }[];
  }
  const journeyQs = row.clientKey.startsWith('k') ? `companyId=${row.clientId}` : `contactId=${row.clientId}`;
  const { data: journey, isLoading: journeyLoading } = useQuery<{ purchases: JourneyPurchase[] }>({
    queryKey: ['customer-journey', row.clientKey],
    enabled: cardTab === 'journey',
    queryFn: () => fetch(`/api/customers/journey?${journeyQs}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  const { data, isLoading, isError } = useQuery<CustomerCardData>({
    queryKey: ['customer-card', row.clientKey, isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = new URLSearchParams({ clientKey: row.clientKey });
      if (!isSelf) qs.set('bitrixId', managerId);
      const res = await fetch(`/api/customers/card?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  // Адреса объектов (задача владельца 21.09: «чтобы было видно по его
  // объектам»). Один запрос на все сделки, которые карточка показывает:
  // активные, вся история и покупки. Адрес живёт в Битриксе
  // (UF_ADDRESS_COORDS) и кэшируется в deal_addresses — показ прогревает кэш.
  const addrIds = useMemo(() => {
    const ids = new Set<number>();
    for (const d of row.activeDeals) ids.add(d.dealId);
    for (const d of clientDeals) ids.add(d.deal_id);
    for (const d of (data?.timeline ?? [])) ids.add(d.dealId);
    return [...ids].slice(0, 200);
  }, [row.activeDeals, clientDeals, data?.timeline]);
  const { data: addrData } = useQuery<{ addresses: Record<string, ParsedAddress> }>({
    queryKey: ['customer-deal-addresses', row.clientKey, addrIds.length],
    enabled: addrIds.length > 0,
    queryFn: () => fetch(`/api/deals/addresses?ids=${addrIds.join(',')}`).then(r => r.json()),
    staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false,
  });
  const addrOf = (dealId: number): ParsedAddress | null => addrData?.addresses?.[String(dealId)] ?? null;
  // Сколько разных объектов: считаем по тем же адресам, что показываем. Сервер
  // присылает objects по всей истории заказчика (deal_addresses) — берём его,
  // а локальный расчёт нужен, пока список ещё грузится или на чужих ключах.
  const objectsCount = useMemo(() => {
    if (row.objects && row.objects > 0) return row.objects;
    const keys = new Set<string>();
    for (const a of Object.values(addrData?.addresses ?? {})) {
      const k = objectKey(a);
      if (k) keys.add(k);
    }
    return keys.size;
  }, [row.objects, addrData]);

  const { data: contactsData } = useQuery<{ items: CustomerContact[] }>({
    queryKey: ['customer-contacts', row.clientKey],
    queryFn: () => fetch(`/api/customers/contact?clientKey=${row.clientKey}`).then(r => r.json()),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });

  const status = row.mark?.kind === 'no_call' ? { label: '🚫 исключён', tone: 'neg' as const }
    : row.bucket === 'sleeping' ? { label: '💤 спящий', tone: 'muted' as const }
    : row.section === 'regular' ? { label: row.atRisk ? '⚠ постоянник под угрозой' : '★ постоянник', tone: row.atRisk ? 'neg' as const : 'ok' as const }
    : row.section === 'once' ? { label: 'купил один раз', tone: 'muted' as const }
    : { label: 'ещё не купил', tone: 'muted' as const };

  const avgCheck = row.dealsSold > 0 ? Math.round(row.sumSold / row.dealsSold) : null;
  const currentManager = row.managerHistory.find(m => String(m.managerId) === managerId) ?? row.managerHistory[0] ?? null;
  const w = windowLine(row);
  const timeline = data?.timeline ?? [];

  // «Следующий шаг» — одна человеческая фраза из очереди и рекомендации.
  const rec = row.recommend?.items?.[0] ?? null;
  const nextStep = (() => {
    const offer = rec ? ` Предложить: ${rec.group} (${rec.pct} % берут после такого заказа).` : '';
    // Строитель (21.09): у него следующая покупка привязана не к «окну» после
    // отгрузки, а к следующему объекту — и разговор правильнее начинать с него.
    if (objectsCount >= 2 && row.queue.queue !== 'rest') {
      return `Возит на ${objectsCount} разных объекта — похоже на строителя. Спросить про СЛЕДУЮЩИЙ объект: что за материал и когда закупка.${offer}`;
    }
    switch (row.queue.queue) {
      case 'window': return `Позвонить ${row.queue.daysLeft !== null && row.queue.daysLeft < 1 ? 'сегодня' : `в ближайшие ${Math.ceil(row.queue.daysLeft ?? 0)} дн.`} — окно повторной продажи ещё открыто, звонка после отгрузки не было.${offer}`;
      case 'missed': return `Окно упущено, но заказчик не потерян: позвонить, узнать, как зашёл материал, и что дальше по объекту.${offer}`;
      case 'faded': return `Постоянник перестал покупать: связь была, покупок нет. Выяснить, что изменилось — ушёл к конкуренту, объект закончился, недовольство.${offer}`;
      default:
        if (row.hasOpenOrder) return 'Есть проданная, но ещё не отгруженная сделка — довести её до отгрузки; допродажа — после закрытия текущего заказа.';
        return row.activeCount > 0 ? 'Есть активные сделки — двигать их; новых звонков по повторке не требуется.' : `Контакт после отгрузки был.${offer}`;
    }
  })();

  // Лента контактов: звонки + ручные отметки + отметки списка + запросы РОПу.
  type FeedItem = { at: string; icon: React.ReactNode; text: React.ReactNode; by?: string | null; tone?: 'neg' | 'ok' | 'muted' };
  const feed: FeedItem[] = [];
  for (const c of data?.callsList ?? []) {
    const good = c.durationSec > 20;
    feed.push({
      at: c.calledAt, icon: <Phone size={12} />, tone: good ? 'ok' : 'muted',
      text: <>{c.direction === 'inbound' ? 'Входящий' : 'Исходящий'} звонок · {c.durationSec > 0 ? `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}` : 'без ответа'}{c.dealId ? <> · <button onClick={() => setOpenDealId(c.dealId!)} className="text-[var(--color-accent)] hover:underline">#{c.dealId}</button></> : null}{good ? '' : ' · не засчитан как успешный (< 20 с)'}</>,
    });
  }
  for (const c of contactsData?.items ?? []) {
    feed.push({ at: c.contactedAt, icon: <MessageCircle size={12} />, tone: 'ok', by: c.createdBy, text: <>Связался · {CONTACT_CHANNEL_LABELS[c.channel]} — «{c.note}»</> });
  }
  for (const h of data?.markHistory ?? []) {
    feed.push({
      at: h.createdAt, by: h.createdBy, tone: h.action === 'no_call' ? 'neg' : 'muted',
      icon: h.action === 'snooze' ? <Pause size={12} /> : h.action === 'no_call' ? <Ban size={12} /> : <RotateCcw size={12} />,
      text: <>{ACTION_LABELS[h.action] ?? h.action}{h.action === 'snooze' && h.snoozeUntil ? ` до ${fmtDate(h.snoozeUntil)}` : ''}{h.reason ? ` · ${REASON_LABELS[h.reason]}` : ''}{h.comment ? ` · «${h.comment}»` : ''}</>,
    });
  }
  for (const e of data?.exclusions ?? []) {
    feed.push({
      at: e.createdAt, by: e.requestedBy, tone: e.status === 'approved' ? 'neg' : 'muted', icon: <ShieldAlert size={12} />,
      text: <>Запрос на исключение — «{e.reason}» · {e.status === 'pending' ? 'ждёт РОПа' : e.status === 'approved' ? `исключён (${e.decidedBy})` : `оставлен в работе (${e.decidedBy})`}{e.decisionComment ? ` · «${e.decisionComment}»` : ''}</>,
    });
  }
  feed.sort((a, b) => b.at.localeCompare(a.at));

  const TABS: { key: CardTab; label: string }[] = [
    { key: 'overview', label: 'Обзор' },
    { key: 'deals', label: `Сделки${dealsData ? ` · ${dealsData.total_count}` : ''}` },
    { key: 'journey', label: `Покупки${row.dealsDelivered ? ` · ${row.dealsDelivered}` : ''}` },
    { key: 'contacts', label: `Контакты${data ? ` · ${feed.length}` : ''}` },
  ];

  return portal(
    <div className="fixed inset-0 z-50 flex" style={zIndex ? { zIndex } : undefined}>
      <div className="hidden sm:block flex-1 min-w-[10%] bg-black/40 cursor-pointer" onClick={onClose} />
      <div className="w-full sm:w-[1240px] sm:max-w-[96vw] shrink-0 bg-[var(--color-bg)] flex flex-col shadow-2xl overflow-hidden">
        {/* Шапка: имя и статусы, менеджер, действия. */}
        <div className="px-4 sm:px-6 pt-3 pb-2 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <h2 className="text-lg font-bold text-[var(--color-text)] truncate max-w-[420px]" title={clientDisplayName(row)}>{clientDisplayName(row)}</h2>
                <Chip title={row.clientKey.startsWith('x') ? 'Юр.сделка без карточки компании в CRM — клиент определён по контакту-представителю' : undefined}>{row.clientType === 'contact' ? 'физ' : 'юр'}</Chip>
                {row.category && row.category !== 'none' && (
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-[12px] font-bold"
                    style={{ color: CATEGORY_STYLE[row.category].color, backgroundColor: CATEGORY_STYLE[row.category].bg }}
                    title={`Отгрузок ${row.dealsDelivered} на ${fmtMoney(row.sumDelivered)}, разных групп: ${row.distinctGroups}`}>
                    {row.category === 'key' && '🔑 '}{CATEGORY_LABELS[row.category]}
                  </span>
                )}
                {(row.modifiers ?? []).map(mod => (
                  <Chip key={mod} title={MODIFIER_LABELS[mod].hint}>
                    {MODIFIER_LABELS[mod].icon} {mod === 'builder' && row.objects ? `${row.objects} объекта(ов)` : MODIFIER_LABELS[mod].label}
                  </Chip>
                ))}
                <Chip tone={status.tone}>{status.label}</Chip>
                {row.pendingExclusion && <Chip title={`«${row.pendingExclusion.reason}» — ${row.pendingExclusion.requestedBy}`}>⏳ ждёт РОПа</Chip>}
                {row.snoozedActive && row.mark && <Chip title={`Отметил(а): ${row.mark.createdBy}, ${fmtDate(row.mark.createdAt)}`}>⏸ до {fmtDate(row.mark.snoozeUntil)}</Chip>}
                <a href={clientBitrixUrl(row)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-accent)] hover:underline whitespace-nowrap">
                  <ExternalLink size={12} /> Битрикс
                </a>
              </div>
              <div className="mt-0.5 text-[12px] text-[var(--color-text-muted)] truncate">
                Менеджер: <b className="text-[var(--color-text)]">{currentManager?.name ?? `#${managerId}`}</b>
                {row.prevManagerNames.length > 0 && <span title={`Ранее вёл(а): ${row.prevManagerNames.join(', ')}`}> · ранее: {row.prevManagerNames.join(', ')}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {markControls}
              <button onClick={onClose} className="tap-target w-7 h-7 flex items-center justify-center rounded-lg hover:bg-[var(--color-bg-hover)] text-[var(--color-text-muted)]" title="Закрыть"><X size={16} /></button>
            </div>
          </div>
          {/* Вкладки */}
          <div className="mt-2 flex gap-1 -mb-2 overflow-x-auto scrollbar-none">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setCardTab(t.key)}
                className={`min-h-11 sm:min-h-0 px-3 py-1.5 text-[13px] border-b-2 whitespace-nowrap transition-colors ${cardTab === t.key ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-semibold' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-4 flex flex-col gap-4">
          {isError && <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить карточку клиента.</div>}

          {cardTab === 'overview' && (
            <>
              {/* Окно повторной продажи — главный сигнал, крупно. */}
              <div className="rounded-xl border px-4 py-3" style={{ borderColor: w.color, backgroundColor: `color-mix(in srgb, ${w.color} 6%, transparent)` }}>
                <div className="text-[15px] font-bold" style={{ color: w.color }}>{w.text}</div>
                {w.sub && <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5">{w.sub}</div>}
                {row.autoRepeatLostNoCall && row.queue.queue !== 'rest' && (
                  <div className="text-[12px] font-semibold mt-0.5" style={{ color: 'var(--color-negative, #e03131)' }}>⚠ Авто-сделка повторки после этой отгрузки закрыта в отказ без успешного звонка</div>
                )}
                <div className="mt-2 text-[13px] text-[var(--color-text)]"><b>Следующий шаг:</b> {nextStep}</div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
                <StatTile label="Покупок" value={`${row.dealsSold} из ${row.dealsTotal}`} sub="проданных / всех сделок" />
                <StatTile label="LTV (отгружено)" value={row.sumDelivered > 0 ? fmtMoney(row.sumDelivered) : '—'} sub={`${row.dealsDelivered} отгрузок`} hint="Сумма всех отгрузок заказчика" />
                <StatTile label="Средний чек" value={avgCheck !== null && avgCheck > 0 ? fmtMoney(avgCheck) : '—'} />
                <StatTile label="Цикл повторки" value={`${row.cycleDays} дн.`} hint={row.cycleSource === 'own' ? 'Медиана интервалов между его покупками' : 'По базе — своих покупок мало, взята медиана по всей базе (16 дн.)'} />
                <StatTile label="Последняя отгрузка" value={row.lastDeliveredAt ? fmtDate(row.lastDeliveredAt) : '—'} sub={row.lastDeliveredAt ? daysAgo(row.lastDeliveredAt) : undefined} />
                <StatTile label="Товарных групп" value={String(row.distinctGroups)} sub="разных, по отгрузкам" />
                {/* Объекты (21.09): разные адреса доставки. 2+ — заказчик возит
                    на стройки, а не домой: следующая покупка привязана к
                    следующему объекту, а не к «окну» после отгрузки. */}
                {objectsCount > 0 && (
                  <StatTile label="Объектов" value={String(objectsCount)}
                    sub={objectsCount >= 2 ? 'разных адреса — похоже на строителя' : 'один адрес'}
                    hint="Сколько разных адресов доставки встречается в сделках заказчика (поле «Адрес и координаты» в Битриксе)" />
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Section title="Что предложить" hint="Сначала — приоритеты, заданные вручную в «Настройки → Что предложить» (📌), дальше по истории всей базы: что покупают после такого же материала. Проценты — доля повторных покупок, в которых была эта группа">
                  {!row.recommend || row.recommend.items.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Статистики переходов пока нет.</div> : (
                    <div className="flex flex-col gap-1.5">
                      {row.recommend.fallback && <div className="text-[11px] text-[var(--color-text-muted)]">по группе клиента мало статистики — общий топ по базе</div>}
                      <div className="text-[11px] text-[var(--color-text-muted)]">после: {row.recommend.basedOn.join(', ')}</div>
                      {/* до 6: три ручных приоритета + статистический топ-3 */}
                      {row.recommend.items.slice(0, 6).map(it => (
                        <div key={it.group} className="flex items-center gap-2 text-[13px]">
                          {/* У ручного приоритета (настройки 21.09) процента может не быть:
                              такой пары в матрице переходов не встречалось — пишем «—». */}
                          <span className="font-bold tabular-nums text-[var(--color-accent)] w-11 shrink-0">{it.pct > 0 ? `${it.pct}%` : '—'}</span>
                          <div className="w-24 h-1.5 rounded bg-[var(--color-bg-hover)] overflow-hidden shrink-0"><div className="h-full bg-[var(--color-accent)]" style={{ width: `${Math.min(100, it.pct)}%` }} /></div>
                          {it.manual && <span title="Приоритет задан вручную в настройках">📌</span>}
                          <span className="truncate">{it.group}</span>
                          {/* Иконка бейджа и ебаллы за допродажу скрыты 21.09
                              (геймификация убрана с глаз владельцем). */}
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
                <Section title={`Активные сделки · ${row.activeDeals.length}`}>
                  {row.activeDeals.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Активных сделок нет.</div> : (
                    <div className="flex flex-col gap-1.5">
                      {row.activeDeals.map(d => {
                        const daysInWork = Math.floor((Date.now() - new Date(d.createdAt).getTime()) / DAY_MS);
                        return (
                          <div key={d.dealId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[12.5px]">
                            <div className="flex items-center gap-2 flex-wrap">
                              <button onClick={() => setOpenDealId(d.dealId)} className="font-mono text-[var(--color-accent)] hover:underline">#{d.dealId}</button>
                              <Chip>{d.stage ?? '?'}</Chip>
                              <span className="ml-auto font-semibold tabular-nums">{d.amount !== null && d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
                            </div>
                            <div className="mt-0.5 text-[var(--color-text-muted)] truncate" title={d.name ?? undefined}>{d.name ?? '—'}</div>
                            <AddressLine a={addrOf(d.dealId)} compact />
                            <div className="mt-0.5 flex gap-3 text-[11.5px] text-[var(--color-text-muted)]">
                              <span>{daysInWork} дн. в работе</span>
                              <span className="font-semibold" style={d.daysSilent > 7 ? { color: 'var(--color-negative, #e03131)' } : undefined}>🔇 {Math.floor(d.daysSilent)} дн. без звонка</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Section>
              </div>

              {row.managerHistory.length > 1 && (
                <Section title="Кто вёл заказчика" hint="Имена — на момент работы с клиентом">
                  <div className="flex flex-wrap gap-2 text-[12.5px]">
                    {row.managerHistory.map(m => (
                      <span key={m.managerId} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1">
                        <b>{m.name ?? `Менеджер #${m.managerId}`}</b> <span className="text-[var(--color-text-muted)]">· сделок {m.deals}, продано {m.sold} · {fmtDate(m.firstAt)}{m.firstAt.slice(0, 10) !== m.lastAt.slice(0, 10) ? ` — ${fmtDate(m.lastAt)}` : ''}</span>
                      </span>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {cardTab === 'deals' && (
            // Правка владельца 17.09: никаких «окошек» — список сделок на всю ширину
            // вкладки, каждая сделка строкой-карточкой с путём по воронке датами. Без
            // таблицы и без горизонтального скролла: читается при любой ширине панели.
            <>
              <div className="flex items-baseline gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                Все сделки <span className="tabular-nums">{dealsData?.total_count ?? '…'}</span>
                <span className="normal-case tracking-normal font-normal">· клик по номеру открывает карточку сделки</span>
              </div>
              {clientDeals.length === 0 ? <div className="text-[12px] text-[var(--color-text-muted)]">Сделок не найдено.</div> : (
                <div className="flex flex-col gap-1.5">
                  {[...clientDeals].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(d => {
                    const amount = Number(d.amount);
                    const lost = !!d.lost_at; const shipped = !!d.delivered_at; const sold = !!d.sold_at;
                    const tone = lost ? 'neg' as const : shipped || sold ? 'ok' as const : 'muted' as const;
                    const steps: { label: string; at: string | null }[] = [
                      { label: 'создана', at: d.created_at }, { label: 'бронь', at: d.reserved_at }, { label: 'подтв.', at: d.confirmed_at },
                      { label: 'продана', at: d.sold_at }, { label: 'отгружена', at: d.delivered_at }, { label: 'отказ', at: d.lost_at },
                    ];
                    return (
                      <div key={d.deal_id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button onClick={() => setOpenDealId(d.deal_id)} className="font-mono text-[13px] font-semibold text-[var(--color-accent)] hover:underline">#{d.deal_id}</button>
                          <Chip tone={tone}>{d.stage_name ?? '?'}</Chip>
                          {d.funnel_name && <Chip>{d.funnel_name}</Chip>}
                          {d.product_group_display && <span className="text-[12px] text-[var(--color-text-muted)] truncate max-w-[260px]" title={d.product_group_display}>{d.product_group_display}</span>}
                          <span className="ml-auto text-[13.5px] font-bold tabular-nums whitespace-nowrap">{amount > 0 ? fmtMoney(amount) : '—'}</span>
                        </div>
                        <div className="mt-0.5 text-[12.5px] text-[var(--color-text)] break-words">{d.deal_name}</div>
                        <AddressLine a={addrOf(d.deal_id)} />
                        <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
                          {steps.filter(st => st.at).map((st, i, arr) => (
                            <Fragment key={st.label}>
                              <span className={st.label === 'отказ' ? 'font-semibold' : ''} style={st.label === 'отказ' ? { color: 'var(--color-negative, #e03131)' } : undefined}>
                                {st.label} <b className="font-semibold text-[var(--color-text)] tabular-nums">{fmtDate(st.at)}</b>
                              </span>
                              {i < arr.length - 1 && <span aria-hidden>→</span>}
                            </Fragment>
                          ))}
                          {d.manager_name && <span className="ml-auto">· {d.manager_name}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {!isLoading && (data?.refused.length ?? 0) > 0 && (
                <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
                  Отказов без единого звонка: <b className="text-[var(--color-negative, #e03131)]">{data!.refused.filter(r => !r.hasCall).length}</b> из {data!.refused.length}
                </div>
              )}
            </>
          )}

          {cardTab === 'journey' && (
            <>
              {timeline.length > 0 && (
                <Section title={`Покупки · ${timeline.length}`} hint="Проданные сделки хронологически; между ними — интервал в днях">
                  <div className="flex flex-col divide-y divide-[var(--color-border)] text-[12.5px]">
                    {timeline.map((d, i) => {
                      const gap = i === 0 ? null : Math.round((new Date(d.soldAt).getTime() - new Date(timeline[i - 1].soldAt).getTime()) / DAY_MS);
                      return (
                        <div key={d.dealId} className="flex items-center gap-3 py-1.5 flex-wrap">
                          <span className="w-[76px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{fmtDate(d.soldAt)}</span>
                          <button onClick={() => setOpenDealId(d.dealId)} className="font-mono text-[var(--color-accent)] hover:underline shrink-0">#{d.dealId}</button>
                          <span className="min-w-0 flex-1 truncate" title={[...d.groups, d.name ?? ''].filter(Boolean).join(' · ')}>{d.groups.length > 0 ? d.groups.join(', ') : (d.name ?? 'без товарных групп')}</span>
                          {gap !== null && <Chip>↓ {gap} дн.</Chip>}
                          <span className="font-semibold tabular-nums whitespace-nowrap">{d.amount !== null && d.amount > 0 ? fmtMoney(d.amount) : '—'}</span>
                        </div>
                      );
                    })}
                  </div>
                </Section>
              )}
              <JourneyTab purchases={journey?.purchases ?? []} loading={journeyLoading} recommend={row.recommend} onDealOpen={setOpenDealId} />
            </>
          )}

          {cardTab === 'contacts' && (
            <Section title={`Контакты · ${feed.length}`} hint="Звонки по сделкам заказчика, ручные отметки «Связался», отложить/исключить и запросы РОПу — одной лентой, свежие сверху">
              {isLoading ? <div className="text-sm text-[var(--color-text-muted)]">Загружаем…</div>
                : feed.length === 0 ? <div className="text-sm text-[var(--color-text-muted)]">Контактов ещё не было — ни звонков, ни отметок.</div> : (
                <div className="flex flex-col divide-y divide-[var(--color-border)]">
                  {feed.map((f, i) => (
                    <div key={i} className="flex items-start gap-3 py-1.5 text-[12.5px]">
                      <span className="w-[112px] shrink-0 tabular-nums text-[var(--color-text-muted)]">{format(new Date(f.at), 'dd.MM.yyyy HH:mm', { locale: ru })}</span>
                      <span className="shrink-0 mt-0.5" style={{ color: f.tone === 'neg' ? 'var(--color-negative, #e03131)' : f.tone === 'ok' ? 'var(--color-positive, #2f9e44)' : 'var(--color-text-muted)' }}>{f.icon}</span>
                      <span className="min-w-0 flex-1 break-words">{f.text}</span>
                      {f.by && <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{f.by}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>
      {openDealId !== null && <DealCard dealId={openDealId} onClose={() => setOpenDealId(null)} />}
    </div>,
  );
}
