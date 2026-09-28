'use client';
// Настройки режима «Последние N закрытых сделок» и правил «зомби» (ТЗ владельца
// 28.09). Три независимых правила с порогами: сделка становится зомби по ЛЮБОМУ
// включённому. Дата «смерти» считается от события (создание + N дней и т.п.), а не
// от «сегодня» — иначе все зомби попали бы в самую свежую пачку.
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import type { DealBatchSettings, ZombieRule } from '@/lib/reports/dealBatchSettings';

const INPUT = 'w-24 border border-[var(--color-border)] rounded-lg px-3 py-2 text-base sm:text-sm bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]';
const BTN = 'inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-3 rounded-lg bg-[var(--color-accent)] text-white text-sm font-medium hover:bg-[var(--color-accent-hover)] disabled:opacity-50';

function Rule({ title, hint, rule, onChange }: {
  title: string; hint: string; rule: ZombieRule; onChange: (r: ZombieRule) => void;
}) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3 flex flex-col gap-2">
      <label className="flex items-center gap-2 cursor-pointer min-h-9">
        <input type="checkbox" checked={rule.enabled} onChange={e => onChange({ ...rule, enabled: e.target.checked })}
          className="accent-[var(--color-accent)] w-4 h-4 shrink-0" />
        <span className="text-sm font-medium text-[var(--color-text)]">{title}</span>
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        <input type="number" min={1} max={3650} className={INPUT} value={rule.days}
          disabled={!rule.enabled}
          onChange={e => onChange({ ...rule, days: Math.min(3650, Math.max(1, Number(e.target.value) || 1)) })} />
        <span className="text-sm text-[var(--color-text-muted)]">дней</span>
      </div>
      <div className="text-xs text-[var(--color-text-muted)]">{hint}</div>
    </div>
  );
}

export function DealBatchSettingsPage() {
  const [s, setS] = useState<DealBatchSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/deal-batches').then(r => r.json()).then(setS).catch(() => {});
  }, []);

  async function save() {
    if (!s) return;
    setSaving(true); setMsg(null);
    try {
      const res = await fetch('/api/settings/deal-batches', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s),
      });
      const data = await res.json();
      if (!res.ok) setMsg(data.error ?? 'Не удалось сохранить');
      else { setS(data); setMsg('Сохранено'); }
    } catch {
      setMsg('Сетевая ошибка');
    } finally { setSaving(false); }
  }

  if (!s) return <div className="p-3 sm:p-6 text-sm text-[var(--color-text-muted)]"><Loader2 size={14} className="inline animate-spin mr-1" /> Загрузка…</div>;

  return (
    <div className="p-3 sm:p-6 max-w-2xl flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold text-[var(--color-text)]">Пачки сделок и зомби</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          В отчёте «Продажи» можно смотреть данные не за календарный период, а по последним N закрытым
          сделкам каждого менеджера. Закрытие — это продажа, отгрузка или отказ; если дат несколько,
          верным считается последний по времени статус.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Размер пачки по умолчанию</label>
        <div className="flex items-center gap-2">
          <input type="number" min={5} max={5000} className={INPUT} value={s.defaultBatchSize}
            onChange={e => setS({ ...s, defaultBatchSize: Math.min(5000, Math.max(5, Number(e.target.value) || 100)) })} />
          <span className="text-sm text-[var(--color-text-muted)]">сделок на менеджера</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Что считаем зомби</div>
        <p className="text-sm text-[var(--color-text-muted)]">
          Зомби — открытая сделка, которая де-факто проиграна. Срабатывает любое включённое правило.
          В отчёте зомби учитываются, только если включить их галочкой в шапке.
        </p>
        <Rule title="Висит с момента создания" rule={s.age} onChange={r => setS({ ...s, age: r })}
          hint="Сделка открыта дольше этого срока. Датой отказа считается день создания плюс срок." />
        <Rule title="Без движения" rule={s.idle} onChange={r => setS({ ...s, idle: r })}
          hint="Карточку не трогали дольше этого срока. Датой отказа считается последнее изменение плюс срок." />
        <Rule title="Застряла в стадии" rule={s.stage} onChange={r => setS({ ...s, stage: r })}
          hint="В текущей стадии дольше этого срока. История стадий ведётся с 3 апреля 2026, для более старых сделок правило не сработает." />
      </div>

      <div className="flex items-center gap-3">
        <button className={BTN} onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Сохранить
        </button>
        {msg && <span className="text-sm text-[var(--color-text-muted)]">{msg}</span>}
      </div>
    </div>
  );
}
