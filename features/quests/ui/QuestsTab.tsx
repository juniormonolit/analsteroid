'use client';

// Таб «Квесты» ЛК (миграция 125, дизайн-док Софьи + тиры v2): 4 карточки слотов
// (дневной / 2 недельных / месячный, + докупленные), цвет карточки по тиру,
// прогресс-бар, награда «N MLT + M XP», таймер, реролл за MLT; ниже —
// история 8 недель со счётчиками по тирам. РОПу — сводка по команде.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NoData } from '@/components/ui/NoData';
import { Confetti } from '@/features/badges/ui/GachaBlock';
import { PinDialog } from '@/components/ui/PinDialog';
import { PinSetupDialog } from '@/components/ui/PinSetupDialog';
import { fetchPinGated } from '@/lib/client/pinFetch';

type Tier = 'white' | 'green' | 'blue' | 'epic' | 'legendary';
type Slot = 'day' | 'week1' | 'week2' | 'month' | 'extra';

interface QuestRow {
  id: number; slot: Slot; periodType: 'day' | 'week' | 'month';
  periodStart: string; periodEnd: string; category: string;
  target: number; targetGroup: string | null; pairFirst: string | null;
  title: string; tier: Tier; rewardEballs: number; rewardXp: number;
  status: 'active' | 'done' | 'failed'; progress: number; doneAt: string | null;
  rerollOf: number | null;
}
interface ContractRow {
  id: number; title: string; tier: Tier; category: string; target: number; days: number;
  rewardEballs: number; rewardXp: number; deposit: number;
  status: 'open' | 'taken' | 'done' | 'failed' | 'expired';
  deadline: string | null; progress: number;
}
interface ApiResponse {
  current: QuestRow[]; history: QuestRow[];
  contracts: { mine: ContractRow[]; open: ContractRow[] };
  isSelf: boolean; workday: boolean;
  prices: { rerollDay: number; rerollWeek: number; rerollMonth: number; extra: number };
  xpMult: number;
}

const TIER_LABELS: Record<Tier, string> = {
  white: 'Обычный', green: 'Необычный', blue: 'Редкий', epic: 'Эпический', legendary: 'Легендарный',
};
const TIER_COLORS: Record<Tier, string> = {
  white: '#9ca3af', green: '#2f9e44', blue: '#1c7ed6', epic: '#9c36b5', legendary: '#e8590c',
};
const SLOT_LABELS: Record<Slot, string> = {
  day: 'Дневной', week1: 'Недельный', week2: 'Недельный', month: 'Месячный', extra: 'Доп. квест',
};

// Эмодзи по категории квеста/контракта («сделать повеселей» — правка владельца
// 05.08). Ключи — category из миграции 125 (quests) и 126 (quest_contracts).
const CATEGORY_EMOJI: Record<string, string> = {
  sales_count: '🤝',
  sales_amount: '💰',
  group_sales: '📦',
  repeat_sales: '🔁',
  crosssell: '🧲',
  distinct_groups: '🧩',
};
const categoryEmoji = (category: string) => CATEGORY_EMOJI[category] ?? '⚔️';

function daysLeft(endIso: string): string {
  const end = new Date(`${endIso.slice(0, 10)}T23:59:59+03:00`).getTime();
  const d = Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
  if (d <= 0) return 'последний день';
  if (d === 1) return 'до конца дня';
  return `ещё ${d} дн.`;
}
const fmtNum = (v: number) => v >= 10000 ? v.toLocaleString('ru-RU') : String(Math.round(v * 10) / 10);

function QuestCard({ q, prices, isSelf, onReroll, busy, fresh = false }: {
  q: QuestRow; prices: ApiResponse['prices']; isSelf: boolean;
  onReroll: (id: number) => void; busy: boolean;
  /** Выполнен после прошлого визита — светится рамкой (решение владельца 05.08). */
  fresh?: boolean;
}) {
  const color = TIER_COLORS[q.tier];
  const pctDone = Math.min(100, Math.round((q.progress / Math.max(q.target, 1)) * 100));
  const rerollPrice = q.periodType === 'day' ? prices.rerollDay : q.periodType === 'week' ? prices.rerollWeek : prices.rerollMonth;
  const done = q.status === 'done';
  return (
    <div className="flex flex-col gap-2 rounded-2xl border-2 p-3"
      style={{
        borderColor: done ? 'var(--color-positive, #2f9e44)' : `color-mix(in srgb, ${color} 60%, transparent)`,
        backgroundColor: done
          ? 'color-mix(in srgb, var(--color-positive, #2f9e44) 8%, transparent)'
          : `color-mix(in srgb, ${color} 6%, transparent)`,
        ...(fresh ? { animation: 'quest-fresh-glow 1.4s ease-in-out infinite alternate' } : {}),
      }}>
      <div className="flex items-center gap-2">
        <span className="rounded-lg px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ color: 'white', backgroundColor: color }}
          title={`Тир сложности: ${TIER_LABELS[q.tier]} (относительно медианного менеджера компании)`}>
          {TIER_LABELS[q.tier]}
        </span>
        <span className="text-[11px] font-semibold text-[var(--color-text-muted)]">{SLOT_LABELS[q.slot]}</span>
        <span className="ml-auto text-[11px] tabular-nums text-[var(--color-text-muted)]">
          {done ? '✅ выполнен' : q.status === 'failed' ? 'сгорел' : daysLeft(q.periodEnd)}
        </span>
      </div>
      <div className="flex items-start gap-2">
        <span className="text-2xl leading-none select-none" aria-hidden>{categoryEmoji(q.category)}</span>
        <span className="text-sm font-bold text-[var(--color-text)]">{q.title}</span>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[11px] tabular-nums text-[var(--color-text-muted)]">
          <span>{fmtNum(q.progress)} из {fmtNum(q.target)}</span>
          <span className="font-bold" style={{ color: 'var(--color-accent)' }}>
            +{q.rewardEballs} MLT · +{q.rewardXp} XP
          </span>
        </div>
        <div className="h-2 rounded-full bg-[var(--color-bg-hover)]">
          <div className="h-2 rounded-full" style={{ width: `${Math.max(pctDone, 2)}%`, backgroundColor: done ? 'var(--color-positive, #2f9e44)' : color }} />
        </div>
      </div>
      {isSelf && q.status === 'active' && q.rerollOf === null && (
        <button type="button" disabled={busy} onClick={() => onReroll(q.id)}
          className="w-fit rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-[11px] font-semibold hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
          title="Заменить квест на другой того же тира (списываются MLT; максимум одна замена)">
          Заменить ({rerollPrice})
        </button>
      )}
    </div>
  );
}

export function QuestsTab({ managerId, isSelf }: { managerId: string; isSelf: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Реролл/доп. квест — списание с СВОЕГО кошелька под личный порог (спека §3):
  // недорогая операция чаще проходит без пина, но выше порога/при исчерпанном
  // суточном потолке бэк просит пин — тот же паттерн, что уже обкатан в
  // покупке магазина и рублёвом кошельке. payload хранит тело последней
  // попытки, чтобы дослать его же с полем pin.
  const [pinSetupPayload, setPinSetupPayload] = useState<Record<string, unknown> | null>(null);
  const [pinVerifyPayload, setPinVerifyPayload] = useState<Record<string, unknown> | null>(null);
  const { data, isLoading, isError } = useQuery<ApiResponse>({
    queryKey: ['quests', isSelf ? 'me' : managerId],
    queryFn: async () => {
      const qs = isSelf ? '' : `?bitrixId=${encodeURIComponent(managerId)}`;
      const res = await fetch(`/api/quests${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const refreshQuests = () => {
    void qc.invalidateQueries({ queryKey: ['quests'] });
    void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
    void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
  };

  // Подсветка свежевыполненных (решение владельца 05.08: БЕЗ клейм-кнопок —
  // награда начислена автоматом, а выполненный квест светится рамкой + даёт
  // фейерверк ДО ПЕРВОГО ВХОДА в раздел). «Видел» запоминается в localStorage
  // на устройстве (v1; серверный read-state придёт с общей механикой
  // уведомлений). Отметка пишется сразу при показе — текущий визит светится
  // целиком, следующий уже нет.
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (!data || !isSelf) return;
    const key = 'quests-seen-ts';
    const last = Number(localStorage.getItem(key) ?? 0);
    const doneNow = data.current.filter(q => q.status === 'done' && q.doneAt);
    const fresh = doneNow.filter(q => new Date(q.doneAt!).getTime() > last);
    if (fresh.length > 0) setFreshIds(new Set(fresh.map(q => q.id)));
    const maxDone = Math.max(last, ...doneNow.map(q => new Date(q.doneAt!).getTime()));
    if (maxDone > last) localStorage.setItem(key, String(maxDone));
  }, [data, isSelf]);

  const takeC = async (contractId: number) => {
    setBusy(true);
    try {
      const res = await fetch('/api/quests/contracts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contractId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        alert((j as { error?: string } | null)?.error ?? `Ошибка ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: ['quests'] });
    } finally { setBusy(false); }
  };

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetchPinGated('/api/quests/reroll', 'POST', payload);
      if (r.ok) { refreshQuests(); return; }
      if (r.needsPinSetup) { setPinSetupPayload(payload); return; }
      if (r.needsPinVerify) { setPinVerifyPayload(payload); return; }
      setError(r.error ?? 'Ошибка');
    } finally { setBusy(false); }
  };

  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загружаем квесты… (первое открытие может занять до минуты)</div>;
  if (isError || !data) return <div className="text-sm text-[var(--color-negative,#e03131)]">Не удалось загрузить квесты.</div>;

  const current = data.current;
  const history = data.history;
  const doneByTier: Partial<Record<Tier, number>> = {};
  let failedCnt = 0;
  for (const h of history) {
    if (h.status === 'done') doneByTier[h.tier] = (doneByTier[h.tier] ?? 0) + 1;
    else failedCnt++;
  }
  const dayDone = current.some(q => q.slot === 'day' && q.status === 'done');

  return (
    // Центрированная колонка как у «Профиля» (правка владельца 05.08: «привести
    // к той же вёрстке, не растянутой на весь экран») + три ВИЗУАЛЬНО разные
    // секции: личные миссии / взятые с доски / доска контрактов.
    <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-4 sm:gap-5">
      {/* ══ 1. Личные миссии (регулярные слоты) ══ */}
      <section className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        {/* Пульс рамки свежевыполненного + фейерверк один раз при заходе. */}
        <style>{`@keyframes quest-fresh-glow {
          from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-positive, #2f9e44) 55%, transparent); }
          to { box-shadow: 0 0 0 7px color-mix(in srgb, var(--color-positive, #2f9e44) 12%, transparent); }
        }`}</style>
        {freshIds.size > 0 && <Confetti />}
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <h3 className="text-base font-bold text-[var(--color-text)]">⚔️ Личные миссии</h3>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            цели — от вашей истории продаж (120% медианы), тир — от сложности против медианного менеджера.
            Выполнил — MLT и XP сразу; провалил — ничего не теряешь. Замена и доп. квест — за MLT
          </span>
        </div>
        {current.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            Квестов пока нет{data.workday ? ' — обновите страницу' : ' (сегодня не рабочий день; недельные и месячный появятся при генерации)'}.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {current.map(q => (
              <QuestCard key={q.id} q={q} prices={data.prices} isSelf={isSelf} onReroll={id => void act({ questId: id })} busy={busy} fresh={freshIds.has(q.id)} />
            ))}
          </div>
        )}
        {isSelf && dayDone && data.workday && (
          <button type="button" disabled={busy} onClick={() => void act({ action: 'extra' })}
            className="mt-3 w-fit rounded-xl border border-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40"
            title="Дневной выполнен — можно докупить ещё один квест на сегодня (цена удваивается за каждый следующий на неделе)">
            ✨ Ещё квест ({data.prices.extra})
          </button>
        )}
        {error && <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
      </section>

      {/* ══ 2. Взятые с доски — отдельно от пула (правка владельца 05.08):
             раньше «мои» контракты лежали строчками ВНУТРИ доски и сливались с ней ══ */}
      {(data.contracts?.mine ?? []).length > 0 && (
        <section className="rounded-2xl border-2 border-[var(--color-accent-soft)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
          <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
            <h3 className="text-base font-bold text-[var(--color-text)]">🎯 Взятые с доски</h3>
            <span className="text-[11px] text-[var(--color-text-muted)]">ваши контракты в работе: депозит заморожен до развязки</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {data.contracts.mine.map(c => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-[12px]"
                style={{ borderColor: `color-mix(in srgb, ${TIER_COLORS[c.tier]} 60%, transparent)`,
                  backgroundColor: c.status === 'done' ? 'color-mix(in srgb, var(--color-positive,#2f9e44) 8%, transparent)'
                    : `color-mix(in srgb, ${TIER_COLORS[c.tier]} 6%, transparent)` }}>
                <span className="text-lg leading-none select-none" aria-hidden>{categoryEmoji(c.category)}</span>
                <span className="rounded px-1 text-[10px] font-bold text-white" style={{ backgroundColor: TIER_COLORS[c.tier] }}>{TIER_LABELS[c.tier]}</span>
                <span className={c.status === 'failed' ? 'line-through text-[var(--color-text-muted)]' : 'font-semibold text-[var(--color-text)]'}>{c.title}</span>
                <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">
                  {c.status === 'taken' && `${fmtNum(c.progress)} / ${fmtNum(c.target)} · до ${c.deadline?.split('-').reverse().join('.')}`}
                  {c.status === 'done' && `✅ +${c.rewardEballs} (депозит вернулся)`}
                  {c.status === 'failed' && `✕ депозит ${c.deposit} сгорел`}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ══ 3. Доска контрактов (миграция 126): общий пул, депозит, любой тир ══ */}
      <section className="rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-4 sm:px-5 py-4">
        <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
          <h3 className="text-base font-bold text-[var(--color-text)]">📜 Доска контрактов</h3>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            общий пул: бери любой тир добровольно; при взятии замораживается депозит — выполнил: депозит назад + награда (+ шанс лутдропа), провалил — депозит сгорает
          </span>
        </div>
        {(data.contracts?.open ?? []).length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)]">Доска пуста — новый пул появится с генерацией.</div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {data.contracts.open.map(c => (
              <div key={c.id} className="flex flex-col gap-1.5 rounded-xl border-2 p-2.5 bg-[var(--color-bg-surface)]"
                style={{ borderColor: `color-mix(in srgb, ${TIER_COLORS[c.tier]} 60%, transparent)` }}>
                <div className="flex items-center gap-1.5">
                  <span className="rounded px-1 text-[10px] font-bold text-white" style={{ backgroundColor: TIER_COLORS[c.tier] }}>{TIER_LABELS[c.tier]}</span>
                  <span className="ml-auto text-[11px] tabular-nums text-[var(--color-text-muted)]">{c.days} дн.</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <span className="text-xl leading-none select-none" aria-hidden>{categoryEmoji(c.category)}</span>
                  <span className="text-[12px] font-semibold text-[var(--color-text)]">{c.title}</span>
                </div>
                <div className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
                  +{c.rewardEballs} еб · +{c.rewardXp} XP · депозит <b>{c.deposit}</b>
                </div>
                {isSelf && (
                  <button type="button" disabled={busy} onClick={() => void takeC(c.id)}
                    className="w-fit rounded-lg border border-[var(--color-accent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] disabled:opacity-40">
                    Взять (депозит {c.deposit})
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <h3 className="text-sm font-bold text-[var(--color-text)]">🗂️ История за 8 недель</h3>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            закрыто: {(['white', 'green', 'blue', 'epic', 'legendary'] as Tier[])
              .filter(t => (doneByTier[t] ?? 0) > 0)
              .map(t => `${doneByTier[t]} ${TIER_LABELS[t].toLowerCase()}`).join(', ') || '—'}
            {failedCnt > 0 && ` · сгорело: ${failedCnt}`}
          </span>
        </div>
        {history.length === 0 ? (
          <div className="text-xs text-[var(--color-text-muted)]">Пока пусто — первые квесты в работе.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {history.map(h => (
              <div key={h.id} className="flex items-center gap-2 text-[12px]">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLORS[h.tier] }} title={TIER_LABELS[h.tier]} />
                <span className={h.status === 'done' ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)] line-through'}>
                  {h.title}
                </span>
                <span className="ml-auto whitespace-nowrap tabular-nums text-[var(--color-text-muted)]">
                  {h.periodEnd.slice(0, 10).split('-').reverse().join('.')} ·
                  {h.status === 'done' ? ` +${h.rewardEballs}` : ' сгорел'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <PinSetupDialog
        open={!!pinSetupPayload}
        onOpenChange={(o) => { if (!o) setPinSetupPayload(null); }}
        onSuccess={() => { const p = pinSetupPayload; setPinSetupPayload(null); if (p) void act(p); }}
      />
      <PinDialog
        open={!!pinVerifyPayload}
        onOpenChange={(o) => { if (!o) setPinVerifyPayload(null); }}
        title={pinVerifyPayload?.action === 'extra' ? 'Подтвердите доп. квест пином' : 'Подтвердите замену квеста пином'}
        onConfirm={async (pin) => {
          if (!pinVerifyPayload) return { ok: false, error: 'Нет операции' };
          const r = await fetchPinGated('/api/quests/reroll', 'POST', { ...pinVerifyPayload, pin });
          if (!r.ok) return { ok: false, error: r.error ?? 'Ошибка' };
          setPinVerifyPayload(null);
          setError(null);
          refreshQuests();
          return { ok: true };
        }}
      />
    </div>
  );
}

// ── РОП: сводка квестов команды ──────────────────────────────────────────────

interface TeamQuestRow {
  bitrixId: number; name: string;
  current: { slot: Slot; title: string; tier: Tier; status: string; progress: number; target: number }[];
  stats: { done: Partial<Record<Tier, number>>; failed: number };
}

export function TeamQuestsBlock() {
  const { data, isLoading } = useQuery<{ team: TeamQuestRow[] }>({
    queryKey: ['quests-team'],
    queryFn: async () => {
      const res = await fetch('/api/quests/team');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const team = data?.team ?? [];

  if (isLoading) return <div className="text-sm text-[var(--color-text-muted)]">Загружаем квесты команды…</div>;
  if (team.length === 0) {
    return (
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
        <NoData what="квестов команды" hint="Квесты появятся, когда у подчинённых начнётся их период." />
      </section>
    );
  }

  // Разбивка ПО ТИПАМ КВЕСТА, а не по людям (уточнение владельца 05.08:
  // «он должен видеть не свои квесты, а квесты всего отдела с разбивкой на
  // ежедневные и так далее по своим менеджерам. Цель — помогать достигать
  // выполнения квестов»). Поэтому внутри каждого типа строки отсортированы
  // «кому нужнее помощь»: активные с наименьшим прогрессом сверху, выполненные —
  // в конец.
  const GROUPS: { key: 'day' | 'week' | 'month'; label: string; slots: Slot[] }[] = [
    { key: 'day', label: '☀️ Ежедневные', slots: ['day', 'extra'] },
    { key: 'week', label: '📅 Недельные', slots: ['week1', 'week2'] },
    { key: 'month', label: '🗓️ Месячные', slots: ['month'] },
  ];

  type Line = { name: string; bitrixId: number; q: TeamQuestRow['current'][number] };
  const linesOf = (slots: Slot[]): Line[] => {
    const out: Line[] = [];
    for (const m of team) {
      for (const q of m.current) {
        if (!slots.includes(q.slot)) continue;
        out.push({ name: m.name, bitrixId: m.bitrixId, q });
      }
    }
    return out.sort((a, b) => {
      const doneA = a.q.status === 'done' ? 1 : 0, doneB = b.q.status === 'done' ? 1 : 0;
      if (doneA !== doneB) return doneA - doneB;                 // невыполненные выше
      const pa = a.q.target > 0 ? a.q.progress / a.q.target : 0;
      const pb = b.q.target > 0 ? b.q.progress / b.q.target : 0;
      return pa - pb;                                            // кому нужнее помощь
    });
  };

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🗺️ Квесты команды</h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          кому нужна помощь — выше; выполненные внизу группы
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {GROUPS.map(g => {
          const lines = linesOf(g.slots);
          if (lines.length === 0) return null;
          const done = lines.filter(l => l.q.status === 'done').length;
          return (
            <div key={g.key}>
              <div className="mb-1.5 flex items-baseline gap-2">
                <span className="text-[12px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{g.label}</span>
                <span className="text-[12px] tabular-nums text-[var(--color-text-muted)]">
                  {done} из {lines.length} выполнено
                </span>
              </div>
              <div className="flex flex-col">
                {lines.map((l, i) => {
                  const pct = l.q.target > 0 ? Math.min(100, Math.round((l.q.progress / l.q.target) * 100)) : 0;
                  const isDone = l.q.status === 'done';
                  return (
                    <div key={`${l.bitrixId}-${i}`}
                      className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[var(--color-border)] py-2 first:border-t-0 text-[12.5px]">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TIER_COLORS[l.q.tier] }} title={TIER_LABELS[l.q.tier]} />
                      <Link href={`/profile/${l.bitrixId}`}
                        className="font-semibold text-[var(--color-text)] hover:underline shrink-0">
                        {l.name}
                      </Link>
                      <span className="text-[var(--color-text-muted)] min-w-0 flex-1 truncate" title={l.q.title}>{l.q.title}</span>
                      <span className="w-24 shrink-0">
                        <span className="block h-1.5 rounded-full bg-[var(--color-bg-hover)]">
                          <span className="block h-1.5 rounded-full"
                            style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: isDone ? 'var(--color-positive)' : TIER_COLORS[l.q.tier] }} />
                        </span>
                      </span>
                      <span className="w-24 shrink-0 text-right tabular-nums text-[var(--color-text-muted)]">
                        {isDone ? '✅ готово' : `${fmtNum(l.q.progress)} / ${fmtNum(l.q.target)}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Итоги за 8 недель — кто сколько закрыл (было основным видом, теперь сводка). */}
      <div className="mt-4 border-t border-[var(--color-border)] pt-3">
        <div className="mb-1.5 text-[12px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
          Закрыто за 8 недель
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {team.map(m => {
            const total = (['white', 'green', 'blue', 'epic', 'legendary'] as Tier[])
              .reduce((sum, t) => sum + (m.stats.done[t] ?? 0), 0);
            return (
              <span key={m.bitrixId} className="text-[12px] text-[var(--color-text-muted)] whitespace-nowrap">
                <Link href={`/profile/${m.bitrixId}`} className="text-[var(--color-text)] hover:underline">{m.name}</Link>
                <b className="ml-1 tabular-nums text-[var(--color-text)]">{total}</b>
                {m.stats.failed > 0 && <span className="ml-1">· ✕{m.stats.failed}</span>}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
