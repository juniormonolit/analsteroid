'use client';

// Таб «Квесты» ЛК (миграция 125, дизайн-док Софьи + тиры v2): 4 карточки слотов
// (дневной / 2 недельных / месячный, + докупленные), цвет карточки по тиру,
// прогресс-бар, награда «N MLT + M XP», таймер, реролл за MLT; ниже —
// история 8 недель со счётчиками по тирам. РОПу — сводка по команде.

import { Fragment, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

function QuestCard({ q, prices, isSelf, onReroll, busy }: {
  q: QuestRow; prices: ApiResponse['prices']; isSelf: boolean;
  onReroll: (id: number) => void; busy: boolean;
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
      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
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
              <QuestCard key={q.id} q={q} prices={data.prices} isSelf={isSelf} onReroll={id => void act({ questId: id })} busy={busy} />
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
  const [open, setOpen] = useState<number | null>(null);
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
  if (isLoading || team.length === 0) return null;

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">🗺️ Квесты команды</h2>
        <span className="text-xs text-[var(--color-text-muted)]">кто что выполняет; счётчики — за 8 недель</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {team.map(m => {
          const active = m.current.filter(q => q.status === 'active').length;
          const doneNow = m.current.filter(q => q.status === 'done').length;
          return (
            <Fragment key={m.bitrixId}>
              <button type="button" onClick={() => setOpen(v => (v === m.bitrixId ? null : m.bitrixId))}
                className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-[var(--color-border)] px-3 py-2 text-left hover:bg-[var(--color-bg-hover)]">
                <span className="text-sm font-semibold text-[var(--color-text)]">{m.name}</span>
                <span className="text-[11px] text-[var(--color-text-muted)]">в работе {active} · выполнено сейчас {doneNow}</span>
                <span className="ml-auto flex items-center gap-1.5 text-[11px] tabular-nums">
                  {(['white', 'green', 'blue', 'epic', 'legendary'] as Tier[]).map(t => {
                    const n = m.stats.done[t] ?? 0;
                    if (n === 0) return null;
                    return (
                      <span key={t} className="inline-flex items-center gap-0.5" title={`Закрыто ${TIER_LABELS[t].toLowerCase()}: ${n}`}>
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLORS[t] }} />{n}
                      </span>
                    );
                  })}
                  {m.stats.failed > 0 && <span className="text-[var(--color-text-muted)]">✕ {m.stats.failed}</span>}
                </span>
              </button>
              {open === m.bitrixId && (
                <div className="ml-3 flex flex-col gap-1 pb-1">
                  {m.current.length === 0 && <span className="text-xs text-[var(--color-text-muted)]">Активных квестов нет.</span>}
                  {m.current.map((q, i) => (
                    <div key={i} className="flex items-center gap-2 text-[12px]">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_COLORS[q.tier] }} title={TIER_LABELS[q.tier]} />
                      <span className="text-[var(--color-text)]">{q.title}</span>
                      <span className="ml-auto tabular-nums text-[var(--color-text-muted)]">
                        {q.status === 'done' ? '✅' : `${fmtNum(q.progress)} / ${fmtNum(q.target)}`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
