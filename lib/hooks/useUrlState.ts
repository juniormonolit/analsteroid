'use client';
import { useCallback, useMemo, useRef } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';

/**
 * Единый механизм «состояние экрана ⇄ URL» (задача 2824, план из аудита
 * `owners-inbox/analsteroid-url-addressability-audit.md`, раздел 5 — контракт
 * писался ДО этого файла, здесь он реализован 1:1). Правило владельца
 * (Серёга): у любого экрана/настройки должен быть воспроизводимый URL — если
 * прислать ссылку коллеге, у него открывается ТО ЖЕ состояние (или «недостаточно
 * прав», см. `components/ui/AccessDenied.tsx`).
 *
 * До этого хука в проекте было ровно ОДНО место, читающее состояние из URL
 * (`ManagerCardPage.tsx`, `?tab=`, задача 2764) — рукописный `goToTab` с
 * комментарием «URL — источник правды». Этот хук обобщает ровно ту же идею на
 * весь проект, а не изобретается заново на каждом следующем экране (тот же
 * принцип «один хук — источник правды», что уже применяется к `useAppMode` и
 * `useUnsavedGuard`, см. `ai_docs/fresh_docs/DESIGN_GUIDELINES.md`).
 *
 * Контракт (подробности — DESIGN_GUIDELINES.md, раздел «URL-адресуемость экранов»):
 * 1. URL — источник правды, НЕ зеркало. Не заводить параллельный useState,
 *    который надо руками синхронизировать с URL — читаем `useSearchParams()`
 *    при каждом рендере, ничего не кэшируем в useEffect (SSR-ловушка,
 *    см. BitrixFrameFit.tsx — та же ошибка на другом хуке, чинить второй раз
 *    не нужно).
 * 2. Значение, равное дефолту, НЕ пишется в URL — иначе базовая ссылка на
 *    отчёт с настройками «по умолчанию» обрастает шумом `&key=default`.
 * 3. push vs replace решает ВЫЗЫВАЮЩИЙ экран (см. `mode` в опциях), не хук —
 *    у разных полей разная семантика «шага в истории»: таб/открытая сущность —
 *    push (браузерный «назад» должен на них возвращать), непрерывная донастройка
 *    (текст поиска, фильтр, драг слайдера) — replace (не засорять history
 *    каждой буквой).
 * 4. Батч. Несколько вызовов setValue() (из разных useUrlState()/useUrlStateBatch())
 *    в ОДНОМ синхронном обработчике не должны перезатирать друг друга — иначе
 *    каждый читает один и тот же снимок searchParams текущего рендера и
 *    последний вызов побеждает молча. Патчи копятся в микрозадаче и сбрасываются
 *    ОДНОЙ навигацией (см. `flushPendingNav` ниже).
 */

export type UrlStateMode = 'push' | 'replace';

export interface UrlStateOptions<T> {
  /** Строка query-параметра → типизированное значение. Вызывается, только когда параметр ЕСТЬ в URL. */
  parse: (raw: string) => T;
  /** Типизированное значение → строка параметра. null/undefined — параметр убирается из URL. */
  serialize: (value: T) => string | null | undefined;
  /** Значение, когда параметра нет в URL — оно же НЕ пишется в URL при сравнении (п.2 контракта). */
  default: T;
  /** 'replace' (дефолт) — правки на месте; 'push' — смысловой шаг истории (см. п.3 контракта). */
  mode?: UrlStateMode;
}

export type SetUrlState<T> = (next: T | ((prev: T) => T)) => void;

// ── Батч-очередь (п.4 контракта) ─────────────────────────────────────────────
// Модульный синглтон — это ОДИН браузерный router на вкладку, синхронизировать
// патчи через React-контекст ради того же эффекта было бы лишней индирекцией.
interface PendingNav {
  pathname: string;
  base: URLSearchParams; // снимок searchParams на момент ПЕРВОГО вызова в батче
  patch: Record<string, string | null>;
  mode: UrlStateMode;
  router: ReturnType<typeof useRouter>;
}
let pending: PendingNav | null = null;
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const nav = pending;
    pending = null;
    if (!nav) return;
    const params = new URLSearchParams(nav.base.toString());
    for (const [k, v] of Object.entries(nav.patch)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    const url = qs ? `${nav.pathname}?${qs}` : nav.pathname;
    // Прямой вызов метода (не через отдельную переменную-ссылку) — надёжнее
    // относительно возможного внутреннего `this`-биндинга router-объекта.
    if (nav.mode === 'push') nav.router.push(url, { scroll: false });
    else nav.router.replace(url, { scroll: false });
  });
}

/**
 * Копит патч в общей микрозадачной очереди вместо немедленной навигации —
 * если несколько setValue() вызваны синхронно (тот же обработчик клика), все
 * они попадут в ОДИН router.push/replace с ОБЪЕДИНЁННЫМИ изменениями. Если
 * ЛЮБОЙ из вызовов в батче просит 'push' — весь батч уходит через push (более
 * сильная навигация не должна молча понижаться до replace).
 */
function queuePatch(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: URLSearchParams,
  key: string,
  value: string | null,
  mode: UrlStateMode,
) {
  if (!pending || pending.pathname !== pathname) {
    pending = { pathname, base: searchParams, patch: {}, mode, router };
  }
  pending.patch[key] = value;
  if (mode === 'push') pending.mode = 'push';
  scheduleFlush();
}

/**
 * Один query-параметр ⇄ типизированное состояние. Почти 1:1 замена useState —
 * миграция существующего экрана обычно сводится к замене `useState(default)`
 * на `useUrlState('key', { parse, serialize, default })`.
 *
 * Malformed/устаревший URL (ручная правка, ссылка на удалённое значение enum)
 * не должен ронять страницу — если parse() бросает исключение, используется
 * default, как будто параметра не было.
 */
export function useUrlState<T>(key: string, options: UrlStateOptions<T>): [T, SetUrlState<T>] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = options.mode ?? 'replace';

  const raw = searchParams.get(key);
  const value = useMemo(() => {
    if (raw === null) return options.default;
    try {
      return options.parse(raw);
    } catch {
      return options.default;
    }
    // options.parse/options.default читаются по значению на каждый рендер —
    // они обычно инлайн-литералы у вызывающей стороны (см. фабрики ниже),
    // поэтому зависим только от raw, а не от идентичности функций-опций.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  // Держим последнее значение в ref для функциональной формы setValue(prev => …)
  // без добавления value в зависимости useCallback (иначе setValue менял бы
  // идентичность на каждый чужой ре-рендер страницы, дёшево, но незачем).
  const valueRef = useRef(value);
  valueRef.current = value;

  const setValue = useCallback<SetUrlState<T>>((next) => {
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(valueRef.current) : next;
    const defaultSerialized = options.serialize(options.default) ?? null;
    const nextSerialized = options.serialize(resolved) ?? null;
    const toWrite = nextSerialized === defaultSerialized ? null : nextSerialized;
    queuePatch(router, pathname, searchParams, key, toWrite, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, pathname, searchParams, key, mode]);

  return [value, setValue];
}

/**
 * Атомарная правка НЕСКОЛЬКИХ параметров одним вызовом (например «сбросить
 * все фильтры» одной кнопкой, или сменить срез И одновременно закрыть
 * дрилл-даун). Использует ту же батч-очередь, что и useUrlState — можно
 * свободно смешивать оба вызова в одном обработчике.
 */
export function useUrlStateBatch(mode: UrlStateMode = 'replace') {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return useCallback((patch: Record<string, string | null | undefined>) => {
    if (!pending || pending.pathname !== pathname) {
      pending = { pathname, base: searchParams, patch: {}, mode, router };
    }
    for (const [k, v] of Object.entries(patch)) {
      pending.patch[k] = v ?? null;
    }
    if (mode === 'push') pending.mode = 'push';
    scheduleFlush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, pathname, searchParams, mode]);
}

/**
 * Лёгкий вариант для модалок (п.6 контракта): `?modal=<key>` — один параметр
 * на страницу, не серьёзность полноценного useUrlState на каждую панель.
 * Пример: «Шансы гачи» — `useUrlModal()` → `isOpen('gacha-odds')` / `open('gacha-odds')`.
 */
export function useUrlModal(paramKey = 'modal') {
  const [openKey, setOpenKey] = useUrlState<string | null>(paramKey, {
    parse: (raw) => raw,
    serialize: (v) => v,
    default: null,
    mode: 'push', // открытие модалки — смысловой шаг, «назад» должен её закрывать
  });
  return {
    openKey,
    isOpen: (key: string) => openKey === key,
    open: (key: string) => setOpenKey(key),
    close: () => setOpenKey(null),
  };
}

// ── Готовые фабрики parse/serialize — большинство полей проекта одни из этих ──

/** Строка как есть; пустая строка трактуется как «параметра нет» (не пишется в URL). */
export function stringParam(defaultValue = ''): UrlStateOptions<string> {
  return {
    parse: (raw) => raw,
    serialize: (v) => (v === '' ? null : v),
    default: defaultValue,
  };
}

/**
 * Значение из фиксированного списка (enum наших string-union типов проекта).
 * Невалидное значение при ЧТЕНИИ (ручная правка URL, устаревшая ссылка на
 * убранный вариант) → default. Симметрично и при ЗАПИСИ: если откуда-то
 * (например legacy-значение в `saved_reports` из старой версии схемы) прилетело
 * значение вне текущего списка — не пишем его в URL как валидное, тоже default
 * (найдено живьём при проверке задачи 2824: `saved_reports.deal_scope='first'` —
 * старая запись, значения `DealScope` с тех пор сузились до `primary/repeat/all`).
 */
export function enumParam<T extends string>(values: readonly T[], defaultValue: T): UrlStateOptions<T> {
  const set = new Set<string>(values);
  return {
    parse: (raw) => (set.has(raw) ? (raw as T) : defaultValue),
    serialize: (v) => (set.has(v) ? v : null),
    default: defaultValue,
  };
}

export function boolParam(defaultValue = false): UrlStateOptions<boolean> {
  return {
    parse: (raw) => raw === '1',
    serialize: (v) => (v ? '1' : null),
    default: defaultValue,
  };
}

export function intParam(defaultValue: number): UrlStateOptions<number> {
  return {
    parse: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? n : defaultValue;
    },
    serialize: (v) => (Number.isFinite(v) ? String(v) : null),
    default: defaultValue,
  };
}

/**
 * Список строк через запятую — ПОРЯДОК СОХРАНЯЕТСЯ (только дедуп), намеренно:
 * например список выбранных метрик отчёта (`metricIds`) явно хранит порядок
 * пользователя (см. комментарии «always keep explicit order, never collapse»
 * в SalesReportPage.tsx) — сортировка на запись украла бы это на первом же
 * сохранении в URL.
 */
export function listParam(defaultValue: string[] = []): UrlStateOptions<string[]> {
  return {
    parse: (raw) => (raw === '' ? [] : raw.split(',').filter(Boolean)),
    serialize: (v) => {
      const deduped = [...new Set(v)];
      if (deduped.length === 0) return null;
      return deduped.join(',');
    },
    default: defaultValue,
  };
}

/**
 * Диапазон дат ISO-таймстампами через запятую: `2026-07-01T00:00:00.000Z,2026-07-31T20:59:59.999Z`.
 * Полный ISO (не только дата) — период в проекте хранит точные границы дня в
 * МСК (см. `lib/period/index.ts::defaultPeriod`), округление до календарной
 * даты потеряло бы точность на границе суток.
 *
 * `defaultValue` — КОНКРЕТНОЕ значение (уже посчитанное), не функция: дефолт
 * периода зависит от «сегодня» (см. `defaultPeriod()`), и вычислять его на
 * каждый рендер хука было бы рассинхроном с `useMemo(() => defaultPeriod(), [])`
 * на месте вызова (ровно одно и то же значение весь жизненный цикл компонента,
 * как раньше было у `useState(defaultPeriod)` — ленивый инициализатор один раз).
 */
export interface UrlDateRange { from: Date; to: Date; }
export function dateRangeParam(defaultValue: UrlDateRange): UrlStateOptions<UrlDateRange> {
  return {
    parse: (raw) => {
      const [f, t] = raw.split(',');
      const from = new Date(f);
      const to = new Date(t);
      if (isNaN(+from) || isNaN(+to)) throw new Error('bad date range');
      return { from, to };
    },
    serialize: (v) => `${v.from.toISOString()},${v.to.toISOString()}`,
    default: defaultValue,
  };
}
