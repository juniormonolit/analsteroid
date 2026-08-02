'use client';
// Гача (фаза 2, «го» Серёги 31.07): вращающееся колесо. ВАЖНО: результат
// определяется НА СЕРВЕРЕ (POST /api/shop/gacha, RNG в транзакции) — колесо
// лишь отыгрывает уже известный tier_key (анимация — театр, сервер — истина;
// запрос без тела, фронт не может повлиять на исход). SVG + CSS-transition
// с cubic-bezier-замедлением, конфетти на редких/джекпоте, без внешних CDN.

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MltCoin } from '@/components/icons/MltCoin';

interface PoolTier {
  tierKey: string; name: string; icon: string; rarity: 'common' | 'rare' | 'jackpot';
  prizeType: 'eball' | 'item'; eballAmount: number | null; chancePpm: number; soldOut: boolean;
}
interface SpinHistoryRow {
  id: number; tier_key: string; rarity: string; prize_name: string;
  eball_amount: number | null; forced_by_pity: boolean; at: string;
}
interface GachaData {
  enabled: boolean; spinCost: number; currencyName: string; balance: number;
  limits: { daily: number; weekly: number; dayLeft: number; weekLeft: number };
  pity: { counter: number; softFrom: number; hardAt: number; toGuarantee: number };
  pool: PoolTier[]; history: SpinHistoryRow[];
}
interface SpinResultView {
  tierKey: string; name: string; icon: string; rarity: string;
  prizeType: 'eball' | 'item'; eballAmount: number | null; forcedByPity: boolean;
  pityAfter: number; balanceAfter: number;
}

function fmtChance(ppm: number): string {
  const pct = ppm / 10000;
  return `${pct.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}%`;
}

const RARITY_COLOR: Record<string, string> = {
  common: 'var(--color-accent)',
  rare: '#e8590c',
  jackpot: '#9c36b5',
};

// Секторы колеса — РАВНЫЕ по ширине (визуальный театр; честные вероятности —
// в таблице «Шансы», открывается кнопкой с витрины, требование прозрачности).
const WHEEL_COLORS = ['#4dabf7', '#63e6be', '#ffd43b', '#ff922b', '#e599f7', '#74c0fc', '#8ce99a', '#ffa8a8', '#b197fc'];

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 80 }, (_, i) => ({
    left: Math.random() * 100,
    delay: Math.random() * 0.6,
    dur: 1.6 + Math.random() * 1.4,
    color: WHEEL_COLORS[i % WHEEL_COLORS.length],
    size: 6 + Math.random() * 6,
    rot: Math.random() * 360,
  })), []);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <style>{`@keyframes gacha-confetti-fall {
        0% { transform: translateY(-30px) rotate(0deg); opacity: 1; }
        100% { transform: translateY(420px) rotate(720deg); opacity: 0; }
      }`}</style>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0, left: `${p.left}%`,
          width: p.size, height: p.size * 0.45, backgroundColor: p.color,
          transform: `rotate(${p.rot}deg)`, borderRadius: 2,
          animation: `gacha-confetti-fall ${p.dur}s ease-in ${p.delay}s forwards`,
        }} />
      ))}
    </div>
  );
}

function Wheel({ tiers, rotation, spinning, onDone }: {
  tiers: PoolTier[]; rotation: number; spinning: boolean; onDone: () => void;
}) {
  const n = Math.max(tiers.length, 1);
  const seg = 360 / n;
  const R = 130;
  const paths = tiers.map((t, i) => {
    const a0 = (i * seg - 90) * Math.PI / 180;
    const a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    const x0 = 150 + R * Math.cos(a0), y0 = 150 + R * Math.sin(a0);
    const x1 = 150 + R * Math.cos(a1), y1 = 150 + R * Math.sin(a1);
    const mid = (i + 0.5) * seg - 90;
    const mx = 150 + R * 0.68 * Math.cos(mid * Math.PI / 180);
    const my = 150 + R * 0.68 * Math.sin(mid * Math.PI / 180);
    return { d: `M150,150 L${x0},${y0} A${R},${R} 0 0 1 ${x1},${y1} Z`, color: WHEEL_COLORS[i % WHEEL_COLORS.length], icon: t.icon, mx, my };
  });
  return (
    <div className="relative mx-auto" style={{ width: 300, height: 300 }}>
      {/* стрелка-указатель сверху */}
      <div style={{
        position: 'absolute', top: -4, left: '50%', transform: 'translateX(-50%)', zIndex: 2,
        width: 0, height: 0, borderLeft: '12px solid transparent', borderRight: '12px solid transparent',
        borderTop: '20px solid var(--color-negative, #e03131)',
      }} />
      <svg viewBox="0 0 300 300" width={300} height={300}
        onTransitionEnd={e => { if (e.propertyName === 'transform') onDone(); }}
        style={{
          transform: `rotate(${rotation}deg)`,
          transition: spinning ? 'transform 4.6s cubic-bezier(0.12, 0.75, 0.12, 1)' : 'none',
          filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.18))',
        }}>
        <circle cx={150} cy={150} r={R + 8} fill="var(--color-bg-surface)" stroke="var(--color-border)" strokeWidth={2} />
        {paths.map((p, i) => <path key={i} d={p.d} fill={p.color} stroke="#fff" strokeWidth={2} opacity={0.92} />)}
        {paths.map((p, i) => (
          <text key={`t${i}`} x={p.mx} y={p.my} fontSize={22} textAnchor="middle" dominantBaseline="central">{p.icon}</text>
        ))}
        <circle cx={150} cy={150} r={30} fill="var(--color-bg-surface)" stroke="var(--color-border)" strokeWidth={2} />
        <text x={150} y={150} fontSize={22} textAnchor="middle" dominantBaseline="central">🎰</text>
      </svg>
    </div>
  );
}

function ChancesModal({ data, onClose }: { data: GachaData; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div className="mt-16 w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h2 className="mb-1 text-base font-bold text-[var(--color-text)]">Шансы гачи</h2>
        <div className="mb-3 text-xs text-[var(--color-text-muted)]">
          Все вероятности опубликованы, сумма ровно 100%. Результат каждой крутки определяет сервер.
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {data.pool.map(t => (
              <tr key={t.tierKey} className="border-t border-[var(--color-border)]">
                <td className="py-1.5 pr-2">{t.icon}</td>
                <td className="py-1.5 pr-2 text-[var(--color-text)]">
                  {t.name}
                  {t.soldOut && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">(приз закончился)</span>}
                </td>
                <td className="py-1.5 text-right font-semibold tabular-nums" style={{ color: RARITY_COLOR[t.rarity] }}>
                  {fmtChance(t.chancePpm)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 rounded-xl border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <b className="text-[var(--color-text)]">Гарантия (pity):</b> с {data.pity.softFrom}-й крутки без редкого приза шанс
          редкого растёт на 2 п.п. за крутку, на {data.pity.hardAt}-й — редкий приз гарантирован. Джекпот в гарантию
          не входит — его шанс всегда {fmtChance(data.pool.find(t => t.rarity === 'jackpot')?.chancePpm ?? 0)}.
          Лимиты: {data.limits.daily} круток в день, {data.limits.weekly} в неделю.
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs hover:bg-[var(--color-bg-hover)]">Закрыть</button>
        </div>
      </div>
    </div>
  );
}

export function GachaBlock({ isSelf }: { isSelf: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showChances, setShowChances] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [reveal, setReveal] = useState<SpinResultView | null>(null);
  const pendingResult = useRef<SpinResultView | null>(null);

  const { data } = useQuery<GachaData>({
    queryKey: ['gacha'],
    queryFn: async () => {
      const res = await fetch('/api/shop/gacha');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const spin = useMutation({
    mutationFn: async () => {
      // Тело не отправляется: серверу нечем «подыграть», исход только его.
      const res = await fetch('/api/shop/gacha', { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return (json as { result: SpinResultView }).result;
    },
    onSuccess: (result) => {
      setError(null);
      pendingResult.current = result;
      // Крутим колесо к выпавшему сектору: 5 полных оборотов + доводка так,
      // чтобы центр сектора встал под стрелку (стрелка сверху = 0°).
      const tiers = data?.pool ?? [];
      const idx = Math.max(0, tiers.findIndex(t => t.tierKey === result.tierKey));
      const seg = 360 / Math.max(tiers.length, 1);
      const target = 360 * 5 + (360 - (idx * seg + seg / 2));
      setSpinning(true);
      setReveal(null);
      // от текущего угла — приводим к базе, затем в следующий кадр задаём цель
      setRotation(r => r % 360);
      requestAnimationFrame(() => requestAnimationFrame(() => setRotation(target)));
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const onWheelDone = () => {
    setSpinning(false);
    if (pendingResult.current) {
      setReveal(pendingResult.current);
      pendingResult.current = null;
      void qc.invalidateQueries({ queryKey: ['gacha'] });
      void qc.invalidateQueries({ queryKey: ['shop'] });
      void qc.invalidateQueries({ queryKey: ['badges-shelf'] });
      void qc.invalidateQueries({ queryKey: ['badges-profile-extra'] });
    }
  };

  if (!data || !data.enabled) return null;
  const canSpin = isSelf && !spinning && !spin.isPending && data.balance >= data.spinCost
    && data.limits.dayLeft > 0 && data.limits.weekLeft > 0;

  return (
    <section className="relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-4 sm:px-5 py-4">
      {(reveal && reveal.rarity !== 'common') && <Confetti />}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-bold text-[var(--color-text)]">🎰 Гача</h2>
        <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <MltCoin size={13} title={data.currencyName} />
          крутка {data.spinCost} {data.currencyName} · сегодня осталось {data.limits.dayLeft} из {data.limits.daily},
          на неделе {data.limits.weekLeft} из {data.limits.weekly}
        </span>
        <button type="button" onClick={() => setShowChances(true)}
          className="ml-auto rounded-lg border border-[var(--color-border)] px-3 py-1 text-xs font-semibold hover:bg-[var(--color-bg-hover)]">
          Шансы
        </button>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
        До гарантии редкого приза: <b className="text-[var(--color-text)]">{data.pity.toGuarantee}</b> круток
        {data.pity.counter >= data.pity.softFrom - 1 && <span className="ml-1" style={{ color: '#e8590c' }}>— шанс редкого уже повышен!</span>}
      </div>

      <div className="mt-4 flex flex-col items-center gap-3">
        <Wheel tiers={data.pool} rotation={rotation} spinning={spinning} onDone={onWheelDone} />
        {isSelf && (
          <button type="button" disabled={!canSpin} onClick={() => spin.mutate()}
            title={data.limits.dayLeft <= 0 ? 'Лимит на сегодня исчерпан'
              : data.balance < data.spinCost ? `Не хватает ${data.currencyName}` : undefined}
            className="rounded-xl bg-[var(--color-accent)] px-8 py-2.5 text-sm font-bold text-[var(--color-text-inverse)] disabled:opacity-40">
            {spinning || spin.isPending ? 'Крутится…' : `Крутить за ${data.spinCost} ${data.currencyName}`}
          </button>
        )}
        {reveal && !spinning && (
          <div className="rounded-xl border px-4 py-2.5 text-center"
            style={{ borderColor: RARITY_COLOR[reveal.rarity], backgroundColor: `color-mix(in srgb, ${RARITY_COLOR[reveal.rarity]} 8%, transparent)` }}>
            <div className="text-2xl">{reveal.icon}</div>
            <div className="text-sm font-bold text-[var(--color-text)]">
              {reveal.rarity === 'jackpot' ? 'ДЖЕКПОТ! ' : ''}{reveal.name}
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">
              {reveal.prizeType === 'eball'
                ? `+${reveal.eballAmount} ${data.currencyName} на баланс`
                : reveal.rarity === 'jackpot'
                  ? 'Приз в инвентаре, заявка на выдачу уже у руководителя'
                  : 'Приз упал в инвентарь (таб «Магазин»)'}
              {reveal.forcedByPity && ' · сработала гарантия'}
            </div>
          </div>
        )}
        {error && <div className="text-xs text-[var(--color-negative,#e03131)]">{error}</div>}
      </div>

      {data.history.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Мои последние крутки</div>
          <div className="flex flex-col">
            {data.history.map(h => (
              <div key={h.id} className="flex flex-wrap items-baseline gap-2 border-t border-[var(--color-border)] py-1 text-[12.5px]">
                <span className="tabular-nums text-[var(--color-text-muted)]">{h.at.slice(5, 16).replace('-', '.')}</span>
                <span className="text-[var(--color-text)]">{h.prize_name}</span>
                {h.rarity !== 'common' && (
                  <span className="text-[11px] font-semibold" style={{ color: RARITY_COLOR[h.rarity] }}>
                    {h.rarity === 'jackpot' ? 'джекпот' : 'редкий'}
                  </span>
                )}
                {h.forced_by_pity && <span className="text-[11px] text-[var(--color-text-muted)]">гарантия</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {showChances && <ChancesModal data={data} onClose={() => setShowChances(false)} />}
    </section>
  );
}
