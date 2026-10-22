'use client';
import { useEffect, useState } from 'react';
import { Monolitik, MONOLITIK_POSES, type MonolitikPose } from '@/components/mascot/Monolitik';
import { MonolitikHelper, type MonolitikHelperProps } from '@/components/mascot/MonolitikHelper';

/**
 * Витрина талисмана «Монолитик» — проверить позы, размеры и помощника-«скрепку»
 * до встраивания во вкладку «ИИ-анализ звонков» карточки клиента.
 * Меню настроек → «Справочники» → «Монолитик».
 */

type Stage = Omit<MonolitikHelperProps, 'placement'> & { key: string; label: string };

// Тексты — примерные, по этапам будущей вкладки «ИИ-анализ».
const STAGES: Stage[] = [
  { key: 'hello', label: 'Открыта', pose: 'hello', title: 'Привет! Я Монолитик', text: 'Могу прочитать все звонки с заказчиком и собрать памятку для менеджера.' },
  { key: 'think', label: 'Запуск', pose: 'think', title: 'Собираю звонки…', text: 'Ищу записи и расшифровки разговоров', progress: 'indeterminate' },
  { key: 'work', label: 'Анализ', pose: 'work', title: 'Проверяю звонки…', text: 'Прочитал 31 из 48 разговоров с Константином', progress: 65 },
  { key: 'done', label: 'Готово', pose: 'done', title: 'Отчёт готов', text: 'Нашёл 3 договорённости и 2 открытых вопроса.' },
  { key: 'wink', label: 'Подсказка', pose: 'wink', title: 'Совет', text: 'Нажмите «Вставить памятку в задачу» — менеджер увидит её в Битриксе.' },
  { key: 'warn', label: 'Риски', pose: 'warn', title: 'Есть риск', text: 'Клиенту обещали скидку 10% — в сделке её нет.' },
  { key: 'alert', label: 'Ошибка', pose: 'alert', title: 'Не получилось', text: 'Закончились деньги на API модели. Напишите администратору.' },
  { key: 'sleep', label: 'Нет звонков', pose: 'sleep', title: 'Тут тихо', text: 'С этим заказчиком ещё не было записанных звонков.' },
];

const SIZES = [32, 48, 72, 120, 160];

export default function MascotShowcasePage() {
  const [stageKey, setStageKey] = useState('work');
  const [demoPct, setDemoPct] = useState<number | null>(null);
  const [corner, setCorner] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Демо-прогон: think → work (прогресс тикает) → done.
  useEffect(() => {
    if (demoPct === null) return;
    if (demoPct >= 100) {
      const t = setTimeout(() => { setStageKey('done'); setDemoPct(null); }, 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setDemoPct((p) => (p === null ? null : p + 100 / 48)), 120);
    return () => clearTimeout(t);
  }, [demoPct]);

  const runDemo = () => {
    setHidden(false);
    setStageKey('think');
    setTimeout(() => { setStageKey('work'); setDemoPct(0); }, 1600);
  };

  const base = STAGES.find((s) => s.key === stageKey) ?? STAGES[0];
  const stage: Stage =
    demoPct !== null && stageKey === 'work'
      ? { ...base, progress: demoPct, text: `Прочитал ${Math.min(48, Math.round((demoPct / 100) * 48))} из 48 разговоров с Константином` }
      : base;
  const { key: _k, label: _l, ...helperProps } = stage;

  const btn = (active: boolean) =>
    `min-h-11 rounded-lg border px-3 text-sm transition-colors ${
      active
        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-text)]'
        : 'border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
    }`;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-5 sm:px-6">
        <header>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Монолитик</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Талисман приложения для вкладки «ИИ-анализ звонков». Компоненты{' '}
            <code className="text-xs">components/mascot/Monolitik</code> и{' '}
            <code className="text-xs">MonolitikHelper</code>.
          </p>
        </header>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Позы</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {MONOLITIK_POSES.map((p) => (
              <div key={p.pose} className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-2 pb-3 pt-4 text-center">
                <Monolitik pose={p.pose} size={110} className="mx-auto block" title={p.label} />
                <div className="mt-1 text-sm font-medium text-[var(--color-text)]">{p.label}</div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  <code>{p.pose}</code> · {p.hint}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Помощник-«скрепка»</h2>
          <div className="mb-4 flex flex-wrap gap-2">
            {STAGES.map((s) => (
              <button key={s.key} type="button" className={btn(s.key === stageKey)} onClick={() => { setDemoPct(null); setHidden(false); setStageKey(s.key); }}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="button" className={btn(false)} onClick={runDemo}>▶ Прогнать анализ</button>
            <button type="button" className={btn(corner)} onClick={() => { setCorner((c) => !c); setHidden(false); }}>
              {corner ? 'Вернуть в блок' : 'Закрепить в углу'}
            </button>
          </div>

          <div className="rounded-2xl border border-dashed border-[var(--color-border)] p-3 sm:p-5">
            {corner ? (
              <p className="text-sm text-[var(--color-text-muted)]">Помощник закреплён в правом нижнем углу экрана.</p>
            ) : (
              <MonolitikHelper {...helperProps} placement="inline" />
            )}
          </div>

          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Крестик сворачивает облачко, клик по роботу возвращает. Новая поза разворачивает облачко сама.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Размеры и тёмный фон</h2>
          <div className="flex flex-wrap items-end gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
            {SIZES.map((s) => (
              <div key={s} className="text-center">
                <Monolitik pose="hello" size={s} animated={s >= 72} />
                <div className="text-xs text-[var(--color-text-muted)]">{s}px</div>
              </div>
            ))}
          </div>
          {/* data-theme="dark" на обёртке включает тёмные токены робота (светлый контур) */}
          <div data-theme="dark" className="mt-3 flex flex-wrap items-end gap-4 rounded-2xl p-4" style={{ background: '#141416' }}>
            {(['hello', 'work', 'alert', 'sleep'] as MonolitikPose[]).map((p) => (
              <Monolitik key={p} pose={p} size={90} />
            ))}
          </div>
        </section>
      </div>

      {corner && !hidden && <MonolitikHelper {...helperProps} placement="corner" onClose={() => setHidden(true)} />}
      {corner && hidden && (
        <button type="button" className={`fixed bottom-4 right-4 z-50 ${btn(false)}`} onClick={() => setHidden(false)}>
          Вернуть Монолитика
        </button>
      )}
    </div>
  );
}
