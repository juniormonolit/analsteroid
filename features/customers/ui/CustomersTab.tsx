'use client';
// «Мои заказчики» (фича Серёги 01.08): таб в ЛК менеджера — кому пора позвонить.
// РЕДИЗАЙН 01.08 (правка Серёги «суперкривожопый» со скрином): плотный рабочий
// вид по образцу обычных отчётов («Базовый минимум») —
//   * легенда-простыня → поповер за иконкой «?»;
//   * строки в одну линию (~34px, 10-12 клиентов на экране): имя с эллипсисом,
//     статусные чипы инлайн, «нет» → «—», последняя покупка одной строкой;
//   * кнопки «Отложить»/«Не звонить» → меню «⋯» в конце строки;
//   * «Предложить» — топ-1 чипом, топ-3 и награда в тултипе;
//   * секции — тонкая строка-разделитель, не серый блок;
//   * имя открывает КАРТОЧКУ КЛИЕНТА (CustomerCard.tsx) — ссылка на Битрикс,
//     история менеджеров, таймлайн, отметки и пр. переехали туда.
// Клиент = contact_id (физ) / company_id (юр); атрибуция — менеджер последней
// сделки; сигналы и пороги — в features/customers/engine/customers.ts.
// ПДн: телефоны в UI не показываются — звонить менеджер идёт в Битрикс.

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { HelpCircle, MoreHorizontal, ExternalLink } from 'lucide-react';
import type { ActiveDealInfo, CustomerSection, NoCallReason } from '@/features/customers/engine/customers';
import type { Recommendation } from '@/features/customers/engine/crossSell';
import { CustomerCard } from './CustomerCard';
import {
  type ApiRow, REASON_LABELS, fmtMoney, fmtDate, daysAgo,
  clientBitrixUrl, dealBitrixUrl, clientDisplayName,
  CATEGORY_LABELS, CATEGORY_STYLE, MODIFIER_LABELS,
} from './shared';
import type { CustomerCategory } from '@/features/customers/engine/customers';

interface ApiResponse {
  total: number;
  counts: {
    all: number; active: number; inactive: number; overdue: number; refusedNoCall: number;
    sections: { regular: number; regularAtRisk: number; once: number; never: number };
    sleeping: number; refused: number; refusedByReason: Partial<Record<NoCallReason, number>>;
    byCategory?: { key: number; large: number; regular: number; once: number; potential: number; keyAtRisk: number };
  };
  page: number; pageSize: number; rows: ApiRow[];
  thresholds: {
    globalCycleDays: number; activeNoCallDays: number; atRiskCycleMultiplier: number;
    sleepCycleMultiplier: number; sleepMinDays: number;
  };
}

type Filter = 'all' | 'active' | 'inactive' | 'overdue' | 'never' | 'sleeping' | 'refused';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Все' },
  { key: 'overdue', label: 'Пора позвонить' },
  { key: 'active', label: 'С активными' },
  { key: 'inactive', label: 'Без активных' },
  { key: 'never', label: 'Ещё не купили' },
  { key: 'sleeping', label: 'Спящие' },
  { key: 'refused', label: 'Отказались' },
];
const MAIN_FILTERS: Filter[] = ['all', 'overdue', 'active', 'inactive'];

const SECTION_LABELS: Record<CustomerSection, string> = {
  regular: 'Постоянники',
  once: 'Купили один раз',
  never: 'Ещё не купили',
};
const SECTION_HINTS: Record<CustomerSection, string> = {
  regular: 'Клиенты с 2+ успешными сделками (по всей истории клиента, независимо от менеджера)',
  once: 'Купили один раз — кандидаты в постоянники',
  never: 'Ни одной успешной сделки; здесь живут сигналы по их активным сделкам',
};

const PAGE_SIZE = 50;

type Sort = { key: string; dir: 'desc' | 'asc' } | null;

function useCustomers(managerId: string, isSelf: boolean, filter: Filter, search: string, page: number, sort: Sort, category: string) {
  return useQuery<ApiResponse>({
    queryKey: ['customers', isSelf ? 'me' : managerId, filter, search, page, sort?.key ?? '', sort?.dir ?? '', category],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (!isSelf) qs.set('bitrixId', managerId);
      qs.set('filter', filter);
      if (search) qs.set('search', search);
      qs.set('page', String(page));
      qs.set('pageSize', String(PAGE_SIZE));
      if (sort) { qs.set('sort', sort.key); qs.set('dir', sort.dir); }
      if (category !== 'all') qs.set('category', category);
      const res = await fetch(`/api/customers?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: prev => prev,
  });
}

// Легенда — за иконкой «?» (редизайн 01.08: простыня текста над таблицей мешала работать).
function LegendPopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(v => !v)} title="Как читать этот список"
        className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
        <HelpCircle size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[380px] max-w-[85vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3 text-xs leading-relaxed text-[var(--color-text-muted)] shadow-xl">
          Клиенты, где вы вели последнюю сделку. <b>Постоянники</b> (2+ покупок за всю историю клиента) — сверху,
          <b> ⚠ под угрозой</b> — постоянник молчит дольше двух своих циклов повторки и активных сделок нет; ниже —
          купившие один раз; не купившие — во вкладке «Ещё не купили». Сигналы: <b>📞 сделка молчит</b> — по активной
          сделке нет звонков больше недели; <b>⏰ пора позвонить</b> — активных сделок нет, а с последней покупки прошло
          больше типичного цикла повторки клиента. «Предложить» — что клиенты чаще всего покупают следом (наведите —
          топ-3 и награда за допродажу). Имя открывает карточку клиента; действия — в меню «⋯».
        </div>
      )}
    </div>
  );
}

// ── Отметки: «Отложить» / «Больше не звонить» / «Вернуть в работу» ───────────
// Редизайн 01.08: контролы больше не живут в каждой строке (раздували её до
// 150px) — рендерятся в меню «⋯» строки и в шапке карточки клиента.

function addMonthsYmd(months: number): string {
  const d = new Date(Date.now() + 3 * 3600_000); // МСК
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

type MarkSender = (payload: Record<string, unknown>) => Promise<void>;

export function MarkControls({ r, send, busy, onDone }: { r: ApiRow; send: MarkSender; busy: boolean; onDone?: () => void }) {
  const [open, setOpen] = useState<'snooze' | 'nocall' | null>(null);
  const [customDate, setCustomDate] = useState('');
  const [reason, setReason] = useState<NoCallReason | null>(null);
  const [comment, setComment] = useState('');

  const btn = 'rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-40 text-left';
  const fire = (payload: Record<string, unknown>) => { setOpen(null); onDone?.(); void send(payload); };

  if (r.mark?.kind === 'no_call') {
    return <button type="button" disabled={busy} className={btn}
      onClick={() => fire({ clientKey: r.clientKey, action: 'clear' })}
      title="Снять отметку «больше не звонить» и вернуть клиента в основной список">↩ Вернуть в работу</button>;
  }
  if (r.snoozedActive) {
    return <button type="button" disabled={busy} className={btn}
      onClick={() => fire({ clientKey: r.clientKey, action: 'clear' })}
      title="Снять отсрочку — клиент вернётся в сигналы уже сейчас">↩ Вернуть в работу</button>;
  }
  if (r.bucket === 'sleeping') {
    return <button type="button" disabled={busy} className={btn}
      onClick={() => fire({ clientKey: r.clientKey, action: 'wake' })}
      title="Вернуть спящего клиента в основной список — сигналы снова действуют">↩ Вернуть в работу</button>;
  }

  const snoozeTo = (ymd: string) => fire({ clientKey: r.clientKey, action: 'snooze', until: ymd });
  return (
    <div className="flex flex-col gap-1">
      {open !== 'snooze' ? (
        <button type="button" disabled={busy} className={btn} onClick={() => setOpen('snooze')}
          title="Отложить клиента: до даты он исчезает из горящих сигналов, потом возвращается сам">⏸ Отложить…</button>
      ) : (
        <div className="flex flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-1.5">
          <button type="button" className={btn} onClick={() => snoozeTo(addMonthsYmd(1))}>На месяц</button>
          <button type="button" className={btn} onClick={() => snoozeTo(addMonthsYmd(3))}>На квартал</button>
          <button type="button" className={btn} onClick={() => snoozeTo(addMonthsYmd(6))}>На полгода</button>
          <div className="flex items-center gap-1">
            <input type="date" value={customDate} onChange={e => setCustomDate(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-1 py-0.5 text-[11px]" />
            <button type="button" className={btn} disabled={!customDate} onClick={() => snoozeTo(customDate)}>ОК</button>
          </div>
        </div>
      )}
      <button type="button" disabled={busy} className={btn} onClick={() => { setReason(null); setComment(''); setOpen('nocall'); }}
        title="Больше не звонить этому клиенту — уйдёт во вкладку «Отказались» (причина обязательна)">🚫 Не звонить…</button>
      {open === 'nocall' && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4" onClick={e => e.stopPropagation()}>
            <div className="mb-2 text-sm font-bold text-[var(--color-text)]">Больше не звонить — почему?</div>
            <div className="flex flex-col gap-1.5">
              {(Object.keys(REASON_LABELS) as NoCallReason[]).map(k => (
                <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text)]">
                  <input type="radio" name={`nocall-${r.clientKey}`} checked={reason === k} onChange={() => setReason(k)} />
                  {REASON_LABELS[k]}
                </label>
              ))}
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2}
                placeholder={reason === 'other' ? 'Комментарий (обязателен для «Прочее»)' : 'Комментарий (необязательно)'}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm" />
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className={btn} onClick={() => setOpen(null)}>Отмена</button>
              <button type="button" disabled={busy || !reason || (reason === 'other' && comment.trim() === '')}
                className={`${btn} !border-transparent`}
                style={{ color: 'var(--color-text-inverse)', backgroundColor: 'var(--color-negative, #e03131)' }}
                onClick={() => fire({ clientKey: r.clientKey, action: 'no_call', reason, comment: comment.trim() || undefined })}>
                Больше не звонить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Меню «⋯» строки: действия + ссылка в Битрикс (редизайн 01.08).
function RowMenu({ r, send, busy, onOpenCard }: { r: ApiRow; send: MarkSender; busy: boolean; onOpenCard: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(v => !v)} title="Действия"
        className="flex h-6 w-6 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 flex w-48 flex-col gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-1.5 shadow-xl">
          <button type="button" onClick={() => { setOpen(false); onOpenCard(); }}
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-left text-[11px] font-semibold hover:bg-[var(--color-bg-hover)]">
            👤 Карточка клиента
          </button>
          <a href={clientBitrixUrl(r)} target="_blank" rel="noreferrer"
            className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-semibold hover:bg-[var(--color-bg-hover)] inline-flex items-center gap-1">
            <ExternalLink size={11} /> Открыть в Битриксе
          </a>
          <MarkControls r={r} send={send} busy={busy} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

// Компактный чип статуса (одна строка рядом с именем, редизайн 01.08).
function StatusChips({ r }: { r: ApiRow }) {
  const chips: { label: string; title: string; neg?: boolean }[] = [];
  chips.push({ label: r.clientType === 'contact' ? 'физ' : 'юр', title: r.clientType === 'contact' ? 'Физлицо (контакт)' : 'Юрлицо (компания)' });
  if (r.atRisk) chips.push({ label: '⚠', title: `Постоянник под угрозой: активных сделок нет, с последней покупки прошло больше 2× его цикла повторки (${r.cycleDays} дн.)`, neg: true });
  if (r.refusedNoCall) chips.push({ label: '🚫', title: 'Есть сделка, закрытая в отказ без единого звонка', neg: true });
  if (r.snoozedActive && r.mark) chips.push({ label: `⏸ ${fmtDate(r.mark.snoozeUntil)}`, title: `Отложен до ${fmtDate(r.mark.snoozeUntil)} · ${r.mark.createdBy}` });
  if (r.mark?.kind === 'no_call') chips.push({ label: `🚫 ${r.mark.reason ? REASON_LABELS[r.mark.reason] : 'не звонить'}`, title: `${r.mark.createdBy}, ${fmtDate(r.mark.createdAt)}${r.mark.comment ? ` — «${r.mark.comment}»` : ''}`, neg: true });
  return (
    <>
      {chips.map((c, i) => (
        <span key={i} title={c.title}
          className="inline-flex shrink-0 items-center whitespace-nowrap rounded px-1 py-px text-[10.5px] font-semibold"
          style={c.neg
            ? { color: 'var(--color-negative, #e03131)', backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 10%, transparent)' }
            : { color: 'var(--color-text-muted)', backgroundColor: 'var(--color-bg-hover)' }}>
          {c.label}
        </span>
      ))}
    </>
  );
}

// Категория клиента чипом + модификаторы-иконки (дополнение Серёги 01.08).
function CategoryCell({ r }: { r: ApiRow }) {
  const cat = (r.category ?? 'none') as CustomerCategory;
  const st = CATEGORY_STYLE[cat];
  const hint = `Правила: ключевой — отгрузок ≥2 и сумма ≥5 млн; крупный — ≥1,5 млн или ≥5 отгрузок; постоянный — 2+ покупки; разовый — 1; потенциальный — покупок нет, есть активные. Пороги — в Настройки → Категории клиентов. Отгрузок: ${r.dealsDelivered} на ${fmtMoney(r.sumDelivered)}, групп: ${r.distinctGroups}`;
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {cat === 'none' ? <span className="text-xs text-[var(--color-text-muted)]">—</span> : (
        <span className="inline-flex items-center rounded px-1.5 py-px text-[11px] font-bold" style={{ color: st.color, backgroundColor: st.bg }} title={hint}>
          {cat === 'key' && '🔑 '}{CATEGORY_LABELS[cat]}
        </span>
      )}
      {(r.modifiers ?? []).map(mod => (
        <span key={mod} className="text-[12px] cursor-default" title={`${MODIFIER_LABELS[mod].label} — ${MODIFIER_LABELS[mod].hint}`}>
          {MODIFIER_LABELS[mod].icon}
        </span>
      ))}
    </div>
  );
}

// Сигнал одной строкой: иконка + короткая подпись цветом (редизайн 01.08).
function SignalCell({ r, noCallDays }: { r: ApiRow; noCallDays: number }) {
  if (r.signals.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const silent = Math.floor(r.activeDeals.reduce((mx, d) => Math.max(mx, d.daysSilent), 0));
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap">
      {r.signals.includes('active_no_call') && (
        <span className="text-[11.5px] font-bold" style={{ color: 'var(--color-negative, #e03131)' }}
          title={`Есть активная сделка, по которой нет звонков больше ${noCallDays} дней (молчит ${silent} дн.)`}>
          📞 молчит {silent} дн.
        </span>
      )}
      {r.signals.includes('overdue_repeat') && (
        <span className="text-[11.5px] font-bold" style={{ color: 'var(--color-warning, #e8590c)' }}
          title={`Активных сделок нет, с последней покупки прошло больше цикла повторки клиента (${r.cycleDays} дн., ${r.cycleSource === 'own' ? 'его медиана' : 'медиана по базе'})`}>
          ⏰ пора позвонить
        </span>
      )}
    </div>
  );
}

// Активные сделки одной строкой: первая + «+N» с тултипом (редизайн 01.08).
function ActiveDealsCell({ deals }: { deals: ActiveDealInfo[] }) {
  if (deals.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const d = deals[0];
  const restTitle = deals.map(x => `#${x.dealId} · ${x.stage ?? '?'}${x.daysSilent > 7 ? ` · 🔇 ${Math.floor(x.daysSilent)} дн.` : ''}`).join('\n');
  return (
    <div className="flex items-center gap-1 whitespace-nowrap text-xs" title={restTitle}>
      <a href={dealBitrixUrl(d.dealId)} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] hover:underline">#{d.dealId}</a>
      <span className="text-[var(--color-text-muted)] max-w-[110px] truncate">{d.stage ?? '?'}</span>
      {d.daysSilent > 7 && <span className="font-semibold text-[var(--color-negative,#e03131)]">🔇{Math.floor(d.daysSilent)}</span>}
      {deals.length > 1 && <span className="font-semibold text-[var(--color-text-muted)]">+{deals.length - 1}</span>}
    </div>
  );
}

// «Предложить» — топ-1 чипом, полный топ-3 и награды в тултипе (редизайн 01.08).
function RecommendCell({ rec }: { rec: Recommendation | null }) {
  if (!rec || rec.items.length === 0) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  const top = rec.items[0];
  const title = [
    rec.fallback ? 'Мало статистики по группе клиента — общий топ по базе:' : `После: ${rec.basedOn.join(', ')} чаще всего покупают:`,
    ...rec.items.map(it => `${it.group} — ${it.pct}%${it.badge ? ` (бейдж «${it.badge.name}»${it.badge.price > 0 ? `, +${it.badge.price}` : ''})` : ''}`),
  ].join('\n');
  return (
    <div className="flex items-center gap-1 whitespace-nowrap text-xs" title={title}>
      <span className="max-w-[150px] truncate">{top.group}</span>
      <span className="font-semibold tabular-nums text-[var(--color-accent)]">{top.pct}%</span>
      {top.badge && top.badge.price > 0 && (
        <span className="font-bold text-[var(--color-positive,#2f9e44)]">+{top.badge.price}</span>
      )}
      {rec.items.length > 1 && <span className="text-[var(--color-text-muted)]">+{rec.items.length - 1}</span>}
    </div>
  );
}

/** Список заказчиков одного менеджера: фильтры + поиск + пагинация.
 *  Используется и в табе ЛК, и в провале из блока РОПа. */
export function CustomersList({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<Sort>(null);
  const [cardRow, setCardRow] = useState<ApiRow | null>(null);
  const [category, setCategory] = useState<string>('all'); // фильтр по категории (01.08)

  const qc = useQueryClient();
  const [markBusy, setMarkBusy] = useState(false);
  const sendMark: MarkSender = async (payload) => {
    setMarkBusy(true);
    try {
      const res = await fetch('/api/customers/mark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(isSelf ? {} : { managerId }) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        alert((j as { error?: string } | null)?.error ?? `Ошибка ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['customers-team'] });
      void qc.invalidateQueries({ queryKey: ['customer-card'] });
    } finally { setMarkBusy(false); }
  };
  const cycleSort = (key: string) => {
    setPage(1);
    setSort(s => (s?.key !== key ? { key, dir: 'desc' } : s.dir === 'desc' ? { key, dir: 'asc' } : null));
  };

  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading, isError } = useCustomers(managerId, isSelf, filter, search, page, sort, category);
  const rows = data?.rows ?? [];
  const totalPages = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE)), [data?.total]);

  // Карточка открыта — держим строку свежей после мутаций (список перезапросился).
  const cardRowLive = cardRow ? (rows.find(r => r.clientKey === cardRow.clientKey) ?? cardRow) : null;

  const Th = ({ k, label, right = false }: { k?: string; label: string; right?: boolean }) => (
    <th className={`px-2.5 py-1.5 font-bold whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>
      {k ? (
        <button type="button" onClick={() => cycleSort(k)} title="Сортировка: убывание → возрастание → по сигналу"
          className={`uppercase tracking-wider hover:text-[var(--color-accent)] ${sort?.key === k ? 'text-[var(--color-accent)]' : ''}`}>
          {label}{sort?.key === k ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : ''}
        </button>
      ) : label}
    </th>
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-0.5 overflow-x-auto">
          {FILTERS.map(f => (
            <button key={f.key} type="button" onClick={() => { setFilter(f.key); setPage(1); }}
              className={`rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap transition-colors ${
                filter === f.key ? 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'
              }`}>
              {f.label}
              {data && (
                <span className="ml-1 opacity-70 tabular-nums">
                  {f.key === 'all' ? data.counts.all : f.key === 'overdue' ? data.counts.overdue
                    : f.key === 'active' ? data.counts.active : f.key === 'inactive' ? data.counts.inactive
                    : f.key === 'never' ? data.counts.sections.never
                    : f.key === 'sleeping' ? data.counts.sleeping : data.counts.refused}
                </span>
              )}
            </button>
          ))}
        </div>
        <input value={searchInput} onChange={e => setSearchInput(e.target.value)} placeholder="Поиск по имени или id"
          className="min-w-[160px] flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm sm:max-w-xs" />
        {/* Фильтр по категории клиента (дополнение Серёги 01.08) */}
        <select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}
          title="Фильтр по категории клиента (правила — в Настройки → Категории клиентов)"
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-semibold">
          <option value="all">Все категории{data?.counts.byCategory ? ` · 🔑 ${data.counts.byCategory.key}` : ''}</option>
          <option value="key">Ключевые{data?.counts.byCategory ? ` (${data.counts.byCategory.key})` : ''}</option>
          <option value="large">Крупные{data?.counts.byCategory ? ` (${data.counts.byCategory.large})` : ''}</option>
          <option value="regular">Постоянные{data?.counts.byCategory ? ` (${data.counts.byCategory.regular})` : ''}</option>
          <option value="once">Разовые{data?.counts.byCategory ? ` (${data.counts.byCategory.once})` : ''}</option>
          <option value="potential">Потенциальные{data?.counts.byCategory ? ` (${data.counts.byCategory.potential})` : ''}</option>
        </select>
        <LegendPopover />
      </div>

      {filter === 'refused' && data && data.counts.refused > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Причины:</span>
          {(Object.keys(REASON_LABELS) as NoCallReason[]).map(k => {
            const n = data.counts.refusedByReason[k] ?? 0;
            if (n === 0) return null;
            return (
              <span key={k} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 py-0.5">
                {REASON_LABELS[k]}: <b className="tabular-nums">{n}</b>
              </span>
            );
          })}
        </div>
      )}
      {filter === 'sleeping' && data && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          Авто-архив: без активных сделок, молчание дольше {data.thresholds.sleepCycleMultiplier}× цикла повторки
          (минимум {data.thresholds.sleepMinDays} дн.). «Вернуть в работу» — в меню «⋯».
        </div>
      )}

      {isError ? (
        <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить список заказчиков.</div>
      ) : isLoading && rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Считаем заказчиков… (первое открытие может занять до минуты)</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-[var(--color-text-muted)]">Ничего не найдено.</div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                <Th label="Клиент" />
                <Th k="category" label="Категория" />
                <Th label="Сигнал" />
                <Th k="dealsSold" label="Сд/прод" right />
                <Th k="sumSold" label="Куплено на" right />
                <Th k="lastSoldAt" label="Последняя покупка" />
                <Th k="activeCount" label="Активные" />
                <Th label="Предложить" />
                <Th k="lastCallAt" label="Звонок" />
                <Th k="lastActivityAt" label="Актив-ть" />
                <Th label="" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const showHeader = idx === 0 || rows[idx - 1].section !== r.section;
                const secCounts = MAIN_FILTERS.includes(filter) ? data?.counts.sections : undefined;
                const secCount = secCounts
                  ? (r.section === 'regular' ? secCounts.regular : r.section === 'once' ? secCounts.once : secCounts.never)
                  : null;
                return (
                  <Fragment key={r.clientKey}>
                    {showHeader && (
                      // Секция — тонкая строка-разделитель (редизайн 01.08), не серый блок.
                      <tr className="border-t border-[var(--color-border)]">
                        <td colSpan={11} className="px-2.5 pt-2 pb-0.5 text-[10.5px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
                          title={SECTION_HINTS[r.section]}>
                          {SECTION_LABELS[r.section]}
                          {secCount !== null && <span className="ml-1.5 tabular-nums normal-case font-semibold">{secCount}</span>}
                          {r.section === 'regular' && secCounts !== undefined && (secCounts?.regularAtRisk ?? 0) > 0 && (
                            <span className="ml-2 normal-case font-semibold" style={{ color: 'var(--color-negative, #e03131)' }}
                              title="Постоянники без активных сделок, молчащие дольше двух своих циклов повторки">
                              ⚠ {secCounts!.regularAtRisk}
                            </span>
                          )}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-[var(--color-border)] align-middle hover:bg-[var(--color-bg-hover)]/50"
                      style={r.atRisk ? { backgroundColor: 'color-mix(in srgb, var(--color-negative, #e03131) 4%, transparent)' } : undefined}>
                      <td className="px-2.5 py-1">
                        <div className="flex items-center gap-1.5 min-w-0 max-w-[300px]">
                          <button type="button" onClick={() => setCardRow(r)}
                            title={`${clientDisplayName(r)} — открыть карточку клиента`}
                            className="min-w-0 truncate text-left font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)] hover:underline">
                            {clientDisplayName(r)}
                          </button>
                          <StatusChips r={r} />
                        </div>
                      </td>
                      <td className="px-2.5 py-1"><CategoryCell r={r} /></td>
                      <td className="px-2.5 py-1"><SignalCell r={r} noCallDays={data?.thresholds.activeNoCallDays ?? 7} /></td>
                      <td className="px-2.5 py-1 text-right tabular-nums whitespace-nowrap">{r.dealsTotal}/<b>{r.dealsSold}</b></td>
                      <td className="px-2.5 py-1 text-right font-semibold tabular-nums whitespace-nowrap">{r.sumSold > 0 ? fmtMoney(r.sumSold) : '—'}</td>
                      <td className="px-2.5 py-1">
                        {/* Одной строкой: дата · группа · сумма (редизайн 01.08) */}
                        {r.lastSoldAt ? (
                          <div className="flex items-center gap-1 whitespace-nowrap max-w-[240px]"
                            title={`${daysAgo(r.lastSoldAt)}${r.lastSoldGroups.length ? ` · ${r.lastSoldGroups.join(', ')}` : ''}`}>
                            <span className="tabular-nums">{fmtDate(r.lastSoldAt)}</span>
                            {r.lastSoldGroups.length > 0 && (
                              <span className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]">· {r.lastSoldGroups.join(', ')}</span>
                            )}
                            {r.lastSoldAmount !== null && r.lastSoldAmount > 0 && (
                              <span className="shrink-0 text-[11px] font-semibold">· {fmtMoney(r.lastSoldAmount)}</span>
                            )}
                          </div>
                        ) : <span className="text-xs text-[var(--color-text-muted)]">—</span>}
                      </td>
                      <td className="px-2.5 py-1"><ActiveDealsCell deals={r.activeDeals} /></td>
                      <td className="px-2.5 py-1"><RecommendCell rec={r.recommend} /></td>
                      <td className="px-2.5 py-1 whitespace-nowrap text-xs" title={fmtDate(r.lastCallAt)}>{daysAgo(r.lastCallAt)}</td>
                      <td className="px-2.5 py-1 whitespace-nowrap text-xs text-[var(--color-text-muted)]" title={fmtDate(r.lastActivityAt)}>{daysAgo(r.lastActivityAt)}</td>
                      <td className="px-1.5 py-1 text-right">
                        <RowMenu r={r} send={sendMark} busy={markBusy} onOpenCard={() => setCardRow(r)} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1 font-semibold disabled:opacity-40 hover:bg-[var(--color-bg-hover)]">←</button>
          <span className="tabular-nums text-[var(--color-text-muted)]">стр. {page} из {totalPages} · {data?.total ?? 0} клиентов</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1 font-semibold disabled:opacity-40 hover:bg-[var(--color-bg-hover)]">→</button>
        </div>
      )}

      {cardRowLive && (
        <CustomerCard
          row={cardRowLive}
          managerId={managerId}
          isSelf={isSelf}
          onClose={() => setCardRow(null)}
          markControls={<MarkControls r={cardRowLive} send={sendMark} busy={markBusy} />}
        />
      )}
    </div>
  );
}

export function CustomersTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  return <CustomersList managerId={managerId} isSelf={isSelf} />;
}

// ── Блок РОПа: заказчики команды (managed-depts, как «Моя команда») ──────────

interface TeamRow {
  id: number; name: string; departmentName: string | null;
  clients: number; callNow: number; overdueRepeat: number; activeNoCall: number; refusedNoCall: number;
  regulars: number; regularsAtRisk: number;
  keyClients: number; keyAtRisk: number; // категории клиентов (01.08)
}

export function TeamCustomersBlock() {
  const [expanded, setExpanded] = useState<number | null>(null);
  const { data, isLoading } = useQuery<{ team: TeamRow[] }>({
    queryKey: ['customers-team'],
    queryFn: async () => {
      const res = await fetch('/api/customers/team');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const team = data?.team ?? [];
  if (!isLoading && team.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">Заказчики команды</h2>
        <span className="text-xs text-[var(--color-text-muted)]">у кого сколько «пора позвонить»</span>
      </div>
      {isLoading ? (
        <div className="text-sm text-[var(--color-text-muted)]">Считаем по подчинённым… (первое открытие может занять пару минут)</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                <th className="py-1.5 pr-3 font-bold">Менеджер</th>
                <th className="py-1.5 pr-3 font-bold text-right">Клиентов</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Категория «Ключевой»: отгрузок ≥2 и сумма отгрузок ≥5 млн (пороги в настройках)">🔑 Ключевых</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Ключевые клиенты без активных сделок, молчащие дольше 2× своего цикла повторки — самый дорогой сигнал">🔑⚠ Под угрозой</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Клиентов с 2+ успешными сделками (по всей истории клиента)">Постоянников</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Постоянники без активных сделок, молчащие дольше двух своих циклов повторки">Под угрозой</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap">Пора позвонить</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Активная сделка без звонка больше недели">Сделка молчит</th>
                <th className="py-1.5 pr-3 font-bold text-right whitespace-nowrap" title="Без активных сделок, последняя покупка старше цикла повторки">Заброшенные</th>
                <th className="py-1.5 font-bold text-right whitespace-nowrap" title="Клиентов со сделкой, закрытой в отказ без единого звонка">Отказы без звонка</th>
              </tr>
            </thead>
            <tbody>
              {team.map(m => (
                <Fragment key={m.id}>
                  <tr className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg-hover)]"
                    onClick={() => setExpanded(e => (e === m.id ? null : m.id))}>
                    <td className="py-1.5 pr-3">
                      <span className="font-semibold text-[var(--color-text)]">{m.name}</span>
                      {m.departmentName && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{m.departmentName}</span>}
                      <span className="ml-1.5 text-[11px] text-[var(--color-accent)]">{expanded === m.id ? '▲ свернуть' : '▼ раскрыть'}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.clients}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold" style={{ color: m.keyClients > 0 ? '#8a6d00' : 'var(--color-text-muted)' }}>{m.keyClients}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-bold"
                      style={{ color: m.keyAtRisk > 0 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)' }}>{m.keyAtRisk}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-semibold">{m.regulars}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums font-bold"
                      style={{ color: m.regularsAtRisk > 0 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)' }}>
                      {m.regularsAtRisk}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-bold tabular-nums"
                      style={{ color: m.callNow > 0 ? 'var(--color-negative, #e03131)' : 'var(--color-text-muted)' }}>
                      {m.callNow}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.activeNoCall}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.overdueRepeat}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.refusedNoCall}</td>
                  </tr>
                  {expanded === m.id && (
                    <tr className="border-t border-[var(--color-border)]">
                      <td colSpan={10} className="py-3 pl-2">
                        <CustomersList managerId={String(m.id)} isSelf={false} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
