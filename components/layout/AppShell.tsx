'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarChart3, Truck, Megaphone, UserPlus,
  ChevronDown, ChevronRight, PanelLeftClose, PanelLeft, LogOut, Settings,
  Bookmark, BookOpen, Trash2, BarChart2, ClipboardList, Network, Gauge, Menu, X, Bell, Lightbulb,
  RotateCcw, Pencil,
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { SessionUser } from '@/lib/auth/session';
import { hasPerm, isReportAdmin, type PermKey } from '@/lib/auth/perms';
import { Avatar } from '@/components/ui/Avatar';
import { QueryProvider } from '@/components/providers/QueryProvider';
import { BrandLogo } from '@/components/ui/BrandLogo';
import { MARKETING_PRESETS } from '@/lib/marketing/presets';
import type { SavedReport, TrashedReport } from '@/lib/saved-reports/types';
import { ChangelogPanel } from '@/features/changelog/ui/ChangelogPanel';
import { useChangelogQuery } from '@/features/changelog/ui/useChangelogQuery';
import { IdeasPanel } from '@/features/ideas/ui/IdeasPanel';
import { useUiMode, type UiMode } from '@/lib/hooks/useUiMode';
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

/* Общий паттерн пункта 1-го уровня (NAV-блок, Сводная/Планы/Декомпозиция,
   Метрики/Настройки) — редизайн сайдбара, итерация 3 (бриф Виктора). */
const NAV_ITEM_BASE =
  'flex items-start gap-2.5 px-2 py-1.5 mx-1 my-0.5 rounded-lg text-sm leading-[1.35] relative transition-colors';
const NAV_ITEM_ACTIVE = 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)] font-semibold';
const NAV_ITEM_INACTIVE = 'text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)]';
// Левая акцентная полоска активного пункта — аналог .sb-item.active::before из мока.
const NAV_ITEM_ACTIVE_BAR =
  "before:content-[''] before:absolute before:left-[-10px] before:top-[6px] before:bottom-[6px] before:w-[3px] before:rounded-r before:bg-[var(--color-sidebar-active)]";

function navIconCls(active: boolean) {
  return active ? 'text-[var(--color-sidebar-active)] mt-px' : 'text-[var(--color-sidebar-text-muted)] mt-px';
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
// Правка задачи 1599: слоган выровнен по правому краю (`text-right`) —
// раньше был прижат к левому краю/растянут на всю ширину (`block` без
// text-align). Текст «...для монолитика» исправлен на «...для монолита»
// (опечатка в брифе ребрендинга).
const BRAND_TAGLINE_CLS =
  'block whitespace-nowrap text-right text-[9.5px] font-medium uppercase tracking-[0.04em] text-[var(--color-sidebar-text-muted)]';
const BRAND_TAGLINE_TEXT = '— аналитика для монолита'.toUpperCase();

// Тумблер «Про/Лайт» под лочапом (п.1 правок 09.07/2): компактный сегмент, дёргает
// ТОТ ЖЕ серверный ui_mode, что и тумблер в ЛК (useUiMode — общий queryKey ['ui-mode'],
// переключение в одном месте мгновенно видно в другом). Отдельный компонент (а не
// инлайн в AppShell) — хук использует react-query, а AppShell сам монтирует
// QueryProvider ниже себя по дереву; хук обязан жить в компоненте-потомке провайдера
// (тот же приём, что и у SidebarBody/SalesSidebarSection).
// Досинхронизация зеркала localStorage.theme с серверным users.theme (переключатель —
// в ЛК, ProfilePage) — сам компонент ничего не рендерит, только держит хук живым в
// дереве всех авторизованных страниц (тот же приём, что и UiModeSwitch ниже: хук на
// react-query обязан жить ПОД QueryProvider, который монтирует сам AppShell).
function ThemeSync() {
  useTheme();
  return null;
}

function UiModeSwitch() {
  const { uiMode, setUiMode } = useUiMode();
  // Задача 1575: раньше был `mt-1.5 w-fit` и рендерился внутри узкой колонки
  // лого+название — визуально прижат к левому краю сайдбара. Ширина (`w-fit`)
  // и верхний отступ теперь задаются местом использования (обёрткой
  // `flex justify-center`), сам переключатель — просто содержимое по центру
  // своей ширины, без внешних отступов/позиционирования.
  return (
    <div className="flex border border-[var(--color-sidebar-border)] rounded-md overflow-hidden text-[11px] font-medium w-fit">
      {(['basic', 'pro'] as UiMode[]).map(m => (
        <button
          key={m}
          onClick={() => setUiMode(m)}
          className={`px-2 py-0.5 transition-colors ${
            uiMode === m
              ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active)]'
              : 'text-[var(--color-sidebar-text-muted)] hover:bg-[var(--color-sidebar-hover-bg)]'
          }`}
        >
          {m === 'basic' ? 'Лайт' : 'Про'}
        </button>
      ))}
    </div>
  );
}

function SalesSidebarSection({ collapsed, pathname, user }: { collapsed: boolean; pathname: string; user: SessionUser }) {
  const [openStd, setOpenStd] = useState(true);
  const [openFav, setOpenFav] = useState(true);
  const [openShared, setOpenShared] = useState(true);
  // Корзина (бриф 09.07, п.2): ВСЕГДА свёрнута по умолчанию, даже когда «Продажи»/
  // «Роп монитор»/«Избранное» развёрнуты — независимое состояние, не связано с ними.
  const [openTrash, setOpenTrash] = useState(false);
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

  // Корзина: свои удалённые личные отчёты видит любой; удалённые витринные —
  // только admin (action.shared_reports.manage) — сервер уже фильтрует по этому
  // праву (GET /api/saved-reports/trash), клиент просто рендерит, что пришло.
  const { data: trashedReports = [] } = useQuery<TrashedReport[]>({
    queryKey: ['saved-reports-trash'],
    queryFn: async () => {
      const res = await fetch('/api/saved-reports/trash');
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 30_000,
  });

  async function deleteReport(id: string, name: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    // Задача 1605, доп. владельца: клик по корзинке не должен удалять сразу —
    // тот же лёгкий паттерн confirm(), что уже используется в permanentlyDelete
    // ниже (единственный существующий UI-паттерн подтверждения в этом файле для
    // одиночного деструктивного действия — полноценная модалка тут избыточна).
    if (!confirm(`Удалить отчёт «${name}»? Он переместится в корзину — оттуда можно восстановить.`)) return;
    // Корзина (бриф 09.07, п.2): DELETE больше не стирает отчёт — переносит в
    // корзину (deleted_at). Настоящее удаление — отдельная кнопка внутри корзины.
    await fetch(`/api/saved-reports/${id}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
  }

  async function restoreReport(id: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await fetch(`/api/saved-reports/${id}/restore`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['saved-reports'] });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
  }

  async function permanentlyDelete(id: string, name: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Удалить отчёт «${name}» навсегда? Это нельзя отменить.`)) return;
    await fetch(`/api/saved-reports/${id}/permanent`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['saved-reports-trash'] });
  }

  // Переименование (правка владельца 10.07, п.2 «дай админам возможность
  // переназывать отчеты во всех разделов») — инлайн-редактирование прямо в
  // сайдбаре (проще полноценной модалки для одного поля). Права проверяет сервер
  // (PATCH /api/saved-reports/[id]) — свой личный отчёт правит владелец, витринный —
  // админ; см. app/api/saved-reports/[id]/route.ts::PATCH. Конфликт имени внутри
  // раздела — простая ошибка алертом (решение по простоте, не отдельный диалог —
  // тот же паттерн alert/confirm, что уже использует permanentlyDelete выше).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  function startRename(r: SavedReport, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setRenamingId(r.id);
    setRenameValue(r.name);
  }

  async function commitRename(id: string) {
    const trimmed = renameValue.trim();
    setRenamingId(null);
    if (!trimmed) return;
    const res = await fetch(`/api/saved-reports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      qc.invalidateQueries({ queryKey: ['saved-reports'] });
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? 'Не удалось переименовать отчёт');
    }
  }

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

  // Задача 1605, 3-я итерация фидбека владельца (после 1589/1575): карандаш за
  // текстом и одиночная корзинка-оверлей выше линии текста забракованы — образец
  // от Серёги = кнопки-иконки шапки колонок таблицы отчётов (ReportTable.tsx,
  // сегменты «полоски-настроек» метрики: `rounded-[7px] border`, сегменты
  // `w-6`/`h-5` с общим бордером). Теперь ОБЕ иконки — один `absolute`-«пилл»
  // у правого края строки (группа из двух квадратных сегментов с общей рамкой,
  // как в шапке), а не одна в потоке текста и одна отдельно:
  // - pillCls — сама группа, `top-1/2 -translate-y-1/2` центрирует её по
  //   вертикали относительно всей высоты строки (`relative` родитель — сам
  //   `<Link>`, см. linkCls ниже) — для однострочного названия (эталонный
  //   случай) это ровно центр строки текста;
  // - renameBtnCls/delBtnCls — сегменты внутри пилла, общая рамка между ними
  //   даёт `border-r` только у первого (карандаш), совпадает с паттерном
  //   ReportTable.tsx (там же между сегментами `border-l`/`border-r`, не у
  //   каждого свой квадрат по отдельности).
  const pillCls =
    'hover-reveal absolute right-1 top-1/2 -translate-y-1/2 flex items-stretch h-5 rounded-[7px] border border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] overflow-hidden shadow-[0_1px_2px_rgba(33,37,41,0.06)]';
  const renameBtnCls =
    'w-6 flex-shrink-0 flex items-center justify-center border-r border-[var(--color-sidebar-border)] text-[var(--color-sidebar-text-muted)] hover:bg-[var(--color-sidebar-hover-bg)] hover:text-[var(--color-accent)] transition-colors';
  const delBtnCls =
    'w-6 flex-shrink-0 flex items-center justify-center text-[var(--color-sidebar-text-muted)] hover:bg-[var(--color-sidebar-hover-bg)] hover:text-[var(--color-negative)] transition-colors';
  const renameInputCls =
    'flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-accent)] rounded-[5px] px-1.5 py-0.5 text-[13px] text-[var(--color-sidebar-text)] outline-none';

  // Одна строка отчёта в сайдбаре (ссылка + порядок + переименование + удаление) —
  // переиспользуется для всех трёх списков (Роп монитор / Смекалочная / Избранное),
  // различается только правом на управление (canManage — свой отчёт или витрина, где
  // я админ) и списком своего раздела (list — для DnD и позиции индикатора вставки).
  function renderReportRow(r: SavedReport, canManage: boolean, list: SavedReport[]) {
    const href = `/sales/saved/${r.id}`;
    const idx = list.findIndex(x => x.id === r.id);
    if (renamingId === r.id) {
      return (
        <div key={r.id} className="flex items-center gap-1.5 py-1 px-2 my-0.5">
          <input
            autoFocus
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename(r.id);
              if (e.key === 'Escape') setRenamingId(null);
            }}
            onBlur={() => commitRename(r.id)}
            className={renameInputCls}
          />
        </div>
      );
    }
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
        className={`group relative flex items-center gap-0.5${dropIndicatorCls}${dragId === r.id ? ' opacity-40' : ''}`}
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
          {/* pr-14 резервирует место под пилл из двух иконок (absolute справа,
              ~48px + отступ) — иначе на обёрнутом на 2 строки названии текст
              мог бы уйти под кнопки. */}
          <span className="flex-1 min-w-0 break-words line-clamp-2 pr-14">
            {r.name}
          </span>
          {canManage && (
            <div className={pillCls}>
              <button onClick={e => startRename(r, e)} className={renameBtnCls} title="Переименовать">
                <Pencil size={12} />
              </button>
              <button onClick={e => deleteReport(r.id, r.name, e)} className={delBtnCls} title="Удалить">
                <Trash2 size={12} />
              </button>
            </div>
          )}
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
      {/* «Создать отчёт» (задача 1572): видна ВСЕМ, включая Лайт — не завязана
          на isReportAdmin/canManage, только на то, что раздел «Продажи» вообще
          открыт (section.sales, уже проверено выше по дереву в NAV.filter). */}
      <div className="mx-1 mb-2">
        <CreateReportButton
          label="Создать отчёт"
          className="tap-target w-full flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-[12.5px] font-medium rounded-lg border border-dashed border-[var(--color-sidebar-border)] text-[var(--color-sidebar-text)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-sidebar-hover-bg)] transition-colors"
        />
      </div>

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

      {/* Корзина (бриф 09.07, п.2) — ВНИЗУ списка отчётов, после витрин/избранного,
          всегда свёрнута по умолчанию (openTrash инициализирован false, независимо
          от остальных под-групп). Свои удалённые видит любой; удалённые витринные —
          только admin (сервер уже отфильтровал, см. GET /api/saved-reports/trash). */}
      <div className={subgroupCls}>
        <button onClick={() => setOpenTrash(v => !v)} className={subgroupLabelCls}>
          <Trash2 size={11} />
          <span className="flex-1 text-left">Корзина</span>
          {trashedReports.length > 0 && (
            <span className="shrink-0 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-sidebar-border)] text-[var(--color-sidebar-text-muted)] text-[9px] font-bold flex items-center justify-center">
              {trashedReports.length}
            </span>
          )}
          {openTrash ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {openTrash && (
          trashedReports.length === 0 ? (
            <div className="text-xs text-[var(--color-sidebar-text-muted)] py-1 px-1">
              Корзина пуста
            </div>
          ) : (
            trashedReports.map(r => (
              <div key={r.id} className="flex flex-col gap-0.5 py-1.5 px-2 my-0.5 text-[13px] rounded-[7px]">
                <div className="flex items-start gap-1.5">
                  <span className="flex-1 min-w-0 break-words line-clamp-2 text-[var(--color-sidebar-text-muted)]" title={r.name}>
                    {r.name}
                    {r.isShared && (
                      <span className="ml-1.5 align-middle inline-block px-1 py-px text-[9px] rounded bg-[var(--color-sidebar-border)] text-[var(--color-sidebar-text-muted)]">
                        витрина
                      </span>
                    )}
                  </span>
                </div>
                <div className="text-[10.5px] text-[var(--color-sidebar-text-muted)] opacity-80">
                  {format(new Date(r.deletedAt), 'd MMM, HH:mm', { locale: ru })}
                  {r.deletedBy && ` · ${r.deletedBy}`}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <button
                    onClick={e => restoreReport(r.id, e)}
                    className="flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    <RotateCcw size={11} /> Восстановить
                  </button>
                  <button
                    onClick={e => permanentlyDelete(r.id, r.name, e)}
                    className="flex items-center gap-1 text-[11px] text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-negative)]"
                  >
                    <Trash2 size={11} /> Удалить навсегда
                  </button>
                </div>
              </div>
            ))
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

const NAV: NavItem[] = [
  { label: 'Продажи', icon: <BarChart3 size={18} />, isSales: true, perm: 'section.sales' },
  { label: 'Реализация', icon: <Truck size={18} />, disabled: true },
  {
    label: 'Маркетинг', icon: <Megaphone size={18} />, perm: 'section.marketing',
    children: Object.entries(MARKETING_PRESETS).map(([key, p]) => ({
      label: p.title,
      href: `/marketing/${key}`,
    })),
  },
  { label: 'Найм', icon: <UserPlus size={18} />, disabled: true },
];

/* Содержимое сайдбара (nav + нижние секции + footer) — общее для десктопного
   <aside> и мобильного off-canvas drawer, поэтому вынесено из AppShell. */
function SidebarBody({
  collapsed, pathname, user, expanded, setExpanded, logout,
  changelogOpen, onOpenChangelog, ideasOpen, onOpenIdeas,
}: {
  collapsed: boolean;
  pathname: string;
  user: SessionUser;
  expanded: string;
  setExpanded: React.Dispatch<React.SetStateAction<string>>;
  logout: () => void;
  changelogOpen: boolean;
  onOpenChangelog: () => void;
  ideasOpen: boolean;
  onOpenIdeas: () => void;
}) {
  const salesActive = pathname.startsWith('/sales');
  const showSummaryBlock = hasPerm(user, 'section.summary') || hasPerm(user, 'section.plans') || hasPerm(user, 'section.decomposition');
  const showMetricsBlock = hasPerm(user, 'section.metrics') || hasPerm(user, 'section.settings');
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
                  <div className={`${NAV_ITEM_BASE} cursor-not-allowed`}>
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
                ) : item.isSales ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className={`w-full ${NAV_ITEM_BASE} ${salesActive ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(salesActive)}>{item.icon}</span>
                      {!collapsed && <>
                        <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                        {expanded === item.label
                          ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                          : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                      </>}
                    </button>
                    {!collapsed && expanded === item.label && (
                      <div className="py-1">
                        <SalesSidebarSection collapsed={collapsed} pathname={pathname} user={user} />
                      </div>
                    )}
                  </>
                ) : item.children ? (
                  <>
                    <button
                      onClick={() => setExpanded(v => v === item.label ? '' : item.label)}
                      className={`w-full ${NAV_ITEM_BASE} ${NAV_ITEM_INACTIVE}`}
                    >
                      <span className={navIconCls(false)}>{item.icon}</span>
                      {!collapsed && <>
                        <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">{item.label}</span>
                        {expanded === item.label
                          ? <ChevronDown size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />
                          : <ChevronRight size={14} className="text-[var(--color-sidebar-text-muted)] mt-[3px] shrink-0" />}
                      </>}
                    </button>
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
                  <Link
                    href={item.href!}
                    className={`${NAV_ITEM_BASE} ${pathname === item.href ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                  >
                    <span className={navIconCls(pathname === item.href)}>{item.icon}</span>
                    {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">{item.label}</span>}
                  </Link>
                )}
              </div>
            ))}
          </nav>

          {/* Сводная + Планы + Декомпозиция — рендерим блок целиком только если
              есть право хотя бы на один из трёх пунктов, иначе на светлой панели
              висит одинокая линия-разделитель над футером у обычных юзеров. */}
          {showSummaryBlock && (
            <div className="border-t border-[var(--color-sidebar-border)] pt-1 px-2">
              {hasPerm(user, 'section.summary') && (
                <Link
                  href="/summary"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/summary') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/summary'))}><Gauge size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Сводная</span>}
                </Link>
              )}
              {hasPerm(user, 'section.plans') && (
                <Link
                  href="/plans"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/plans') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/plans'))}><ClipboardList size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Планы</span>}
                </Link>
              )}
              {hasPerm(user, 'section.decomposition') && (
                <Link
                  href="/decomposition"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/decomposition') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/decomposition'))}><Network size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Декомпозиция</span>}
                </Link>
              )}
            </div>
          )}

          {/* Метрики + Настройки — по правам */}
          {showMetricsBlock && (
            <div className="pt-1 px-2">
              {hasPerm(user, 'section.metrics') && (
                <Link
                  href="/metrics"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/metrics') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/metrics'))}><BarChart2 size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Метрики</span>}
                </Link>
              )}
              {hasPerm(user, 'section.settings') && (
                <Link
                  href="/settings"
                  className={`${NAV_ITEM_BASE} ${pathname.startsWith('/settings') ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
                >
                  <span className={navIconCls(pathname.startsWith('/settings'))}><Settings size={18} /></span>
                  {!collapsed && <span className="flex-1 min-w-0 break-words line-clamp-2">Настройки</span>}
                </Link>
              )}
            </div>
          )}

          {/* «Идеи и планы» — бэклог идей (макет ideas-backlog-mock.html), НАД
              «Что изменилось?», виден всем независимо от прав, как и ченджлог. */}
          <div className="pt-1 px-2">
            <button
              type="button"
              onClick={onOpenIdeas}
              className={`w-full ${NAV_ITEM_BASE} ${ideasOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
            >
              <span className={navIconCls(ideasOpen)}><Lightbulb size={18} /></span>
              {!collapsed && (
                <span className="flex-1 min-w-0 break-words line-clamp-2 text-left">Идеи и планы</span>
              )}
            </button>
          </div>

          {/* «Что изменилось?» — ченджлог, виден всем независимо от прав (п.4 задачи) */}
          <div className="pt-1 px-2">
            <button
              type="button"
              onClick={onOpenChangelog}
              className={`w-full ${NAV_ITEM_BASE} ${changelogOpen ? `${NAV_ITEM_ACTIVE} ${NAV_ITEM_ACTIVE_BAR}` : NAV_ITEM_INACTIVE}`}
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
  // Главная открывается со свёрнутой рельсой-сайдбаром (бриф Главной,
  // analsteroid-home-mock.html) — только дефолт первого рендера; дальше
  // пользователь разворачивает/сворачивает вручную как обычно, и это не
  // перетирается при последующих клиентских переходах на/с главной.
  const [collapsed, setCollapsed] = useState(() => pathname === '/home');
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
      <ThemeSync />
      <div className="flex h-dvh overflow-hidden">
        {/* Desktop sidebar (на <md скрыт — вместо него drawer) */}
        <aside
          className="hidden md:flex flex-col shrink-0 bg-[var(--color-sidebar-bg)] border-r border-[var(--color-sidebar-border)] transition-all duration-200"
          style={{ width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED }}
        >
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
              <>
                <Link href="/home" title="Монолитика — на главную">
                  <BrandLogo size={18} />
                </Link>
                <button
                  onClick={() => setCollapsed(v => !v)}
                  className="text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)] p-1 rounded-md shrink-0 transition-colors"
                >
                  <PanelLeft size={18} />
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
                  {/* items-center + leading-none на названии — раньше базовая линия
                      текста визуально «плавала» относительно центра знака лого
                      (line-height шрифта давал текстовому блоку лишнюю высоту сверху/
                      снизу центра); leading-none убирает этот зазор, gap-2 остаётся
                      единым интервалом лого↔название для всех мест лочапа (шапка/
                      мобильный drawer/топбар). */}
                  <Link href="/home" className="flex items-center gap-2 min-w-0" title="На главную">
                    <BrandLogo size={22} className="shrink-0" />
                    <span className="text-[var(--color-sidebar-text)] font-semibold text-sm leading-none tracking-wide truncate">Монолитика</span>
                  </Link>
                  <button
                    onClick={() => setCollapsed(v => !v)}
                    className="text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] hover:bg-[var(--color-sidebar-hover-bg)] p-1 rounded-md shrink-0 transition-colors"
                  >
                    <PanelLeftClose size={18} />
                  </button>
                </div>
                <span className={`px-3 ${BRAND_TAGLINE_CLS}`}>{BRAND_TAGLINE_TEXT}</span>
                <div className="flex justify-center px-3 pt-1.5 pb-2.5">
                  <UiModeSwitch />
                </div>
              </>
            )}
          </div>
          <SidebarBody
            collapsed={collapsed} pathname={pathname} user={user}
            expanded={expanded} setExpanded={setExpanded} logout={logout}
            changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
            ideasOpen={ideasOpen} onOpenIdeas={() => setIdeasOpen(true)}
          />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-black/30" onClick={() => setMobileOpen(false)} />
            <aside className="relative flex flex-col h-full w-[260px] max-w-[80vw] bg-[var(--color-sidebar-bg)] shadow-[0_0_24px_rgba(0,0,0,0.12)]">
              {/* Тот же трёхрядный header, что у десктопного сайдбара (задача 1575) —
                  слоган не режется, тумблер Лайт/Про центрирован по ширине шапки. */}
              <div className="flex flex-col border-b border-[var(--color-sidebar-border)] shrink-0">
                <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
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
                <span className={`px-3 ${BRAND_TAGLINE_CLS}`}>{BRAND_TAGLINE_TEXT}</span>
                <div className="flex justify-center px-3 pt-1.5 pb-2.5">
                  <UiModeSwitch />
                </div>
              </div>
              <SidebarBody
                collapsed={false} pathname={pathname} user={user}
                expanded={expanded} setExpanded={setExpanded} logout={logout}
                changelogOpen={changelogOpen} onOpenChangelog={() => setChangelogOpen(true)}
                ideasOpen={ideasOpen} onOpenIdeas={() => setIdeasOpen(true)}
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
              className="tap-target text-[var(--color-sidebar-text-muted)] hover:text-[var(--color-sidebar-text)] p-2 rounded"
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
      {changelogOpen && <ChangelogPanel onClose={() => setChangelogOpen(false)} />}
      {ideasOpen && <IdeasPanel onClose={() => setIdeasOpen(false)} />}
    </QueryProvider>
  );
}
