'use client';
// «Ещё» → «Что предложить» (до 22.10 — в «Настройках»): ручные приоритеты кросс-селла
// (правка владельца 21.09). Мотив дословно: «После газобетона статистика говорит предложить сухие
// смеси потому что как правило докупают клей вместе с газобетоном после
// газобетона. Это создает информационный шум… для каждого задавать вручную до
// 3х приоритетов… и только потом "по статистике"».
//
// На каждую товарную группу — до трёх групп в порядке приоритета. Они идут
// первыми в блоке «Предложить» раздела «Мои заказчики» (плитка, карточка
// клиента) и в подсказках бота; статистический топ-3 остаётся следом.
// Сохранение — сразу по выбору (отдельной кнопки нет), действует в течение минуты.

import { useEffect, useMemo, useState } from 'react';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { QuestionnairesTab } from '@/features/questionnaires/ui/QuestionnairesTab';

interface StatItem { group: string; pct: number }
interface Row { name: string; transitions: number; stat: StatItem[]; priorities: (string | null)[] }

export default function CrossSellPrioritiesPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  // Вкладки (владелец 22.10): приоритеты кросс-селла и анкеты по товарным группам (миграция 244).
  const [tab, setTab] = useUrlState('tab', stringParam('priorities'));
  const [allGroups, setAllGroups] = useState<string[]>([]);
  const [max, setMax] = useState(3);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [savedGroup, setSavedGroup] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings/cross-sell').then(r => r.json())
      .then(d => {
        if (d.error) { setMsg(d.error); return; }
        setRows(d.rows); setAllGroups(d.allGroups); setMax(d.max ?? 3);
      })
      .catch(() => setMsg('Не удалось загрузить список товарных групп'));
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => r.name.toLowerCase().includes(needle)
      || r.priorities.some(p => p?.toLowerCase().includes(needle)));
  }, [rows, q]);

  const configured = rows?.filter(r => r.priorities.some(Boolean)).length ?? 0;

  async function save(name: string, groups: (string | null)[]) {
    setSavingGroup(name); setMsg(null);
    // Оптимистично: селект должен реагировать мгновенно, откатываем при ошибке.
    const before = rows;
    setRows(rs => rs?.map(r => (r.name === name ? { ...r, priorities: groups } : r)) ?? rs);
    try {
      const res = await fetch('/api/settings/cross-sell', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromGroup: name, groups }),
      });
      const d = await res.json();
      if (!res.ok) { setRows(before); setMsg(d.error ?? 'Ошибка сохранения'); return; }
      setSavedGroup(name);
      setTimeout(() => setSavedGroup(g => (g === name ? null : g)), 2000);
    } catch {
      setRows(before); setMsg('Сетевая ошибка');
    } finally {
      setSavingGroup(s => (s === name ? null : s));
    }
  }

  function setSlot(row: Row, slot: number, value: string) {
    // Слот — это МЕСТО В СПИСКЕ: выбранный третьим остаётся третьим, первые две
    // позиции займёт статистика (правка владельца 21.09: «выбрал ее в третьем
    // приоритете. В итоге она воткнулась в первый»). Дырки не схлопываем.
    const next: (string | null)[] = Array.from({ length: max }, (_, i) => row.priorities[i] ?? null);
    next[slot] = value || null;
    save(row.name, next);
  }

  if (!rows) return <div className="p-6 text-sm text-[var(--color-text-muted)]">{msg ?? 'Загрузка…'}</div>;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
    <div className="max-w-5xl p-4 sm:p-6 flex flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-lg font-bold text-[var(--color-text)]">Что предложить</h1>
        {/* Две вкладки — перенос строкой вместо горизонтальной ленты (CLAUDE.md, правило 12). */}
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Раздел">
          {[{ key: 'priorities', label: 'Ручные приоритеты' }, { key: 'forms', label: 'Анкеты по группам' }].map(t => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
              className={`min-h-11 rounded-lg px-3 text-sm ${tab === t.key ? 'bg-[var(--color-accent)] text-white' : 'border border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'forms' ? <QuestionnairesTab groups={allGroups} /> : (<>
      <div>
        <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
          Что предложить клиенту — <b>в первую очередь отсюда</b>: в карточке клиента (общий блок и каждый
          объект), в «Моих заказчиках» и в подсказках бота эти группы идут первыми. Свободные места
          занимают майндкарта стройки и статистика — что клиенты покупали СЛЕДУЮЩЕЙ покупкой (она шумит на
          сопутствующих: после «Газобетон» выводит «Сухие смеси», хотя клей берут той же покупкой).
          Для каждой группы — до {max} групп. <b>Приоритет — это место в списке:</b> выбранный третьим и
          останется третьим, а первые две позиции займут майндкарта и статистика. Если клиент эту группу уже
          покупал или менеджер нажал «не предлагать» — её место занимает следующая.
          Изменения применяются в течение минуты, пересчёт не нужен.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Поиск группы"
          className="min-w-[180px] flex-1 sm:max-w-xs rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[16px] sm:text-sm" />
        <span className="text-xs text-[var(--color-text-muted)]">
          задано вручную: <b className="text-[var(--color-text)]">{configured}</b> из {rows.length}
        </span>
        {msg && <span className="text-xs font-semibold text-[var(--color-negative,#e03131)]">{msg}</span>}
      </div>

      <div className="flex flex-col gap-2">
        {filtered.map(row => {
          const opts = allGroups.filter(g => g !== row.name);
          const busy = savingGroup === row.name;
          return (
            <div key={row.name}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 py-2.5 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-[13.5px] text-[var(--color-text)]">{row.name}</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {row.stat.length > 0
                      ? <>по статистике: {row.stat.map(s => `${s.group} ${s.pct}%`).join(' · ')}</>
                      : 'статистики переходов нет'}
                  </div>
                </div>
                {busy && <span className="text-[11px] text-[var(--color-text-muted)]">сохраняю…</span>}
                {!busy && savedGroup === row.name && <span className="text-[11px] font-semibold text-[var(--color-positive,#2f9e44)]">сохранено</span>}
                {row.priorities.some(Boolean) && (
                  <button onClick={() => save(row.name, [])}
                    className="min-h-11 sm:min-h-0 sm:py-1 px-2 rounded-lg border border-[var(--color-border)] text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                    сбросить
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {Array.from({ length: max }, (_, slot) => (
                  // Правило 14 CLAUDE.md: без нативных <select> — групп ~сотня, нужен поиск.
                  <SearchSelect key={slot}
                    options={opts.map(g => ({ value: g, label: g }))}
                    value={row.priorities[slot] ?? ''}
                    onChange={v => setSlot(row, slot, v)}
                    allLabel={`— приоритет ${slot + 1} —`}
                    placeholder={`— приоритет ${slot + 1} —`}
                    searchable
                    ariaLabel={`Приоритет ${slot + 1}: что предлагать после «${row.name}»`}
                    className="w-full" />
                ))}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div className="text-sm text-[var(--color-text-muted)]">Ничего не найдено.</div>}
      </div>
      </>)}
    </div>
    </div>
  );
}
