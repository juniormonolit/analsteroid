# План мобильной оптимизации

Статус на 2026-07-07. Фаза 0 и Фаза 1 — **сделаны**. Дальше — по фазам, каждая
самостоятельно ценна и не блокирует остальные. Правила для нового кода — в `CLAUDE.md`
(раздел «Адаптивность»), контроль — `npm run lint:responsive`.

## Контекст (аудит 2026-07-07)

До Фазы 0 адаптивности не было вообще: 0 responsive-префиксов Tailwind, 0 media-запросов,
0 хуков определения устройства. Сайдбар фиксированный, поповеры позиционируются пиксельными
координатами (уезжают за экран), кнопки удаления видны только по hover, 13 файлов с
фиксированными px-ширинами, из 8 таблиц только одна в overflow-обёртке.

## ✅ Фаза 0 — Инфраструктура и правила (сделано)

- `viewport` export в `app/layout.tsx` (device-width, safe-area).
- `globals.css`: классы `hover-reveal` (hover-элементы видимы на таче), `tap-target`
  (хит-зона ≥40px), `scroll-x` (инерционный гориз. скролл), отключён tap-highlight.
- `lib/hooks/useMediaQuery.ts`: `useIsMobile` / `useIsTablet` / `useIsTouch` (SSR-safe).
- `components/ui/Modal.tsx` — Radix Dialog: десктоп-окно / мобильный bottom-sheet.
- `components/ui/Popover.tsx` — Radix Popover c collision detection (не уезжает за экран).
- `CLAUDE.md` — обязательные правила адаптивности для всего нового UI-кода.
- `scripts/check-responsive.mjs` + baseline — линтер, падает на новых нарушениях.

## ✅ Фаза 1 — AppShell (сделано)

- Сайдбар скрыт на `<md`, вместо него мобильный топбар с бургером и off-canvas drawer
  (общий `SidebarBody`), закрывается по навигации/подложке.
- `h-screen` → `h-dvh` (мобильный Safari).
- Кнопки удаления отчётов: `hover-reveal tap-target` вместо hover-only.

## ✅ Фаза 2 — Отчёты (сделано 2026-07-07)

- Все поповеры отчётов на `components/ui/Popover` (Radix, collision detection):
  меню метрики в `ReportTable`, `FiltersMenu`, `ViewSettings`, три поповера `FilterBar`
  (период, сравнение, отделы). Самописный `createPortal`+`getBoundingClientRect` удалён.
- `DateRangePicker`: на `<sm` календарь и пресеты в колонку (пресеты — чипы под
  календарём), своя рамка убрана (её даёт Popover).
- `ReportTable` + `DrilldownDrawer`: ширина замороженной колонки через CSS-переменную
  `--report-dim-col` (320px десктоп / clamp(140px,46vw,200px) на `<md`), JS-измерение
  sticky-смещений подхватывает само; сортировка `tap-target`; меню метрики `hover-reveal`.
- `MetricPanel`: на `<md` — во весь экран, селектор метрик в колонку (50/50),
  табы в горизонтальном скролле, крестик вне скролла.
- `SaveReportModal` → `components/ui/Modal` (bottom-sheet на телефоне); заодно
  исправлен краш при невалидной сессии (ответ 401 не массив → падал `.find`).
- `HighlightEditor`: док-режим только на десктопе (`useIsMobile`), `max-w-[94vw]`.
- `DrilldownDrawer`: шапка переносится, боковая полоска-подложка скрыта на `<sm`.

## ✅ Фаза 3 — Планы и Декомпозиция (сделано 2026-07-07)

- **`PlansTable`**: sticky-колонка «Менеджер» через `--report-dim-col` на `<md`
  (как в отчётах); кнопки подтверждения/отмены редактирования — `tap-target`.
  Обёртка уже была `overflow-auto` — растущий `minWidth` таблицы безопасен.
- **`PlansPage`**: выбор отделов переведён на `components/ui/Popover`
  (был `absolute`-дропдаун); тулбар `px-3 sm:px-6`.
- **`ExportSlide` / `ImportSlide`**: `max-w-[94vw]` (w-96 = 384px было шире телефона).
- **`DecompositionPage`**: sticky-колонка через `--report-dim-col` на `<md`;
  строкам отделов дан явный фон (sticky-ячейка наследует, прозрачный просвечивал);
  «ИТОГО (РОССИЯ)» — `accent-soft` (опак) вместо `accent/10`; сноска вынесена
  из скролл-контейнера.

## ✅ Фаза 4 — Настройки и Метрики (сделано 2026-07-08)

- **`MetricEditor`**: `w-[800px] max-w-full` (на телефоне — во весь экран), гриды форм
  `grid-cols-1 sm:grid-cols-2/3`, инпуты `text-base sm:text-sm` (без iOS-зума).
- **`metrics/page.tsx`**: таблице задан `min-w-[720px]` (скроллится, а не сжимается),
  шапка с переносом, кнопкам действий `tap-target`.
- **`settings/users`**: таблица в `scroll-x` + `min-w-[560px]`.
  **`settings/tables`**: рейл списка таблиц на `<md` — блок сверху (max-h-44).
  `metric-colors`/`working-calendar`: мобильные отступы.
- **`InviteUserModal`** → `components/ui/Modal` (bottom-sheet на телефоне).
- **`SettingsSidebar` + `settings/layout`**: на `<md` — горизонтальные табы над контентом.
- **Линтер доработан**: не ловит `min-w-` (легальный паттерн в скролле), `w-full`
  и responsive-префиксы на той же строке, строки-комментарии.
  **Baseline добит до нуля** — теперь любое нарушение = новое = красный lint.

## ✅ Фаза 5 — Сводная + полировка (сделано 2026-07-08)

- `SummaryPage`: пара больших KPI-чисел — `text-4xl sm:text-5xl` + `flex-wrap`
  (два text-5xl не влезали в 375px).
- `tap-target` добавлен иконкам-кнопкам: FilterRow в `MetricEditor`, крестики в
  `MetricPanel` (поиск/группы/метрики/поля сделки), Trash в `metric-colors`.
- Финальный прогон в превью на 375px: Сводная, Планы, Декомпозиция — без
  горизонтального скролла страницы, широкие таблицы скроллятся в контейнерах,
  sticky-колонки сужены (~173px). Десктоп не изменился.
- `lint:responsive`: **0 нарушений, baseline пуст** — любое новое нарушение валит скрипт.

**Массовая адаптация завершена (Фазы 0–5). Далее — только соблюдение правил CLAUDE.md
для нового кода.**

## Definition of Done фазы

- Страница юзабельна на 375px: ничего не уезжает за экран без скролла-контейнера,
  все действия достижимы тачем, текст читается без зума.
- `npm run typecheck` чист, `npm run lint:responsive` — количество нарушений
  уменьшилось, baseline обновлён.
- Запись в WORKLOG.
