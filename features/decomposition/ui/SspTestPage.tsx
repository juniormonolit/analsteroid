'use client';
import { useState, useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useUrlState, enumParam, stringParam } from '@/lib/hooks/useUrlState';
import type { FunnelSplit } from '../sheets';
import { ALL_SHEETS, CITY_SHEETS, TOP_TABS, TOP_TAB_LABELS, type TopTab } from './ssp/tabs';
import { C, FONT, FONT_FACES, THEME_CSS, readTheme, subscribeTheme, writeTheme } from './ssp/theme';
import { CompactSeg, Seg, Select, TabButton, type Density, type MoneyUnit, type ViewMode } from './ssp/shared';
import { OverviewView } from './ssp/OverviewView';
import { DeptSheetView } from './ssp/DeptSheetView';
import { ManagersView } from './ssp/ManagersView';

// «ССП: план и факт» (задача владельца 10.10, до переименования — «ССП тест»): весь файл «2026 Декомпозиция (Основная)» против
// факта. Верхние вкладки — «Общая», три филиала, «Менеджеры»; внутри филиала — листы
// его отделов (правка владельца 10.10: «всё скомпоновано» — 15 чипов листов в ряд
// заменены двумя уровнями). Оформление — стиль monolit.shop, общий с «Дашбордом»
// (./ssp/theme.ts), тема страницы (светлая/тёмная) тоже общая с ним.
// Состояние экрана — в адресе (DESIGN_GUIDELINES, useUrlState): вкладка и лист — push,
// настройки показа — replace.

const VIEW = ['months', 'cumulative'] as const;
const DENSITY = ['full', 'pct'] as const;
const MONEY = ['mln', 'rub'] as const;
const FUNNEL = ['all', 'primary', 'repeat'] as const;


export function SspTestPage() {
  const [tab, setTab] = useUrlState<TopTab>('tab', { ...enumParam(TOP_TABS, 'overview'), mode: 'push' });
  const [sheetRaw, setSheet] = useUrlState<string>('sheet', { ...stringParam(''), mode: 'push' });
  const [view, setView] = useUrlState<ViewMode>('view', enumParam(VIEW, 'months'));
  const [density, setDensity] = useUrlState<Density>('cols', enumParam(DENSITY, 'full'));
  const [money, setMoney] = useUrlState<MoneyUnit>('unit', enumParam(MONEY, 'mln'));
  const [split, setSplit] = useUrlState<FunnelSplit>('funnel', enumParam(FUNNEL, 'all'));
  const [blockKey, setBlockKey] = useUrlState<string>('block', stringParam('all'));
  const [blocks, setBlocks] = useState<{ key: string; label: string; factAvailable: boolean }[]>([]);

  // Тема страницы — общая с «Дашбордом» (localStorage), на сервере — светлая.
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => 'light' as const);
  const dark = theme === 'dark';

  const city = tab === 'spb' || tab === 'msk' || tab === 'krd' ? tab : null;
  const citySheets = city ? CITY_SHEETS[city] : [];
  const sheet = city ? (citySheets.some(t => t.sheet === sheetRaw) ? sheetRaw : citySheets[0].sheet) : null;

  const pickTab = (t: TopTab) => {
    setTab(t);
    if (t === 'spb' || t === 'msk' || t === 'krd') setSheet(CITY_SHEETS[t][0].sheet); else setSheet('');
    setBlockKey('all');
  };

  return (
    <div className="dt-root flex h-full flex-col overflow-y-auto overflow-x-hidden" data-dt-theme={theme} style={{ background: C.bg, color: C.text, fontFamily: FONT }}>
      {/* Ховер строки — еле заметный и ПОВЕРХ тепловой карты (правка владельца 10.10): не
          меняем background (он у красных/зелёных ячеек свой), а кладём полупрозрачный слой
          внутренней тенью — красный остаётся красным, но видно, что строка выделена. */}
      <style>{FONT_FACES + THEME_CSS + `.ssp-row:hover td{box-shadow:inset 0 0 0 100px color-mix(in srgb, ${C.primary} 7%, transparent)}`}</style>

      {/* Шапка: заголовок 28/700, подпись, тема */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-5 sm:px-6">
        <div>
          <h1 className="text-[28px] font-bold leading-tight">ССП: план и факт</h1>
          <div className="mt-1 text-[13px] font-medium" style={{ color: C.muted }}>Декомпозиция 2026 · накопительно с начала года · план из файла «2026 Декомпозиция (Основная)»</div>
        </div>
        {/* Настройки показа и тема — в шапке; смена темы крайняя справа (правка владельца 10.10). */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <CompactSeg value={view} onChange={setView} options={[{ v: 'months', label: 'По месяцам' }, { v: 'cumulative', label: 'Накопительно' }]} />
          <CompactSeg value={density} onChange={setDensity} options={[{ v: 'full', label: 'Все цифры' }, { v: 'pct', label: 'Только %' }]} />
          <CompactSeg value={money} onChange={setMoney} options={[{ v: 'mln', label: 'млн ₽' }, { v: 'rub', label: '₽' }]} />
          <button
            type="button"
            onClick={() => writeTheme(dark ? 'light' : 'dark')}
            aria-pressed={dark}
            className="inline-flex min-h-[40px] cursor-pointer items-center gap-2 rounded-[10px] px-3.5 text-[14px] font-bold leading-none"
            style={{ background: C.surface, color: C.text }}
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {dark ? 'Светлая' : 'Тёмная'}
          </button>
        </div>
      </div>

      {/* Вкладки верхнего уровня; отделы филиала — в той же строке справа от городов
          (правка владельца 10.10), на узком экране переносятся под вкладки. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-4 sm:px-6">
        <div role="tablist" aria-label="Раздел" className="inline-flex max-w-full flex-wrap gap-1 rounded-[10px] p-1" style={{ background: C.surface }}>
          {TOP_TABS.map(t => (
            <TabButton key={t} active={tab === t} onClick={() => pickTab(t)}>{TOP_TAB_LABELS[t]}</TabButton>
          ))}
        </div>
        {city && sheet && (
          <Seg label="Отдел" tone="accent" value={sheet} onChange={v => { setSheet(v); setBlockKey('all'); }} options={citySheets.map(t => ({ v: t.sheet, label: t.label }))} />
        )}
      </div>

      {/* Одна строка над содержимым (правки владельца 10.10): «Показатель» у левого края,
          «Воронка» у правого. Воронка — только там, где есть разбивка (листы отделов, менеджеры). */}
      {(city || tab === 'managers') && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 sm:px-6">
          {city && blocks.length > 0 && (
            <Select
              label="Показатель"
              value={blocks.some(b => b.key === blockKey) ? blockKey : 'all'}
              onChange={setBlockKey}
              options={[{ v: 'all', label: 'Все показатели' }, ...blocks.map(b => ({ v: b.key, label: b.factAvailable ? b.label : `${b.label} (только план)` }))]}
            />
          )}
          <div className="ml-auto">
            <CompactSeg value={split} onChange={setSplit} options={[{ v: 'all', label: 'Все воронки' }, { v: 'primary', label: 'Первичные' }, { v: 'repeat', label: 'Повторные' }]} />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 sm:py-5">
        {tab === 'overview' && <OverviewView view={view} money={money} density={density} />}
        {city && sheet && ALL_SHEETS.includes(sheet) && (
          <DeptSheetView key={sheet} sheet={sheet} split={split} blockKey={blockKey} view={view} money={money} density={density} onBlocks={setBlocks} />
        )}
        {tab === 'managers' && <ManagersView split={split} view={view} money={money} density={density} />}
      </div>
    </div>
  );
}
