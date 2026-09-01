'use client';
// «Цена: разметка стадий» (задача владельца 01.09): три состояния стадии —
// «Нет цены» / «Есть цена» / «Спорно». На разметке стоят метрики «CR Сделка →
// Цена озвучена» и «Скорость до цены» (движок features/reports/engine/
// priceSpeed.ts). «Спорно» не участвует в расчёте: сделка, зашедшая в спорную
// стадию до первой ценовой, исключается из числителя и знаменателя.
import { useEffect, useMemo, useState } from 'react';

type State = 'no_price' | 'has_price' | 'unclear';
interface StageRow {
  id: string; name: string; funnelId: number; funnelName: string;
  isRepeat: boolean; state: State; unmarked: boolean;
}

const STATE_LABELS: { value: State; label: string; activeCls: string }[] = [
  { value: 'no_price', label: 'Нет цены', activeCls: 'bg-[var(--color-bg-hover)] text-[var(--color-text)]' },
  { value: 'has_price', label: 'Есть цена', activeCls: 'bg-[var(--color-accent)] text-[var(--color-text-inverse)]' },
  { value: 'unclear', label: 'Спорно', activeCls: 'bg-[var(--color-warning)] text-[var(--color-text-inverse)]' },
];

export default function PriceStagesPage() {
  const [stages, setStages] = useState<StageRow[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/price-stages')
      .then(r => r.json())
      .then(d => setStages(d.stages ?? []))
      .catch(() => setError('Не удалось загрузить стадии'));
  }, []);

  const funnels = useMemo(() => {
    const by = new Map<number, { name: string; isRepeat: boolean; stages: StageRow[] }>();
    for (const s of stages ?? []) {
      if (!by.has(s.funnelId)) by.set(s.funnelId, { name: s.funnelName, isRepeat: s.isRepeat, stages: [] });
      by.get(s.funnelId)!.stages.push(s);
    }
    return [...by.entries()];
  }, [stages]);

  async function setState(stage: StageRow, state: State) {
    if (stage.state === state || saving) return;
    setSaving(stage.id);
    setError(null);
    const prev = stages;
    setStages(cur => (cur ?? []).map(s => (s.id === stage.id ? { ...s, state, unmarked: false } : s)));
    try {
      const r = await fetch('/api/settings/price-stages', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stageId: stage.id, state }),
      });
      if (!r.ok) throw new Error();
    } catch {
      setStages(prev); // откат — сохранение не прошло
      setError(`Не сохранилось: ${stage.name}. Попробуйте ещё раз.`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-lg font-semibold text-[var(--color-text)] mb-1">Цена: разметка стадий</h1>
      <p className="text-sm text-[var(--color-text-muted)] mb-1 max-w-2xl">
        На разметке стоят метрики «CR Сделка → Цена озвучена» и «Скорость до цены, медиана часов»
        (отчёт «По менеджерам», категория «Конверсии стадий»). <b>Есть цена</b> — стадия невозможна
        без озвученной цены: первый вход сделки в такую стадию фиксирует момент озвучивания.
        <b> Спорно</b> — не участвует в расчёте: сделка, попавшая в спорную стадию раньше ценовой,
        исключается и из числителя, и из знаменателя.
      </p>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">
        Сохраняется сразу по клику, отчёты подхватывают правку в течение минуты. Новые стадии из
        Битрикса появляются здесь автоматически со состоянием «Нет цены» и бейджем «не размечена».
      </p>
      {error && <div className="text-sm text-[var(--color-negative)] mb-3">{error}</div>}
      {!stages && !error && <div className="text-sm text-[var(--color-text-muted)]">Загрузка…</div>}
      {funnels.map(([fid, f]) => (
        <section key={fid} className="mb-6">
          <h2 className="text-sm font-semibold text-[var(--color-text)] mb-2">
            {f.name}
            {f.isRepeat && <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">повторная воронка</span>}
          </h2>
          <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
            {f.stages.map((s, i) => (
              <div
                key={s.id}
                className={`flex items-center gap-3 flex-wrap px-3 py-2 ${i > 0 ? 'border-t border-[var(--color-border)]' : ''}`}
              >
                <span className="flex-1 min-w-[180px] text-sm text-[var(--color-text)]">
                  {s.name}
                  {s.unmarked && (
                    <span className="ml-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]">не размечена</span>
                  )}
                </span>
                <span className="inline-flex border border-[var(--color-border)] rounded-lg overflow-hidden shrink-0">
                  {STATE_LABELS.map(o => (
                    <button
                      key={o.value}
                      onClick={() => setState(s, o.value)}
                      disabled={saving === s.id}
                      aria-pressed={s.state === o.value}
                      className={`tap-target px-2.5 py-1.5 text-xs transition-colors ${
                        s.state === o.value ? o.activeCls : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
