'use client';
// Настройки магазина — «Заполнятор товаров» (задача 2960, ТЗ Серёги 04.08:
// «хочу заводить всё сам» — форма для товаров И бустов одной и той же формой,
// эмодзи вместо фото, тип позиции, минимальный уровень (антифарм-защита),
// ссылка на маркетплейс, кто может покупать, лимит на человека, подтверждение
// при активации, поля буста). MVP-основа (31.07): срок жизни ебаллов (TTL),
// комиссия/лимит переводов, «Релизный старт» — НЕ трогаем, только добавляем
// конструктор товаров и перевожу список в сортируемую таблицу (правило
// проекта «заголовки = сортировка», 01.08).
//
// MLT — единственная валюта покупки (правка владельца «продаётся только в
// MLT») — рублёвой цены/чекбокса «можно за рубли» в форме больше нет.
//
// Правка владельца 04.08 (задача 2983): редкость считается от ЦЕНЫ, а не от
// минимального уровня — минимальный уровень остался ЧИСТО антифарм-защитой
// («порог доступности», чтобы менеджер хитростью за два месяца не нафармил
// айфон). Редкость показывается рядом с ценой; блок под «Порогом доступности»
// больше не содержит превью редкости.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MltCoin } from '@/components/icons/MltCoin';
import { Modal } from '@/components/ui/Modal';
import { useUrlModal } from '@/lib/hooks/useUrlState';
import { RARITY_TIERS, rarityForPrice, nextRarityTier } from '@/features/shop/engine/rarity';
import { priceEball as toPriceEball } from '@/features/badges/engine/wallet';

interface ShopItemRow {
  id: number; name: string; description: string | null; category: 'material' | 'immaterial' | 'boost';
  priceUnits: number; priceEball: number;
  enabled: boolean; stock: number | null;
  ttlMonths: number; sort: number; purchases: number;
  emoji: string; minLevel: number; marketplaceUrl: string | null;
  buyerScope: 'all' | 'rop_only';
  perPersonLimit: number | null; perPersonLimitDays: number | null;
  requiresApproval: boolean;
  boostMetric: string | null; boostMultiplier: number | null; boostWindowDays: number | null; boostScope: string | null;
  rarityKey: string; rarityLabel: string; rarityColor: string;
}

const TYPE_LABELS: Record<ShopItemRow['category'], string> = {
  material: 'Материальный', immaterial: 'Нематериальный', boost: 'Буст',
};
const SCOPE_LABELS: Record<ShopItemRow['buyerScope'], string> = {
  all: 'Все сотрудники', rop_only: 'Только РОП/директор',
};

// Быстрый выбор — «телефон, еда, велосипед, да похуй что» (дословно ТЗ
// владельца): не полноценный пикер (новая зависимость ради этого не нужна),
// просто россыпь частых вариантов поверх текстового поля.
const EMOJI_QUICK_PICKS = [
  '🎁', '📱', '🎧', '🖥️', '🪑', '☕', '🍕', '🚲', '🏖️', '🕙', '🧹', '⚡',
  '🎉', '🏷️', '💼', '🎓', '🚀', '🏆', '🎮', '📚', '🧘', '🍔', '🎬', '🌴',
];

function RarityBadge({ priceEball }: { priceEball: number }) {
  const r = rarityForPrice(priceEball);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: r.color, backgroundColor: `${r.color}1a`, border: `1px solid ${r.color}55` }}
      title={`От ${r.priceFrom.toLocaleString('ru-RU')} MLT (${r.rubFrom.toLocaleString('ru-RU')} ₽ по курсу 1 MLT = 7,5 ₽)${priceEball > r.priceFrom ? ` — цена позиции ${priceEball.toLocaleString('ru-RU')} MLT` : ''}`}
    >
      {r.label}
    </span>
  );
}

function ItemEditor({ item, currencyName, onClose, onSaved }: {
  item: ShopItemRow | null; currencyName: string; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [category, setCategory] = useState<ShopItemRow['category']>(item?.category ?? 'immaterial');
  const [price, setPrice] = useState(String(item?.priceUnits ?? '100'));
  const [stock, setStock] = useState(item?.stock === null || item?.stock === undefined ? '' : String(item.stock));
  const [ttl, setTtl] = useState(String(item?.ttlMonths ?? 3));
  const [sort, setSort] = useState(String(item?.sort ?? 100));
  const [emoji, setEmoji] = useState(item?.emoji ?? '🎁');
  const [minLevel, setMinLevel] = useState(String(item?.minLevel ?? 0));
  const [marketplaceUrl, setMarketplaceUrl] = useState(item?.marketplaceUrl ?? '');
  const [buyerScope, setBuyerScope] = useState<ShopItemRow['buyerScope']>(item?.buyerScope ?? 'all');
  const [perPersonLimit, setPerPersonLimit] = useState(item?.perPersonLimit === null || item?.perPersonLimit === undefined ? '' : String(item.perPersonLimit));
  const [perPersonLimitDays, setPerPersonLimitDays] = useState(item?.perPersonLimitDays === null || item?.perPersonLimitDays === undefined ? '' : String(item.perPersonLimitDays));
  const [requiresApproval, setRequiresApproval] = useState(item?.requiresApproval ?? true);
  const [boostMetric, setBoostMetric] = useState(item?.boostMetric ?? '');
  const [boostMultiplier, setBoostMultiplier] = useState(item?.boostMultiplier === null || item?.boostMultiplier === undefined ? '' : String(item.boostMultiplier));
  const [boostWindowDays, setBoostWindowDays] = useState(item?.boostWindowDays === null || item?.boostWindowDays === undefined ? '' : String(item.boostWindowDays));
  const [boostScope, setBoostScope] = useState(item?.boostScope ?? '');
  const [error, setError] = useState<string | null>(null);

  const minLevelNum = Number(minLevel) || 0;
  // Редкость — от ЦЕНЫ (задача 2983), не от minLevel.
  const priceNum = Number(price) || 0;
  const priceEballNum = toPriceEball(priceNum);
  const rarity = rarityForPrice(priceEballNum);
  const next = nextRarityTier(priceEballNum);

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(), description: description.trim() || null, category,
        priceUnits: Number(price),
        stock: stock.trim() === '' ? null : Number(stock),
        ttlMonths: Number(ttl), sort: Number(sort),
        emoji: emoji.trim(), minLevel: minLevelNum,
        marketplaceUrl: marketplaceUrl.trim() || null,
        buyerScope,
        perPersonLimit: perPersonLimit.trim() === '' ? null : Number(perPersonLimit),
        perPersonLimitDays: perPersonLimitDays.trim() === '' ? null : Number(perPersonLimitDays),
        requiresApproval,
        boostMetric: category === 'boost' ? (boostMetric.trim() || null) : null,
        boostMultiplier: category === 'boost' && boostMultiplier.trim() !== '' ? Number(boostMultiplier) : null,
        boostWindowDays: category === 'boost' && boostWindowDays.trim() !== '' ? Number(boostWindowDays) : null,
        boostScope: category === 'boost' ? (boostScope.trim() || null) : null,
      };
      if (item) body.id = item.id;
      const res = await fetch('/api/settings/badges/shop', {
        method: item ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const inputCls = "rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-text)]";
  const labelCls = "flex flex-col gap-1";

  return (
    <Modal open onOpenChange={(o) => { if (!o) onClose(); }} title={item ? `Позиция: ${item.name}` : 'Новая позиция — товар или буст'} desktopWidth="sm:max-w-lg">
      <div className="flex flex-col gap-3 text-xs text-[var(--color-text-muted)]">
        {/* Эмодзи вместо фото — картинок не грузим и не храним нигде. */}
        <div className="flex items-center gap-3">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] text-4xl">
            {emoji.trim() || '🎁'}
          </div>
          <div className="flex-1">
            <label className={labelCls}>Эмодзи вместо фото карточки (не грузим и не храним картинки)
              <input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={16} placeholder="🎁"
                className={inputCls} />
            </label>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {EMOJI_QUICK_PICKS.map(em => (
                <button key={em} type="button" onClick={() => setEmoji(em)}
                  className="rounded-lg border border-[var(--color-border)] px-1.5 py-0.5 text-base hover:bg-[var(--color-bg-hover)]">
                  {em}
                </button>
              ))}
            </div>
          </div>
        </div>

        <label className={labelCls}>Название
          <input value={name} onChange={e => setName(e.target.value)} maxLength={300} className={inputCls} />
        </label>
        <label className={labelCls}>Описание
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} maxLength={1000} className={inputCls} />
        </label>

        <div className="grid grid-cols-2 gap-2.5">
          <label className={labelCls}>Тип позиции
            <select value={category} onChange={e => setCategory(e.target.value as ShopItemRow['category'])} className={inputCls}>
              <option value="immaterial">Нематериальный (отгул, поздний старт…)</option>
              <option value="material">Материальный (физический приз)</option>
              <option value="boost">Буст</option>
            </select>
          </label>
          <label className={labelCls} title={`Цена в единицах индексации; сейчас 1 единица = 1 ${currencyName}. Редкость считается от цены — автоматически, ниже.`}>
            Цена в {currencyName}
            <input value={price} onChange={e => setPrice(e.target.value)} className={`${inputCls} text-right tabular-nums`} />
          </label>
          <label className={labelCls} title="Пусто = безлимит">Кол-во (пусто = безлимит)
            <input value={stock} onChange={e => setStock(e.target.value)} placeholder="∞" className={`${inputCls} text-right tabular-nums`} />
          </label>
          <label className={labelCls}>Срок годности предмета, мес
            <input value={ttl} onChange={e => setTtl(e.target.value)} className={`${inputCls} text-right tabular-nums`} />
          </label>
        </div>

        {/* Редкость — рядом с ценой, считается автоматически ОТ ЦЕНЫ (правка
            владельца 04.08, задача 2983). Больше не зависит от минимального
            уровня — тот теперь ниже, отдельным блоком «Порог доступности». */}
        <div className="rounded-xl border border-[var(--color-border)] p-2.5">
          <div className="flex items-center gap-2">
            <span>Редкость (по цене, считается автоматически):</span>
            <RarityBadge priceEball={priceEballNum} />
            {next && (
              <span className="text-[10px]">до «{next.label}» ещё {(next.priceFrom - priceEballNum).toLocaleString('ru-RU')} {currencyName}</span>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            {RARITY_TIERS.map(t => (
              <span key={t.key} style={{ color: t.color }}>{t.label} от {t.priceFrom.toLocaleString('ru-RU')} {currencyName}</span>
            ))}
          </div>
        </div>

        {/* Порог доступности — ЧИСТО антифарм-защита (правка владельца 04.08,
            задача 2983), НЕ влияет на редкость (та считается от цены выше).
            На витрине ниже порога карточка блюрится, кнопка покупки
            неактивна — гейт повторён и на бэкенде (app/api/shop POST). */}
        <div className="rounded-xl border border-[var(--color-border)] p-2.5">
          <label className={labelCls} title="Антифарм-защита: например, чтобы менеджер хитростью за пару месяцев не нафармил дорогой приз. НЕ влияет на редкость.">
            Порог доступности — минимальный уровень для покупки
            <input value={minLevel} onChange={e => setMinLevel(e.target.value)} className={`${inputCls} text-right tabular-nums w-24`} />
          </label>
          <div className="mt-1.5 text-[10px]">
            {minLevelNum > 0
              ? `На витрине ниже ${minLevelNum} ур. карточка показывается заблюренной с подписью «Доступен с ${minLevelNum} уровня», покупка заблокирована (и на сервере тоже).`
              : 'Порог 0 — доступно с первого уровня, карточка не блюрится.'}
          </div>
        </div>

        <label className={labelCls}>Ссылка на товар на маркетплейсе (для примера, откроется в новой вкладке)
          <input value={marketplaceUrl} onChange={e => setMarketplaceUrl(e.target.value)} placeholder="https://..." className={inputCls} />
        </label>

        <div className="grid grid-cols-2 gap-2.5">
          <label className={labelCls} title="Командные позиции теперь только у РОП/директора">Кто может покупать
            <select value={buyerScope} onChange={e => setBuyerScope(e.target.value as ShopItemRow['buyerScope'])} className={inputCls}>
              <option value="all">Все сотрудники</option>
              <option value="rop_only">Только РОП/директор</option>
            </select>
          </label>
          <label className={labelCls} title="Заявка руководителю перед выдачей — как раньше у всех позиций. Выключить — только для мгновенных цифровых позиций.">
            <span className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={requiresApproval} onChange={e => setRequiresApproval(e.target.checked)} />
              Нужно подтверждение руководителя при активации
            </span>
          </label>
          <label className={labelCls} title="Сколько раз одному человеку можно купить — пусто = без лимита">Лимит на человека (шт., пусто = без лимита)
            <input value={perPersonLimit} onChange={e => setPerPersonLimit(e.target.value)} placeholder="∞" className={`${inputCls} text-right tabular-nums`} />
          </label>
          <label className={labelCls} title="Например 90 = раз в квартал. Пусто = лимит на всё время.">Окно лимита, дней (пусто = навсегда)
            <input value={perPersonLimitDays} onChange={e => setPerPersonLimitDays(e.target.value)} placeholder="напр. 90" className={`${inputCls} text-right tabular-nums`} />
          </label>
          <label className={labelCls}>Сортировка на витрине
            <input value={sort} onChange={e => setSort(e.target.value)} className={`${inputCls} text-right tabular-nums`} />
          </label>
        </div>

        {category === 'boost' && (
          <div className="rounded-xl border border-[var(--color-border)] p-2.5">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wider">Параметры буста</div>
            <div className="grid grid-cols-2 gap-2.5">
              <label className={labelCls} title="Свободный текст — на что влияет буст (напр. «XP за продажу», «скорость сделки»)">Метрика
                <input value={boostMetric} onChange={e => setBoostMetric(e.target.value)} placeholder="напр. XP за продажу" className={inputCls} />
              </label>
              <label className={labelCls} title="Например 1.5 = ×1.5">Множитель
                <input value={boostMultiplier} onChange={e => setBoostMultiplier(e.target.value)} placeholder="напр. 1.5" className={`${inputCls} text-right tabular-nums`} />
              </label>
              <label className={labelCls}>Длительность окна, дней
                <input value={boostWindowDays} onChange={e => setBoostWindowDays(e.target.value)} placeholder="напр. 7" className={`${inputCls} text-right tabular-nums`} />
              </label>
              <label className={labelCls} title="Например «отдел продаж №2» или «вся компания»">Область действия
                <input value={boostScope} onChange={e => setBoostScope(e.target.value)} placeholder="напр. отдел / лично" className={inputCls} />
              </label>
            </div>
            <div className="mt-2 text-[10px]">
              Автоматически множитель НЕ применяется — параметры видны руководителю в заявке на активацию,
              применяет он вручную (как и остальные нематериальные позиции).
            </div>
          </div>
        )}

        {error && <div className="text-[var(--color-negative,#e03131)]">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={save.isPending || !name.trim()} onClick={() => { setError(null); save.mutate(); }}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 font-semibold text-white disabled:opacity-50">
            {save.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Таблица каталога: сортировка по клику на заголовок (правило проекта
// 01.08) — цикл убывание → возрастание → дефолт (образец: /rating). ─────────

// 'rarity' сортирует по цене (редкость с 2983 считается от неё — совпадает
// с колонкой «Цена»); 'threshold' — отдельно, по «Порогу доступности» (min_level).
type SortKey = 'name' | 'category' | 'rarity' | 'price' | 'threshold' | 'scope' | 'stock' | 'purchases';
type SortState = { key: SortKey; dir: 'desc' | 'asc' } | null;

function SortableTh({ label, sortKey, sort, onSort, left, title }: {
  label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; left?: boolean; title?: string;
}) {
  const active = sort?.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={title ?? 'Сортировать по колонке'}
      className={`px-2.5 py-2 ${left ? 'text-left' : 'text-right'} font-medium whitespace-nowrap cursor-pointer select-none hover:text-[var(--color-text)] ${active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}`}
    >
      {label}
      <span className="inline-block w-3 text-[10px]">{active ? (sort!.dir === 'desc' ? '▼' : '▲') : ''}</span>
    </th>
  );
}

export function ShopSettingsBlock({ currencyName }: { currencyName: string }) {
  const qc = useQueryClient();
  // Какая позиция редактируется — адресуемо (?item=<id>|new), можно прислать
  // коллеге прямую ссылку на редактирование конкретного товара (задача 2824,
  // useUrlModal — тот же паттерн, что уже используют «Шансы гачи» и т.п.).
  const editModal = useUrlModal('item');
  const { data } = useQuery<{ items: ShopItemRow[]; coinTtlMonths: number; transferFeePercent: number; transferDailyLimit: number }>({
    queryKey: ['settings-shop'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/shop');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['settings-shop'] });
    void qc.invalidateQueries({ queryKey: ['shop'] });
  };

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: number; enabled: boolean }) => {
      const res = await fetch('/api/settings/badges/shop', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: invalidate,
  });

  // Срок жизни MLT (TTL): сгорание ночным тиком, RUB не сгорают.
  const [ttlDraft, setTtlDraft] = useState<string | null>(null);
  const saveTtl = useMutation({
    mutationFn: async (v: number) => {
      const res = await fetch('/api/settings/badges/ttl', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlMonths: v }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => { setTtlDraft(null); invalidate(); },
  });
  const commitTtl = () => {
    const v = Number(ttlDraft);
    if (ttlDraft === null || !Number.isInteger(v) || v <= 0) { setTtlDraft(null); return; }
    saveTtl.mutate(v);
  };

  // Настройки переводов (пакет 31.07): комиссия и дневной лимит.
  const saveTransfer = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/badges/transfer', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['shop-transfer-meta'] });
    },
  });

  // «Релизный старт» — заложенный одноразовый механизм, НЕ запускался.
  const { data: release } = useQuery<{ startedAt: string | null }>({
    queryKey: ['settings-release'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/release');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const [releaseResult, setReleaseResult] = useState<string | null>(null);
  const [releaseStep, setReleaseStep] = useState<'amount' | 'confirm' | null>(null);
  const [releaseAmountInput, setReleaseAmountInput] = useState('3000');
  const [releaseAmountError, setReleaseAmountError] = useState<string | null>(null);
  const [releaseAmount, setReleaseAmount] = useState<number | null>(null);
  const [releaseWordInput, setReleaseWordInput] = useState('');

  const releaseStart = useMutation({
    mutationFn: async ({ amount, confirmWord }: { amount: number; confirmWord: string }) => {
      const res = await fetch('/api/settings/badges/release', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, confirm: confirmWord }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      const j = json as { zeroed: number; granted: number; amount: number };
      setReleaseResult(`Обнулено балансов: ${j.zeroed}, начислено ${j.amount} × ${j.granted} менеджерам`);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings-release'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    },
    onError: (e) => setReleaseResult(e instanceof Error ? e.message : String(e)),
  });

  function openReleaseStart() {
    setReleaseResult(null);
    setReleaseAmountInput('3000');
    setReleaseAmountError(null);
    setReleaseStep('amount');
  }
  function submitReleaseAmount() {
    const v = Number(releaseAmountInput);
    if (!Number.isInteger(v) || v <= 0) { setReleaseAmountError('Сумма — целое число больше нуля'); return; }
    setReleaseAmount(v);
    setReleaseWordInput('');
    setReleaseStep('confirm');
  }
  function submitReleaseConfirm() {
    if (releaseAmount === null) return;
    const amount = releaseAmount;
    const confirmWord = releaseWordInput.trim();
    setReleaseStep(null);
    releaseStart.mutate({ amount, confirmWord });
  }

  const items = data?.items ?? [];

  // Сортировка таблицы каталога — локальное состояние (декор вида, не
  // адресуется), образец `/rating`: 3-й клик по той же колонке = дефолт.
  const [sort, setSort] = useState<SortState>(null);
  const onSort = (key: SortKey) => setSort(prev => {
    if (prev?.key !== key) return { key, dir: 'desc' };
    if (prev.dir === 'desc') return { key, dir: 'asc' };
    return null;
  });
  const sortedItems = useMemo(() => {
    if (!sort) return items;
    const val = (i: ShopItemRow): number | string => {
      if (sort.key === 'name') return i.name.toLowerCase();
      if (sort.key === 'category') return TYPE_LABELS[i.category];
      if (sort.key === 'rarity') return i.priceEball;
      if (sort.key === 'price') return i.priceEball;
      if (sort.key === 'threshold') return i.minLevel;
      if (sort.key === 'scope') return SCOPE_LABELS[i.buyerScope];
      if (sort.key === 'stock') return i.stock ?? Infinity;
      return i.purchases;
    };
    const mult = sort.dir === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
      const va = val(a); const vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * mult;
      if (va !== vb) return (va - vb) * mult;
      return a.sort - b.sort;
    });
  }, [items, sort]);

  const editingItem = editModal.openKey && editModal.openKey !== 'new'
    ? items.find(i => String(i.id) === editModal.openKey) ?? null
    : null;
  const editorOpen = editModal.openKey === 'new' || editingItem !== null;

  return (
    <div className="mb-5 mt-8 border-t border-[var(--color-border)] pt-5">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">Магазин призов и бустов — заполнятор товаров</h2>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title={`Начисления «${currencyName}» живут этот срок, затем сгорают ночным пересчётом (FIFO: траты гасят старейшие). Рубли не сгорают.`}>
          Срок жизни {currencyName}, мес
          <input
            value={ttlDraft ?? String(data?.coinTtlMonths ?? '')}
            onChange={e => setTtlDraft(e.target.value)}
            onBlur={commitTtl}
            onKeyDown={e => { if (e.key === 'Enter') commitTtl(); }}
            className="w-14 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title="Комиссия за перевод MLT коллеге, % — сжигается">
          Комиссия переводов, %
          <SettingsNum value={data?.transferFeePercent ?? 5}
            onCommit={v => saveTransfer.mutate({ feePercent: v })} w="w-12" allowZero />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
          title="Дневной лимит суммы исходящих переводов на менеджера">
          Лимит переводов/день
          <SettingsNum value={data?.transferDailyLimit ?? 500}
            onCommit={v => saveTransfer.mutate({ dailyLimit: v })} w="w-16" />
        </label>
        <button type="button" onClick={() => editModal.open('new')}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white">
          + Добавить товар / буст
        </button>
        <span className="ml-auto inline-flex items-center gap-2">
          {release?.startedAt ? (
            <span className="text-xs text-[var(--color-text-muted)]" title="Одноразовая операция уже выполнена">
              Релизный старт выполнен {release.startedAt}
            </span>
          ) : (
            <button type="button" onClick={openReleaseStart}
              disabled={releaseStart.isPending}
              title="Одноразово: обнулить все ретро-балансы и начислить всем одинаковый старт (полки и рубли не трогаются). Запускается только на официальном релизе!"
              className="rounded-lg border border-[var(--color-negative,#e03131)] px-3 py-1 text-xs font-semibold text-[var(--color-negative,#e03131)] disabled:opacity-50">
              Релизный старт…
            </button>
          )}
          {releaseResult && <span className="text-xs text-[var(--color-text-muted)]">{releaseResult}</span>}
        </span>
      </div>
      <div className="mb-2 text-xs text-[var(--color-text-muted)]">
        Всё продаётся только за {currencyName} — рублёвых цен на витрине больше нет. Эмодзи заменяет фото карточки:
        картинок не грузим и не храним нигде принципиально. Редкость считается от цены автоматически; «Порог
        доступности» (минимальный уровень) — отдельная антифарм-защита, на редкость не влияет.
        Удаления нет — выключайте позицию, история покупок сохраняется.
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">Каталог пуст — добавьте первую позицию.</p>
      ) : (
        <div className="scroll-x rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)]">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-[var(--color-table-header)]">
                <th className="px-2.5 py-2 text-left font-medium text-[var(--color-text-muted)]"> </th>
                <SortableTh label="Название" sortKey="name" sort={sort} onSort={onSort} left />
                <SortableTh label="Тип" sortKey="category" sort={sort} onSort={onSort} left />
                <SortableTh label="Редкость" sortKey="rarity" sort={sort} onSort={onSort} title="Считается от цены (колонка справа) · сортировать" />
                <SortableTh label={`Цена, ${currencyName}`} sortKey="price" sort={sort} onSort={onSort} />
                <SortableTh label="Порог доступности" sortKey="threshold" sort={sort} onSort={onSort} title="Минимальный уровень для покупки (антифарм-защита, на редкость не влияет) · сортировать" />
                <SortableTh label="Кто покупает" sortKey="scope" sort={sort} onSort={onSort} left />
                <SortableTh label="Сток" sortKey="stock" sort={sort} onSort={onSort} title="Пустые значения (безлимит) — внизу при сортировке · сортировать" />
                <SortableTh label="Покупок" sortKey="purchases" sort={sort} onSort={onSort} />
                <th className="px-2.5 py-2 text-left font-medium text-[var(--color-text-muted)]">Действия</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((i, idx) => (
                <tr key={i.id} className={`border-t border-[var(--color-border)] ${i.enabled ? '' : 'opacity-50'} ${idx % 2 === 1 ? 'bg-[var(--color-table-stripe)]' : ''}`}>
                  <td className="px-2.5 py-2 text-xl">{i.emoji}</td>
                  <td className="px-2.5 py-2">
                    <div className="font-semibold text-[var(--color-text)]">{i.name}</div>
                    {i.description && <div className="max-w-[220px] truncate text-[var(--color-text-muted)]" title={i.description}>{i.description}</div>}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">{TYPE_LABELS[i.category]}</td>
                  <td className="px-2.5 py-2 text-right whitespace-nowrap">
                    <RarityBadge priceEball={i.priceEball} />
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-[var(--color-accent)]">
                    <span className="inline-flex items-center gap-1"><MltCoin size={13} title={currencyName} />{i.priceEball.toLocaleString('ru-RU')}</span>
                  </td>
                  <td className="px-2.5 py-2 text-right tabular-nums whitespace-nowrap text-[var(--color-text-muted)]" title="Антифарм-защита — не влияет на редкость">
                    {i.minLevel > 0 ? `с ${i.minLevel} ур.` : '—'}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap">{SCOPE_LABELS[i.buyerScope]}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums" title="сток">{i.stock === null ? '∞' : i.stock}</td>
                  <td className="px-2.5 py-2 text-right tabular-nums" title="покупок">{i.purchases}×</td>
                  <td className="px-2.5 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => editModal.open(String(i.id))}
                        className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 hover:bg-[var(--color-bg-hover)]">
                        Изменить
                      </button>
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input type="checkbox" checked={i.enabled}
                          onChange={e => toggle.mutate({ id: i.id, enabled: e.target.checked })} />
                        вкл
                      </label>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editorOpen && (
        <ItemEditor
          item={editingItem}
          currencyName={currencyName}
          onClose={() => editModal.close()}
          onSaved={() => { editModal.close(); invalidate(); }}
        />
      )}

      <Modal
        open={releaseStep === 'amount'}
        onOpenChange={(o) => { if (!o) setReleaseStep(null); }}
        title="Релизный старт (необратимо, одноразово)"
        desktopWidth="sm:max-w-sm"
      >
        <div className="text-sm text-[var(--color-text)] whitespace-pre-line">
          {`— все текущие балансы «${currencyName}» будут ОБНУЛЕНЫ;\n— каждому активному менеджеру начислится одинаковый старт;\n— награды на полках и рубли НЕ трогаются.`}
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Сумма стартового начисления
          <input
            autoFocus type="number" inputMode="numeric" value={releaseAmountInput}
            onChange={e => setReleaseAmountInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submitReleaseAmount(); }}
            className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm text-right tabular-nums"
          />
        </label>
        {releaseAmountError && <div className="mt-1.5 text-xs text-[var(--color-negative,#e03131)]">{releaseAmountError}</div>}
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setReleaseStep(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" onClick={submitReleaseAmount} className="rounded-lg bg-[var(--color-negative,#e03131)] px-4 py-1.5 text-xs font-semibold text-white">Далее</button>
        </div>
      </Modal>

      <Modal
        open={releaseStep === 'confirm'}
        onOpenChange={(o) => { if (!o) setReleaseStep(null); }}
        title="Подтверждение релизного старта"
        desktopWidth="sm:max-w-sm"
      >
        <div className="text-sm text-[var(--color-text)]">
          Для подтверждения введите слово <strong>РЕЛИЗ</strong> (начислится по {releaseAmount} {currencyName} каждому активному менеджеру):
        </div>
        <input
          autoFocus value={releaseWordInput}
          onChange={e => setReleaseWordInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitReleaseConfirm(); }}
          className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-base sm:text-sm"
          placeholder="РЕЛИЗ"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setReleaseStep(null)} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={releaseStart.isPending} onClick={submitReleaseConfirm}
            className="rounded-lg bg-[var(--color-negative,#e03131)] px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {releaseStart.isPending ? 'Подождите…' : 'Подтвердить'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function SettingsNum({ value, onCommit, w, allowZero }: { value: number; onCommit: (v: number) => void; w: string; allowZero?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const v = Number(draft);
    if (draft === null || !Number.isFinite(v) || (allowZero ? v < 0 : v <= 0) || v === value) { setDraft(null); return; }
    onCommit(v); setDraft(null);
  };
  return (
    <input value={draft ?? String(value)} onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }}
      className={`${w} rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-right text-xs tabular-nums`} />
  );
}
