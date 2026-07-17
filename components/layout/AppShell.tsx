'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3,
  ChevronDown, ChevronRight, ChevronLeft, LogOut, Settings,
  Bookmark, BookOpen, BarChart2, ClipboardList, Network, Gauge, Menu, X, Bell, LayoutGrid,
} from 'lucide-react';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm, isReportAdmin, type PermKey } from '@/lib/auth/perms';
import { Avatar } from '@/components/ui/Avatar';
import { Tooltip, TooltipProvider } from '@/components/ui/Tooltip';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { BrandLogo } from '@/components/ui/BrandLogo';
import type { SavedReport, TrashedReport } from '@/lib/saved-reports/types';
import { ChangelogPanel } from '@/features/changelog/ui/ChangelogPanel';
import { useChangelogQuery } from '@/features/changelog/ui/useChangelogQuery';
import { IdeasPanel } from '@/features/ideas/ui/IdeasPanel';
import { useTheme } from '@/lib/hooks/useTheme';
import { CreateReportButton } from '@/features/reports/ui/CreateReportButton';

// Ширина развёрнутого сайдбара (задача 1575, полировка шапки/меню): было 260 —
// «Менеджеры - Повторные» / «Товары - Сравнительный» и другие длинные имена
// сохранённых отчётов переносились на 2 строки, слоган под лого не помещался
// целиком. +17% (не «гигантизм», как просил владелец) убирает перенос у типичных
// имён отчётов и даёт слогану место — см. BRAND_TAGLINE_CLS ниже, там же кегль/
// трекинг слогана уменьшены как вторая линия защиты. Основная область отчётов
// пересчитывается сама (flex-1 у контейнера main, см. AppShell) — доп. правок
// раскладки контента не требуется, проверено на 1366px (WORKLOG 10.07).
const SIDEBAR_WIDTH_EXPANDED = 305;
const SIDEBAR_WIDTH_COLLAPSED = 52;

/* Общий паттерн пункта 1-го уровня — дизайн-проход 16.07 (задача Иосифа
   «пункты должны читаться»): чуть выше строка (py-2), крупнее межиконный зазор,
   font-medium у неактивных (не полужирный — контраст с активным сохраняется),
   иконка подсвечивается на hover всей строки (group). */
// В свёрнутой рельсе (52px) иконка центрируется (justify-center) — иначе она
// прижата влево паддингом и не совпадает по вертикали с центрированным лого
// (правка Иосифа 17.07). Развёрнутый вид — как был.
function navItemBase(collapsed: boolean): string {
  return `group flex items-start gap-3 px-2.5 py-2 mx-1 my-0.5 rounded-[10px] text-[13.5px] font-medium leading-[1.35] relative transition-colors${collapsed ? ' justify-center' : ''}`;
}
const NAV_ITEM_ACTIVE = 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)] font-semibold';
const NAV_ITEM_INACTIVE = 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]';
// Левая акцентная полоска активного пункта — аналог .sb-item.active::before из мока.
const NAV_ITEM_ACTIVE_BAR =
  "before:content-[''] before:absolute before:left-[-10px] before:top-[6px] before:bottom-[6px] before:w-[3px] before:rounded-r before:bg-[var(--color-sidebar-active)]";

function navIconCls(active: boolean) {
  return active
    ? 'text-[var(--color-sidebar-active)] mt-px'
    : 'text-[var(--color-sidebar-text-muted)] mt-px transition-colors group-hover:text-[var(--color-sidebar-active)]';
}

// Тултип пункта навигации на свёрнутой рельсе (задача 1688, кейс 6 UI/UX-
// аудита, макет case6-sidebar-variant-b-rail-tooltip.png) — обёртка
// components/ui/Tooltip.tsx (Radix, портал в body + collision detection), а
// НЕ самописный getBoundingClientRect/CSS group-hover: пункты «Продажи/
// Реализация/Маркетинг/Найм» лежат внутри скроллируемого <nav
// overflow-y-auto> (автоскролл при DnD, см. выше в файле) — по спецификации
// CSS overflow-y отличный от visible вынуждает браузер вычислить overflow-x
// как auto, то есть <nav> обрезал бы любой absolute-тултип, торчащий за
// пределы 52px рельсы. Radix Tooltip рендерит контент через портал с
// position:fixed, что не подчиняется этому клиппингу.
function RailTooltip({ collapsed, label, children }: { collapsed: boolean; label: string; children: React.ReactNode }) {
  return (
    <Tooltip content={label} side="right" disabled={!collapsed}>
      {children}
    </Tooltip>
  );
}

// Подпись под лочапом «знак + Монолитика» (бриф ребрендинга): та же ширина
// лочапа, что у строки с названием — маленький приглушённый кегль, разрядка.
// Только в развёрнутых состояниях (сайдбар/мобильный drawer) — в свёрнутой
// рельсе показывается только знак, без текста.
//
// Правка задачи 1575: раньше `truncate` резал слоган («...ДЛЯ МОНОЛИТИ…») —
// владелец попросил помещать целиком, не резать. С уширением сайдбара до
// SIDEBAR_WIDTH_EXPANDED слоган уже влезает при исходном кегле/трекинге, но
// кегль (10px→9.5px) и трекинг (0.1em→0.04em) всё равно чуть уменьшены —
// вторая линия защиты на случай узких десктопных вьюпортов (owner: «если
// всё равно тесно — уменьшить кегль/трекинг, не резать»). `whitespace-nowrap`
// вместо `truncate` — при нехватке места слоган должен остаться читаемым
// целиком, а не обрезаться многоточием.
//
// Правка Иосифа 16.07: слоган по ЛЕВОМУ краю (отменяет правое выравнивание 1599) —
// раньше был прижат к левому краю/растянут на всю ширину (`block` без
// text-align). Текст «...для монолитика» исправлен на «...для монолита»
// (опечатка в брифе ребрендинга).
const BRAND_TAGLINE_CLS =
  'block whitespace-nowrap text-left text-[9.5px] font-medium uppercase tracking-[0.04em] text-[var(--color-sidebar-text-muted)]';
const BRAND_TAGLINE_TEXT = '— аналитика для монолита'.toUpperCase();

// Тумблер «Про/Лайт» из сайдбара убран целиком (правка Иосифа 16.07) — остался
// только в ЛК (ProfilePage). Ниже ThemeSync: досинхронизация зеркала
// localStorage.theme с серверным users.theme (переключатель — в ЛК) — компонент
// ничего не рендерит, только держит хук живым в дереве всех авторизованных
// страниц (хук на react-query обязан жить ПОД QueryProvider, который монтирует
// сам AppShell).
function ThemeSync() {
  useTheme();
  return null;
}

function SalesSidebarSection({ collapsed, pathname, user }: { collapsed: boolean; pathname: string; user: SessionUser }) {
  const [openStd, setOpenStd] = useState(true);
  const [openFav, setOpenFav] = useState(true);
  const [openShared, setOpenShared] = useState(true);
  const qc = useQueryClient();

  const { data: savedReports = [] } = useQuery<SavedReport[]>({
    queryKey: ['saved-reports'],
    queryFn: async () => {
      const res = await fetch('/api/saved-reports');
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
  });

  // Корзина отчётов переехала в ЛК (ReportsTrashCard, задача Иосифа 16.07 —
  // оптимизация меню): здесь остался только список живых отчётов.

  // Переименование/удаление отчёта (задача 1605, финальное решение владельца
  // 10.07/3): раньше карандаш+корзинка жили тут, в строке сайдбара — владелец
  // забраковал ПОСЛЕ трёх раундов вёрстки («туда просто так мышкой никто не
  // лазит») и перенёс их в заголовок ОТКРЫТОГО отчёта (см. h1 в
  // SalesReportPage.tsx) — там же теперь inline-переименование и confirm()
  // перед удалением. Сайдбар — только ссылка на отчёт + drag-and-drop порядка,
  // без управляющих кнопок в принципе.

  // ── Drag-and-drop порядка (правка владельца 10.07/2, стрелки убраны 10.07/3 —
  // просьба Серёги «насрать на функционал на планшете, он не нужен там такой») ──
  // Строку можно перетащить мышью в любую позицию СВОЕГО раздела — один POST
  // {beforeId} на дроп, сервер перенумеровывает весь скоуп одним UPDATE (см.
  // .../[id]/move/route.ts, режим 2). Кнопки «вверх»/«вниз» (client-side
  // moveReport + режим direction на том же эндпоинте) полностью убраны из UI на
  // всех платформах — остаётся только DnD (сознательно НЕ работает тачем/
  // клавиатурой, решение владельца). Сам режим direction на сервере оставлен —
  // не мешает, вдруг ещё понадобится.
  // dragId — что тащим; dragOverId — строка, над которой курсор (подсветка вставки).
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  async function dropReport(draggedId: string, target: SavedReport, list: SavedReport[]) {
    const ids = list.map(x => x.id);
    const from = ids.indexOf(draggedId);
    const to = ids.indexOf(target.id);
    if (from === -1 || to === -1 || from === to) return; // кросс-раздел/дроп на себя — игнор
    // Тащим ВНИЗ — встаём ПОСЛЕ цели (beforeId = следующий за целью, null = в конец);
    // тащим ВВЕРХ — ПЕРЕД целью. Ровно так же рисуется линия-индикатор в renderReportRow.
    const beforeId = from < to ? (ids[to + 1] ?? null) : target.id;

    // Оптимистичная перестановка в кэше (кэш — общий список всех разделов; рендер
    // читает только относительный порядок внутри раздела) — сайдбар не мигает;
    // invalidate после ответа сверяет с сервером (источник правды).
    qc.setQueryData<SavedReport[]>(['saved-reports'], old => {
      if (!old) return old;
      const dragged = old.find(x => x.id === draggedId);
      if (!dragged) return old;
      const without = old.filter(x => x.id !== draggedId);
      const targetIdx = without.findIndex(x => x.id === target.id);
      if (targetIdx === -1) return old;
      without.splice(from < to ? targetIdx + 1 : targetIdx, 0, dragged);
      return without;
    });

    await fetch(`/api/saved-reports/${draggedId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beforeId }),
    });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
  }

  // Задача 1572 (Серёга): «По менеджерам»/«По товарным группам» убраны из
  // сайдбара как отдельные пункты меню — фокус на «Роп монитор»/«Отчёты
  // Стаса» (общие витрины). Сами роуты/страницы/движок НЕ трогаем — прямые
  // URL (/sales/by-managers, /sales/by-product-groups) и уже сохранённые
  // отчёты (saved/[id], которые их используют как reportSlug) продолжают
  // работать как раньше, см. app/(app)/sales/*. Старт нового отчёта этих же
  // сущностей — через кнопку «Создать отчёт» ниже (CreateReportButton).

  // Пункт 3б спеки: две управляемые общие витрины, одна механика (is_shared),
  // разные разделы (shared_section). Перемещение в корзину — admin
  // (action.shared_reports.manage); раньше требовался супер-админ — операция стала
  // обратимой (корзина), планку снизили (см. app/api/saved-reports/[id]/route.ts).
  const ropMonitorShared = savedReports.filter(r => r.isShared && r.sharedSection === 'rop_monitor');
  const smekalochnayaShared = savedReports.filter(r => r.isShared && r.sharedSection === 'smekalochnaya');
  const ownReports = savedReports.filter(r => !r.isShared && r.userLogin === user.login);
  const canDeleteShared = isReportAdmin(user);

  // Направляющая линия вложенности вокруг под-группы (Роп монитор / Смекалочная / Избранное).
  const subgroupCls = 'ml-5 pl-2.5 mb-2.5 border-l border-[var(--color-sidebar-guide)]';
  const subgroupLabelCls =
    'w-full flex items-center gap-1.5 px-1 py-1 text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] transition-colors';

  const linkCls = (href: string) =>
    `flex items-start gap-1.5 py-1 px-2 my-0.5 text-[13px] leading-[1.35] rounded-[7px] relative transition-colors group ${
      pathname === href
        ? "text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-semibold before:content-[''] before:absolute before:left-[-11px] before:top-[5px] before:bottom-[5px] before:w-[2px] before:rounded-[2px] before:bg-[var(--color-sidebar-active)]"
        : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
    }`;

  // Одна строка отчёта в сайдбаре (ссылка + порядок drag-and-drop) — переиспользуется
  // для всех трёх списков (Роп монитор / Смекалочная / Избранное), различается только
  // правом на управление (canManage — свой отчёт или витрина, где я админ, нужно
  // только для DnD теперь) и списком своего раздела (list — позиция индикатора
  // вставки). Переименование/удаление — задача 1605, финальное решение владельца:
  // никаких кнопок в строке сайдбара, см. заголовок открытого отчёта (SalesReportPage.tsx).
  function renderReportRow(r: SavedReport, canManage: boolean, list: SavedReport[]) {
    const href = `/sales/saved/${r.id}`;
    const idx = list.findIndex(x => x.id === r.id);
    // DnD-индикатор места вставки: тащим вниз → строка встанет ПОСЛЕ подсвеченной
    // (линия снизу), вверх → ПЕРЕД (линия сверху) — та же логика beforeId в dropReport.
    const dragFromIdx = dragId ? list.findIndex(x => x.id === dragId) : -1;
    const isDropTarget = dragOverId === r.id && dragId !== null && dragId !== r.id && dragFromIdx !== -1;
    const dropIndicatorCls = isDropTarget
      ? (dragFromIdx < idx
          ? ' shadow-[inset_0_-2px_0_0_var(--color-accent)]'
          : ' shadow-[inset_0_2px_0_0_var(--color-accent)]')
      : '';
    return (
      <div
        key={r.id}
        className={`relative flex items-center gap-0.5${dropIndicatorCls}${dragId === r.id ? ' opacity-40' : ''}`}
        draggable={canManage}
        onDragStart={canManage ? e => {
          setDragId(r.id);
          e.dataTransfer.effectAllowed = 'move';
        } : undefined}
        onDragEnd={canManage ? () => { setDragId(null); setDragOverId(null); } : undefined}
        onDragOver={canManage ? e => {
          // Принимаем дроп только внутри СВОЕГО раздела (dragId есть в list)
          if (dragId && dragId !== r.id && dragFromIdx !== -1) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragOverId !== r.id) setDragOverId(r.id);
          }
        } : undefined}
        onDragLeave={canManage ? () => setDragOverId(prev => (prev === r.id ? null : prev)) : undefined}
        onDrop={canManage ? e => {
          e.preventDefault();
          if (dragId) dropReport(dragId, r, list);
          setDragId(null);
          setDragOverId(null);
        } : undefined}
      >
        {/* draggable={false} — иначе браузер тащит САМУ ссылку (нативный drag <a>),
            перебивая наш DnD строки (drag начинался бы с "призраком" URL). */}
        <Link href={href} className={`flex-1 ${linkCls(href)}`} title={r.name} draggable={false}>
          <span className="flex-1 min-w-0 break-words line-clamp-2">
            {r.name}
          </span>
        </Link>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="flex justify-center py-1">
        <BarChart3 size={18} className="text-[var(--color-sidebar-text-muted)]" />
      </div>
    );
  }

  return (
    <div>
      {/* «Создать отчёт» переехала иконкой «+» в строку заголовка «Продажи»
          (правка Иосифа 16.07 — жирная dashed-кнопка рвала связь заголовка с
          группами отчётов). См. isSales-ветку в SidebarBody. */}

      {/* Роп монитор — стандартные + общие отчёты витрины rop_monitor */}
      <div className={subgroupCls}>
        <button onClick={() => setOpenStd(v => !v)} className={subgroupLabelCls}>
          <BookOpen size={11} />
          <span className="flex-1 text-left">Роп монитор</span>
          {openStd ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {openStd && (
          <>
            {ropMonitorShared.length === 0 && (
              <div className="text-xs text-[var(--color-sidebar-text-muted)] py-1 px-1">
                Нет общих отчётов
              </div>
            )}
            {ropMonitorShared.map(r => renderReportRow(r, canDeleteShared, ropMonitorShared))}
          </>
        )}
      </div>

      {/* Смекалочная — общие отчёты (видны всем, сохраняет/перезаписывает админ,
          удаляет только супер-админ) */}
      {smekalochnayaShared.length > 0 && (
        <div className={subgroupCls}>
          <button onClick={() => setOpenShared(v => !v)} className={subgroupLabelCls}>
            <BarChart2 size={11} />
            <span className="flex-1 text-left">Отчёты Стаса</span>
            {openShared ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
          {openShared && smekalochnayaShared.map(r => renderReportRow(r, canDeleteShared, smekalochnayaShared))}
        </div>
      )}

      {/* Избранное — личные отчёты */}
      <div className={subgroupCls}>
        <button onClick={() => setOpenFav(v => !v)} className={subgroupLabelCls}>
          <Bookmark size={11} />
          <span className="flex-1 text-left">Избранное</span>
          {openFav ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {openFav && (
          ownReports.length === 0 ? (
            <div className="text-xs text-[var(--color-sidebar-text-muted)] py-1 px-1">
              Нет сохранённых
            </div>
          ) : (
            ownReports.map(r => renderReportRow(r, true, ownReports))
          )
        )}
      </div>

    </div>
  );
}

interface NavItem {
  label: string;
  href?: string;
  icon: React.ReactNode;
  disabled?: boolean;
  isSales?: boolean;
  children?: { label: string; href: string }[];
  perm?: PermKey; // без права — пункт не показывается
}

// «Реализация»/«Маркетинг»/«Найм» спрятаны «до востребования» (правка Иосифа
// 16.07, оптимизация меню): Реализация и Найм были заглушками «Скоро», маркетинг-
// пресеты живут по прямым URL (/marketing/*) и вернутся в меню, когда попросят.
const NAV: NavItem[] = [
  { label: 'Продажи', icon: <BarChart3 size={18} />, isSales: true, perm: 'section.sales' },
];

/* Содержимое сайдбара (nav + нижние секции + footer) — общее для десктопного
   <aside> и мобильного off-canvas drawer, поэтому вынесено из AppShell. */
function SidebarBody({
  collapsed, pathname, user, expanded, setExpanded, logout,
  changelogOpen, onOpenChangelog,
}: {
  collapsed: boolean;
  pathname: string;
  user: SessionUser;
  expanded: string;
  setExpanded: React.Dispatch<React.SetStateAction<string>>;
  logout: () => void;
  changelogOpen: boolean;
  onOpenChangelog: () => void;
}) {
  const salesActive = pathname.startsWith('/sales');
  const showSummaryBlock = hasPerm(user, 'section.summary') || hasPerm(user, 'section.plans') || hasPerm(user, 'section.decomposition');
  const showMetricsBlock = hasPerm(user, 'section.metrics') || hasPerm(user, 'section.settings');

  // «Ещё ▸» (оптимизация 16.07): второстепенные разделы одним свёрнутым пунктом.
  const moreItems = [
    { href: '/summary', label: 'Сводная', icon: <Gauge size={18} />, ok: hasPerm(user, 'section.summary') },
    { href: '/plans', label: 'Планы', icon: <ClipboardList size={18} />, ok: hasPerm(user, 'section.plans') },
    { href: '/decomposition', label: 'Декомпозиция', icon: <Network size={18} />, ok: hasPerm(user, 'section.decomposition') },
    { href: '/metrics', label: 'Метрики', icon: <BarChart2 size={18} />, ok: hasPerm(user, 'section.metrics') },
  ].filter(i => i.ok);
  const moreActive = moreItems.some(i => pathname.startsWith(i.href));
  // Авто-раскрытие, когда пользователь В одном из спрятанных разделов — активный
  // пункт не должен быть невидимым (и при навигации туда извне, поэтому effect,
  // а не только начальное значение). Закрыть руками можно в любой момент.
  const [moreOpen, setMoreOpen] = useState(moreActive);
  useEffect(() => {
    if (moreActive) setMoreOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  // «Что изменилось?» — пункт внизу сайдбара (задача владельца, макет
  // changelog-notifications-mock.html): доступен всем, независимо от ролей/прав.
  const { data: changelogData } = useChangelogQuery();
  const unreadCount = changelogData?.unreadCount ?? 0;

  // Хотфикс 10.07/3 (баг-репорт владельца «точно не работает драг энд дроп
  // порядка отчётов»): причина — этот <nav> скроллируемый (overflow-y-auto), а
  // при заметном количестве строк (витрины Роп монитор/Отчёты Стаса + личное
  // Избранное) нижние строки списка частично/полностью ОБРЕЗАНЫ границей
  // скролла. Курсор при drop визуально ещё «над» строкой, но фактическая точка
  // за пределами видимой/hit-testable области nav — там браузер видит уже
  // СЛЕДУЮЩИЙ блок сайдбара (Сводная/Метрики и т.п.), preventDefault для
  // валидной цели не вызывается, drop молча не срабатывает (подтверждено
  // репродукцией в браузере — воспроизвести/починить, WORKLOG 10.07). Фикс —
  // автоскролл nav у верхнего/нижнего края во время drag (та же логика, что у
  // любого DnD-списка длиннее вьюпорта): dragover бывает только во время
  // активного HTML5-драга, поэтому условие на dragId не нужно — событие само по
  // себе означает «идёт перетаскивание».
  const navRef = useRef<HTMLElement | null>(null);
  const navAutoScrollEdge = 48; // px от края nav, где начинается автоскролл
  const navAutoScrollStep = 16; // px за один dragover (событие бьётся часто — плавно)
  function handleNavDragOverAutoScroll(e: React.DragEvent<HTMLElement>) {
    const el = navRef.current;
    if (!el) return;
    // getBoundingClientRect ЗДЕСЬ — не позиционирование поповера (правило 4/
    // scripts/check-responsive.mjs его не различает, ловит по имени метода): это
    // граница viewport'а самого скроллируемого nav для авто-скролла во время
    // drag. Осознанно добавлено в baseline (--update-baseline), см. WORKLOG
    // 10.07 и коммит фикса DnD.
    const rect = el.getBoundingClientRect();
    if (e.clientY < rect.top + navAutoScrollEdge) {
      el.scrollTop = Math.max(0, el.scrollTop - navAutoScrollStep);
    } else if (e.clientY > rect.bottom - navAutoScrollEdge) {
      el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, el.scrollTop + navAutoScrollStep);
    }
  }

  return (
    <>
          {/* Nav */}
          <nav ref={navRef} onDragOver={handleNavDragOverAutoScroll} className="flex-1 overflow-y-auto py-2 px-2">
            {NAV.filter(item => !item.perm || hasPerm(user, item.perm)).map(item => (
              <div key={item.label}>
                {item.disabled ? (
                  <RailTooltip collapsed={collapsed} label={`${item.label} · скоро`}>
                    <div className={`${navItemBase(collapsed)} cursor-not-allowed`}>
                      <span className="mt-px text-[var(--color-sidebar-guide)]">{item.icon}</span>
                      {!collapsed && (
                        <span className="flex-1 min-w-0 break-words line-clamp-2 text-[var(--color-sidebar-text-muted)]">
                          {item.label}
                        </span>
                      )}
                      {!collapsed && (
                        <span className="ml-auto mt-px shrink-0 text-[10px] font-semibold text-[var(--color-sidebar-text-muted)] bg-[var(--color-bg)] border border-[var(--color-sidebar-border)] rounded-full px-2 py-0.5">
                          Скоро
                        </span>
                      )}
                    </div>
                  </RailTooltip>
                ) : item.isSales ? (
                  <>
                    {/* relative-обёртка: «+ Создать отчёт» — компактная иконка в
                        строке заголовка (правка Иосифа 16.07), абсолютом левее
                        шеврона; кнопка-в-кнопке невалидна, поэтому сосед. */}
                    <div className="relative">
                      <RailTooltip collapsed={collapsed} label={item.label}>
                        <button
                          onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                          className={`w-full ${navItemBase(collapsed)} ${collapsed ? '' : 'pr-9'} ${salesActive ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                        >
                          <span className={navIconCls(salesActive)}>{item.icon}</span>
                          {!collapsed && <>
                            <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                            {expanded === item.label
                              ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                              : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                          </>}
                        </button>
                      </RailTooltip>
                      {!collapsed && (
                        /* Позиционирует обёртка: .tap-target сам ставит position:relative
                           и ломает absolute, если вешать всё на кнопку (найдено глазами
                           на стенде — «+» улетал за левый край). */
                        <div className="absolute right-8 top-1/2 -translate-y-1/2">
                          <CreateReportButton
                            label=""
                            iconSize={15}
                            title="Создать отчёт"
                            className="tap-target flex p-1 rounded-md text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-active)] hover:bg-[var(--color-sidebar-active-bg)] transition-colors"
                          />
                        </div>
                      )}
                    </div>
                    {!collapsed && expanded === item.label && (
                      <div className="py-1">
                        <SalesSidebarSection collapsed={collapsed} pathname={pathname} user={user} />
                      </div>
                    )}
                  </>
                ) : item.children ? (
                  <>
                    <RailTooltip collapsed={collapsed} label={item.label}>
                      <button
                        onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                        className={`w-full ${navItemBase(collapsed)} ${NAV_ITEM_INACTIVE}`}
                      >
                        <span className={navIconCls(false)}>{item.icon}</span>
                        {!collapsed && <>
                          <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                          {expanded === item.label
                            ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                            : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                        </>}
                      </button>
                    </RailTooltip>
                    {!collapsed && expanded === item.label && (
                      <div className="ml-5 pl-2.5 mb-2.5 border-l border-[var(--color-sidebar-guide)]">
                        {item.children.map(child => {
                          const active = pathname === child.href;
                          return (
                            <Link
                              key={child.href}
                              href={child.href}
                              className={`flex items-start gap-1.5 py-1 px-2 my-0.5 text-[13px] leading-[1.35] rounded-[7px] relative transition-colors ${
                                active
                                  ? "text-[var(--color-sidebar-active)] bg-[var(--color-sidebar-active-bg)] font-semibold before:content-[''] before:absolute before:left-[-11px] before:top-[5px] before:bottom-[5px] before:w-[2px] before:rounded-[2px] before:bg-[var(--color-sidebar-active)]"
                                  : 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]'
                              }`}
                            >
                              <span className="flex-1 min-w-0 break-words line-clamp-2">{child.label}</span>
                            </Link>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <RailTooltip collapsed={collapsed} label={item.label}>
                    <Link
                      href={item.href!}
                      className={`${navItemBase(collapsed)} ${pathname === item.href ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(pathname === item.href)}>{item.icon}</span>
                      {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">{item.label}</span>}
                    </Link>
                  </RailTooltip>
                )}
              </div>
            ))}
          </nav>

          {/* ── Нижняя зона (оптимизация 16.07, задача Иосифа «без вертикального
              скролла»): Сводная/Планы/Декомпозиция/Метрики свёрнуты в «Ещё ▸»
              (авто-раскрыт, когда открыт один из его разделов), видимыми остались
              только «Настройки» и «Что изменилось?». «Идеи и планы» переехали
              кнопкой в шапку панели ченджлога, «Корзина» — в ЛК. */}
          {(showSummaryBlock || showMetricsBlock) && (
            <div className="border-t border-[var(--color-sidebar-border)] pt-1 px-2">
              {moreItems.length > 0 && (
                <>
                  <RailTooltip collapsed={collapsed} label="Ещё">
                    <button
                      type="button"
                      onClick={() => setMoreOpen(v => !v)}
                      className={`w-full ${navItemBase(collapsed)} ${moreActive && !moreOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(moreActive && !moreOpen)}><LayoutGrid size={18} /></span>
                      {!collapsed && <>
                        <span className="flex-1 min-w-0 text-left">Ещё</span>
                        <ChevronRight
                          size={14}
                          className={`text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0 transition-transform duration-200 ${moreOpen ? 'rotate-90' : ''}`}
                        />
                      </>}
                    </button>
                  </RailTooltip>
                  {moreOpen && moreItems.map(mi => {
                    const active = pathname.startsWith(mi.href);
                    return (
                      <RailTooltip key={mi.href} collapsed={collapsed} label={mi.label}>
                        <Link
                          href={mi.href}
                          className={`${navItemBase(collapsed)} ${collapsed ? '' : 'ml-4'} ${active ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                        >
                          <span className={navIconCls(active)}>{mi.icon}</span>
                          {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">{mi.label}</span>}
                        </Link>
                      </RailTooltip>
                    );
                  })}
                </>
              )}
              {hasPerm(user, 'section.settings') && (
                <RailTooltip collapsed={collapsed} label="Настройки">
                  <Link
                    href="/settings"
                    className={`${navItemBase(collapsed)} ${pathname.startsWith('/settings') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                  >
                    <span className={navIconCls(pathname.startsWith('/settings'))}><Settings size={18} /></span>
                    {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Настройки</span>}
                  </Link>
                </RailTooltip>
              )}
            </div>
          )}

          {/* «Что изменилось?» — ченджлог, виден всем независимо от прав (п.4 задачи);
              «Есть идея?» живёт в шапке его панели (оптимизация 16.07). */}
          <div className="pb-1 px-2">
            <RailTooltip
              collapsed={collapsed}
              label={unreadCount > 0 ? `Что изменилось? · ${unreadCount > 99 ? '99+' : unreadCount}` : 'Что изменилось?'}
            >
              <button
                type="button"
                onClick={onOpenChangelog}
                className={`w-full ${navItemBase(collapsed)} ${changelogOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
              >
                <span className={navIconCls(changelogOpen)}><Bell size={18} /></span>
                {!collapsed && (
                  <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">Что изменилось?</span>
                )}
                {!collapsed && unreadCount > 0 && (
                  <span className="ml-auto mt-px shrink-0 min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-negative)] text-[var(--color-text-inverse)] text-[10.5px] font-bold flex items-center justify-center shadow-[0_0_0_2px_var(--color-sidebar-bg)] leading-none">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
            </RailTooltip>
          </div>

          {/* Footer: карточка юзера (аватар + имя/роль) → ЛК, рядом «Выйти» */}
          <div className="border-t border-[var(--color-sidebar-border)] p-2">
            <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
              <Link
                href="/profile"
                className={`flex items-center gap-2 min-w-0 flex-1 rounded-[9px] px-1.5 py-1.5 transition-colors hover:bg-[var(--color-sidebar-hover-bg)] ${collapsed ? 'justify-center flex-none' : ''}`}
                title="Личный кабинет"
              >
                <span className="rounded-full shrink-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]">
                  <Avatar name={user.displayName} url={user.avatarUrl} size={30} />
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex flex-col gap-px">
                    <span className="text-[12.5px] font-semibold text-[var(--color-sidebar-text)] truncate">{user.displayName}</span>
                    {user.roleName && (
                      <span className="text-[11px] text-[var(--color-sidebar-text-muted)] truncate">{user.roleName}</span>
                    )}
                  </span>
                )}
              </Link>
              <button
                onClick={logout}
                className="tap-target flex items-center justify-center text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-negative)] hover:bg-[var(--color-negative-soft)] rounded-md p-1.5 shrink-0 transition-colors"
                title="Выйти"
              >
                <LogOut size={16} />
              </button>
            </div>
          </div>
    </>
  );
}

export function AppShell({ children, user }: { children: React.ReactNode; user: SessionUser }) {
  const pathname = usePathname();
  // Дефолт — сайдбар всегда развёрнут, включая Главную (задача 1688, кейс 6
  // UI/UX-аудита: владелец отменил спецкейс «Главная — свёрнутая рельса» из
  // брифа Главной, чтобы поведение было одинаковым на всех страницах). Ручной
  // тоггл сворачивания (кнопка PanelLeft/PanelLeftClose) не трогаем.
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expanded, setExpanded] = useState<string>('Продажи');
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const router = useRouter();

  // Переход по ссылке из мобильного меню должен закрывать drawer
  useEffect(() => { setMobileOpen(false); }, [pathname]);

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  return (
    <QueryProvider>
      <TooltipProvider>
      <ThemeSync />
      <div className="flex h-dvh overflow-hidden">
        {/* Desktop sidebar (на <md скрыт — вместо него drawer) */}
        {/* group + relative — для ручки сворачивания на правой кромке (правка
            Иосифа 16.07: кнопка в шапке «бесила»; паттерн Notion/Linear — круглая
            ручка по центру кромки, hover-reveal: на десктопе появляется при
            наведении на сайдбар, на таче видна всегда — правило CLAUDE.md №5). */}
        <aside
          className="group relative hidden md:flex flex-col shrink-0 bg-[var(--color-sidebar-bg)] border-r border-[var(--color-sidebar-border)] transition-all duration-200"
          style={{ width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED }}
        >
          <button
            onClick={() => setCollapsed(v => !v)}
            title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
            className="hover-reveal absolute -right-3 top-1/2 -translate-y-1/2 z-30 w-6 h-6 rounded-full border border-[var(--color-sidebar-border)] bg-[var(--color-bg-surface)] shadow-md flex items-center justify-center text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-active)] hover:border-[var(--color-sidebar-active)] transition-colors"
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>
          {/* Header — клик по лого/названию ведёт на Главную (бриф Главной).
              Свёрнутая рельса (52px) слишком узкая для лого+кнопки в один ряд —
              складываем в две строки, как rail-logo/rail-expand в утверждённом
              макете (analsteroid-home-mock.html), но toggle оставлен наверху,
              а не внизу у аватара — не переносим существующий механизм.
              Развёрнутое состояние (задача 1575, полировка): раньше был один
              общий flex-row (лого+название | тумблер Лайт/Про) versus крестик
              справа — тумблер жался к левому краю под лого, слоган резался
              truncate. Теперь три отдельных ряда: 1) лого+название+кнопка
              сворачивания в одну строку, 2) слоган на всю ширину строки, текст
              прижат к правому краю (не режется, задача 1599 — см.
              BRAND_TAGLINE_CLS), 3) тумблер Лайт/Про центрирован по ширине
              ВСЕЙ шапки (`flex justify-center`), а не только колонки лого. */}
          <div
            className={
              collapsed
                ? 'flex flex-col items-center justify-center gap-1.5 py-2.5 min-h-14 border-b border-[var(--color-sidebar-border)]'
                : 'flex flex-col border-b border-[var(--color-sidebar-border)]'
            }
          >
            {collapsed ? (
              <Link href="/home" title="Монолитика — на главную">
                <BrandLogo size={18} />
              </Link>
            ) : (
              <>
                {/* pl-[22px] — лого и слоган в одном вертикальном ритме с иконками
                    пунктов меню (правка Иосифа 16.07): x иконки «Продажи» =
                    px-2 нава (8) + mx-1 пункта (4) + px-2.5 пункта (10) = 22px.
                    Кнопки сворачивания в шапке больше нет — ручка на кромке. */}
                <div className="flex items-center gap-2 pl-[22px] pr-3 pt-3 pb-1 min-w-0">
                  <Link href="/home" className="flex items-center gap-2 min-w-0" title="На главную">
                    <BrandLogo size={22} className="shrink-0" />
                    <span className="text-[var(--color-sidebar-text)] font-semibold text-sm leading-none tracking-wide truncate">Монолитика</span>
                  </Link>
                </div>
                <span className={`pl-[22px] pr-3 pb-2.5 ${BRAND_TAGLINE_CLS}`}>{BRAND_TAGLINE_TEXT}</span>
              </>
            )}
          </div>
          <SidebarBody
            collapsed={collapsed} pathname={pathname} user={user}
            expanded={expanded} setExpanded={setExpanded} logout={logout}
            changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
          />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
            <aside className="relative flex flex-col h-full w-[260px] max-w-[80vw] bg-[var(--color-sidebar-bg)] shadow-[0_0_24px_rgba(0,0,0,0.12)]">
              {/* Тот же двухрядный header, что у десктопного сайдбара — тумблер
                  Лайт/Про убран и здесь (правка Иосифа 16.07, остался в ЛК). */}
              <div className="flex flex-col border-b border-[var(--color-sidebar-border)] shrink-0">
                <div className="flex items-center justify-between gap-2 pl-[22px] pr-3 pt-3 pb-1">
                  <Link href="/home" className="flex items-center gap-2 min-w-0" title="На главную">
                    <BrandLogo size={22} className="shrink-0" />
                    <span className="text-[var(--color-sidebar-text)] font-semibold text-sm leading-none tracking-wide truncate">Монолитика</span>
                  </Link>
                  <button
                    onClick={() => setMobileOpen(false)}
                    className="tap-target text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)] p-1 rounded-md shrink-0 transition-colors"
                  >
                    <X size={18} />
                  </button>
                </div>
                <span className={`pl-[22px] pr-3 pb-2.5 ${BRAND_TAGLINE_CLS}`}>{BRAND_TAGLINE_TEXT}</span>
              </div>
              <SidebarBody
                collapsed={false} pathname={pathname} user={user}
                expanded={expanded} setExpanded={setExpanded} logout={logout}
                changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
              />
            </aside>
          </div>
        )}

        {/* Main */}
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Mobile topbar */}
          <div className="md:hidden flex items-center gap-1.5 h-12 px-2 bg-[var(--color-sidebar-bg)] border-b border-[var(--color-sidebar-border)] shrink-0">
            <button
              onClick={() => setMobileOpen(true)}
              className="tap-target min-w-11 min-h-11 flex items-center justify-center text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] rounded"
              aria-label="Открыть меню"
            >
              <Menu size={20} />
            </button>
            <Link href="/home" className="flex items-center gap-1.5 min-w-0" title="На главную">
              <BrandLogo size={20} className="shrink-0" />
              <span className="text-[var(--color-sidebar-text)] font-semibold text-sm tracking-wide truncate">Монолитика</span>
            </Link>
          </div>
          <main className="flex-1 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
      </div>
      {changelogOpen && (
        <ChangelogPanel
          onClose={() => setChangelogOpen(false)}
          onOpenIdeas={() => setIdeasOpen(true)}
        />
      )}
      {ideasOpen && <IdeasPanel onClose={() => setIdeasOpen(false)} />}
      </TooltipProvider>
    </QueryProvider>
  );
}
