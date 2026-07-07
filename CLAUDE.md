# Аналстероид — правила для Claude Code

BI-дашборд продаж (Next.js 16 App Router, React 19, Tailwind v4, TanStack Query, Radix UI).
Документация проекта — `ai_docs/fresh_docs/` (PROJECT_OVERVIEW, WORKLOG, SECRETS_AND_STORAGE).
Каждое изменение/решение фиксировать в `ai_docs/fresh_docs/WORKLOG.md`.

## Адаптивность — ОБЯЗАТЕЛЬНО для любого UI-кода

Приложением пользуются с телефонов и планшетов. Любой новый или изменённый экран обязан
работать на ширине **375px** (телефон) и **768px** (планшет), а не только на десктопе.
План массовой адаптации существующих страниц: `ai_docs/fresh_docs/MOBILE_OPTIMIZATION_PLAN.md`.

Правила (нарушение = баг, а не «улучшим потом»):

1. **Никаких фиксированных ширин без ограничителя.** `w-[800px]`, `style={{ width: 600 }}`
   и т.п. — только вместе с `max-w-full` / `max-w-[calc(100vw-16px)]` / `max-w-[94vw]`.
2. **Каждая `<table>` — внутри `<div className="scroll-x">`** (класс в `globals.css`:
   overflow-x + инерционный скролл iOS). Широкая таблица без обёртки ломает всю страницу.
3. **Модалки — только `components/ui/Modal`** (Radix: на десктопе окно, на телефоне
   bottom-sheet). Самописные `fixed inset-0` с фиксированной шириной — запрещены.
4. **Дропдауны/поповеры — только `components/ui/Popover`** (Radix сам прижимает панель
   к краям вьюпорта). Позиционирование через `getBoundingClientRect` + `position:fixed` —
   запрещено: на узких экранах панель уезжает за край.
5. **Hover-only элементы недоступны на таче.** Вместо `opacity-0 group-hover:opacity-100`
   использовать класс `hover-reveal` (виден на тач-устройствах, прячется до hover на десктопе).
6. **Мелкие иконки-кнопки** (`<Trash2 size={12}/>` и т.п.) — добавлять класс `tap-target`
   (расширяет зону нажатия до ~40px без изменения вида).
7. **Высота экрана — `h-dvh`, не `h-screen`** (h-screen на мобильном Safari прячет контент
   под адресной строкой).
8. **Ветвление по устройству в JS** — хуки из `lib/hooks/useMediaQuery.ts`
   (`useIsMobile`, `useIsTablet`, `useIsTouch`), но сначала пробовать чистый CSS
   (`sm:` / `md:` / `lg:` префиксы Tailwind) — он не требует гидрации.
9. **Формы**: гриды `grid-cols-2/3` — с мобильным вариантом `grid-cols-1 sm:grid-cols-2`.
   Инпуты — `font-size` ≥ 16px на мобильном (иначе iOS зумит при фокусе) или `text-base sm:text-sm`.
10. **Перед завершением UI-задачи**: `npm run lint:responsive` — новых нарушений быть
    не должно (скрипт сравнивает с baseline и падает на новых). Плюс визуальная проверка
    в превью на ширине 375px.

## Команды

- `npm run dev` — dev-сервер на :3004
- `npm run typecheck` — обязательно перед завершением задачи
- `npm run lint:responsive` — проверка правил адаптивности (baseline в `scripts/responsive-baseline.json`)
