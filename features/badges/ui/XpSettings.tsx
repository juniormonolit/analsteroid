'use client';

// Настройки XP-системы (миграция 124): коэффициенты начисления и редактор
// маппинга «головная группа → класс». Секция страницы «Настройки → Награды»,
// только супер-админ (роут отбивает сам). Пересчёт после правок — общая кнопка
// «Пересчитать награды» в шапке (XP-леджер пересчитывается тем же тиком).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface XpSettingsPayload {
  settings: Record<string, number>;
  classMap: Record<string, string>;
  otherClass: string;
}

const FIELD_LABELS: [key: string, label: string, hint: string][] = [
  ['saleFix', 'Продажа: фикс XP', 'Фиксированная часть за каждую продажу'],
  ['salePerRub', 'Продажа: ₽ за 1 XP', '+1 XP за каждые N ₽ суммы сделки'],
  ['saleSumCap', 'Продажа: кап суммовой части', 'Максимум XP от суммы (миллионник не даёт три уровня)'],
  ['shipFix', 'Отгрузка: фикс XP', ''],
  ['shipPerRub', 'Отгрузка: ₽ за 1 XP', ''],
  ['shipSumCap', 'Отгрузка: кап суммовой части', ''],
  ['repeatMult', 'Множитель повторки', 'Повторная продажа (воронки повторных)'],
  ['crosssellMult', 'Множитель допродажи', 'Следующая сделка клиента в рекомендованной группе'],
  ['regularBonus', 'Бонус «довёл до постоянника»', 'Вторая продажа клиента, +XP без множителей'],
  ['speedBonus', 'Бонус скорости (доля)', '0.25 = +25% за закрытие быстрее медианы группы'],
  ['levelBase', 'База кривой уровней', 'XP до уровня N = база × N^степень'],
  ['levelExp', 'Степень кривой', ''],
  ['classLevelBase', 'База кривой классов', 'Та же кривая для классов, меньшая база'],
];

export function XpSettingsBlock() {
  const qc = useQueryClient();
  const { data } = useQuery<XpSettingsPayload>({
    queryKey: ['settings-xp'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/xp');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });
  const { data: groupsData } = useQuery<{ groups: string[] }>({
    queryKey: ['settings-badge-groups'],
    queryFn: async () => {
      const res = await fetch('/api/settings/badges/groups');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const patch = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/settings/badges/xp', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings-xp'] }),
  });

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mapDrafts, setMapDrafts] = useState<Record<string, string>>({});
  const [mapOpen, setMapOpen] = useState(false);
  if (!data) return null;

  const groups = groupsData?.groups ?? [];
  const knownClasses = [...new Set(Object.values(data.classMap))].sort();

  const saveField = (key: string) => {
    const raw = drafts[key];
    if (raw === undefined || raw.trim() === '') return;
    const v = Number(raw.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    patch.mutate({ [key]: v });
    setDrafts(d => { const n = { ...d }; delete n[key]; return n; });
  };
  const saveMapEntry = (group: string) => {
    const raw = mapDrafts[group];
    if (raw === undefined) return;
    patch.mutate({ classMap: { [group]: raw.trim() } });
    setMapDrafts(d => { const n = { ...d }; delete n[group]; return n; });
  };

  return (
    <section className="mt-6 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h2 className="text-base font-bold text-[var(--color-text)]">⚡ XP-система</h2>
        <span className="text-xs text-[var(--color-text-muted)]">
          опыт и уровни; после правок нажмите «Пересчитать награды» вверху
        </span>
      </div>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {FIELD_LABELS.map(([key, label, hint]) => (
          <label key={key} className="flex items-center justify-between gap-2 text-[13px]" title={hint}>
            <span className="text-[var(--color-text)]">{label}</span>
            <input
              className="w-24 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right tabular-nums"
              value={drafts[key] ?? String(data.settings[key] ?? '')}
              onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
              onBlur={() => saveField(key)}
              onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </label>
        ))}
      </div>

      <div className="mt-4">
        <button type="button" onClick={() => setMapOpen(v => !v)}
          className="text-sm font-semibold text-[var(--color-accent)] hover:underline">
          {mapOpen ? '▲ Скрыть классы (домены)' : `▼ Классы (домены): маппинг групп — ${Object.keys(data.classMap).length} назначено`}
        </button>
        {mapOpen && (
          <div className="mt-2">
            <div className="mb-2 text-xs text-[var(--color-text-muted)]">
              Впишите класс для головной группы (пусто = «{data.otherClass}»). Известные классы: {knownClasses.join(', ') || '—'}.
            </div>
            <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {groups.map(g => (
                <label key={g} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate text-[var(--color-text)]" title={g}>{g}</span>
                  <input
                    list="xp-class-names"
                    className="w-32 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1"
                    placeholder={data.otherClass}
                    value={mapDrafts[g] ?? data.classMap[g] ?? ''}
                    onChange={e => setMapDrafts(d => ({ ...d, [g]: e.target.value }))}
                    onBlur={() => saveMapEntry(g)}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </label>
              ))}
            </div>
            <datalist id="xp-class-names">
              {knownClasses.map(c => <option key={c} value={c} />)}
            </datalist>
          </div>
        )}
      </div>
      {patch.isError && (
        <div className="mt-2 text-xs text-[var(--color-negative,#e03131)]">
          {patch.error instanceof Error ? patch.error.message : 'Ошибка сохранения'}
        </div>
      )}
    </section>
  );
}
