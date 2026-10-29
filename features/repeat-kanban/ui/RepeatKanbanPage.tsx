'use client';
// Канбан повторных продаж (решения владельца 20.10, ai_docs/fresh_docs/REPEAT_KANBAN_SPEC.md).
// Карточка = заказчик. Колонки двигаются только по данным (отгрузки, стадии сделки,
// звонки) — руками ничего не перетаскивается. Ручные действия: задача (+ сделка в
// Битриксе) от РОПа, «выполнено» от менеджера, разбор отказа РОПом.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CheckSquare, PhoneCall, Moon, ChevronsDown, ChevronsUp, HelpCircle, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, RefreshCw, Phone, PhoneMissed, ClipboardList, AlertTriangle, Plus, Search, SlidersHorizontal, X, CalendarDays } from 'lucide-react';
import { listParam, stringParam, useUrlState } from '@/lib/hooks/useUrlState';
import { DepartmentPicker } from '@/features/reports/ui/FilterBar';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Modal } from '@/components/ui/Modal';
import { Popover } from '@/components/ui/Popover';
import { DateRangePicker } from '@/features/reports/ui/DateRangePicker';
import { endOfDay, format, parseISO, startOfMonth } from 'date-fns';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { CustomerCardLoader } from '@/features/customers/ui/CustomerCardLoader';
import type { ClientCardTab } from '@/features/client-module/ui/ClientModuleWidget';

const CARD_TABS = ['overview', 'deals', 'purchases', 'objects', 'calls', 'questionnaire', 'ai'] as const;
import { RepeatKanbanSettingsButton, TemplatePicker } from './RepeatKanbanSettings';

// Карточка сделки — динамически: она сама открывает карточку клиента (цикл модулей).
import {
  BRAK_REASONS, CLIENT_TYPE_ORDER, CLIENT_TYPE_STYLE, taskUrl, CLIENT_TYPE_SHORT, COLUMNS, TOUCHES, WINDOW_DAYS, HIDE_FOREVER, fmtHideUntil, GROUP_PERIODS, LOST_STAGES, WON_STAGES, AI_CANDIDATE_MIN, postponePresets, SHIP_BUCKETS,
  type ColumnDef, type ColumnGroup, type ColumnKey,
} from '../engine/config';
import type { BoardKpi, KanbanCard, KanbanColumn, RepeatBoard, TodaySection } from '../engine/board';
import type { TaskNote } from '../engine/taskNotes';
import type { RepeatTask } from '../engine/tasks';
import { QueueView } from './QueueView';
import { TagChip, TagsModal } from './TagsModal';
import { AcceptTaskModal } from './AcceptTaskModal';
import { TaskCheckModal, useTaskChecks, VERDICT, type TaskCheckState } from './TaskCheck';
import { ParticipantsPicker, initialParticipants, participantsPayload } from './ParticipantsPicker';
import { AttachmentsRow, useAttachments } from './Attachments';
import { PostponePicker } from './PostponePicker';
import { NO_TAG, type TagDef } from '../engine/tagColors';

const PAGE = 40;
// Все кнопки шапки — одного вида (правка владельца 20.10: «кнопочки приведи к одному виду»).
const BTN = 'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-3 text-sm transition-colors';
/** Визуал карточки (владелец 23.10: «ховеры, чтобы было очевидно, что нажимается, а что нет»).
 *  Единое правило: в Битрикс — акцентный цвет + «↗»; внутри Монолитики — жирный текст, подчёркивание точками;
 *  у всего кликабельного — кольцо фокуса для клавиатуры и отклик на нажатие. */
const FOCUS = 'rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1';
const BX_LINK = `${FOCUS} text-[var(--color-accent)] hover:underline underline-offset-2`;
const CARD_BTN = `${FOCUS} transition active:scale-[0.98]`;
const BTN_IDLE = `${BTN} border-[var(--color-border)] bg-[var(--color-bg-surface)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]`;
const BTN_ACTIVE = `${BTN} border-[var(--color-accent)] bg-[var(--color-accent)] text-white`;
const rub = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const money = (n: number) => `${rub.format(n)} ₽`;
const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const fmtDayYear = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'Europe/Moscow' });
const fmtDT = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }) : '—');
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} с`);
const dealUrl = (id: number) => `https://td.monolit-crm.ru/crm/deal/details/${id}/`;
const cardName = (c: KanbanCard) => c.name ?? `${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId}`;

const TASK_FILTERS = [
  { value: 'none', label: 'Без задачи', hint: 'не ставили или прошлую приняли' },
  { value: 'unread', label: 'Не просмотрена', hint: 'менеджер ещё не открыл' },
  { value: 'work', label: 'В работе', hint: 'открыл или начал' },
  { value: 'overdue', label: 'Просрочена', hint: 'срок прошёл' },
  { value: 'control', label: 'Ждёт приёмки', hint: 'менеджер сдал, постановщик не принял' },
  { value: 'done', label: 'Принята', hint: 'постановщик принял' },
] as const;
const SORT_OPTIONS = [
  { value: 'default', label: 'Сортировка: тип клиента и потенциал' },
  { value: 'ltv', label: 'Сортировка: LTV — больше сверху' },
  { value: 'potential', label: 'Сортировка: потенциал — больше сверху' },
  { value: 'fresh', label: 'Сортировка: свежие отгрузки сверху' },
  { value: 'task', label: 'Сортировка: по задачам — что разобрать' },
  { value: 'ev', label: 'Сортировка: ожидаемые деньги (шанс × чек)' },
  { value: 'tag', label: 'Сортировка: по тегам — с тегами сверху' },
] as const;
const OUTCOME_OPTIONS = [
  { value: '', label: 'Последняя сделка: любая' },
  { value: 'won', label: 'Последняя сделка: успешная', hint: 'после последней отгрузки отказов не было' },
  { value: 'lost', label: 'Последняя сделка: проигранная', hint: 'повторная сделка после отгрузки закрыта в отказ' },
] as const;

/** Последние комментарии задач видимых карточек — грузятся отдельно от доски (идут в Битрикс). */
const TaskNotesCtx = createContext<Record<string, TaskNote>>({});
/** Словарь тегов смотрящего (базовые + личные) — для плашек на карточках. */
const TagDefsCtx = createContext<Map<number, TagDef>>(new Map());
/** Проверки звонков по задачам (только РОПу): taskId → есть ли звонок после постановки и результат проверки. */
const TaskChecksCtx = createContext<Record<string, TaskCheckState>>({});

const GROUPS: { key: ColumnGroup; title: string; hint: string }[] = [
  { key: 'pool', title: 'Пул', hint: 'Нет открытой повторной сделки' },
  { key: 'touch', title: 'Дозвон', hint: `Взят в работу → до ${TOUCHES} попыток связаться (по дням)` },
  { key: 'stage', title: 'Повторная воронка', hint: 'Сделка в работе' },
  { key: 'review', title: 'Разбор', hint: 'Отказы и брак' },
  { key: 'hidden', title: 'Скрытые', hint: 'Скрыты из пула до даты' },
];

class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function post(body: Record<string, unknown>) {
  const r = await fetch('/api/repeat-kanban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Ошибка ${r.status}`);
  return j;
}

export function RepeatKanbanPage() {
  const qc = useQueryClient();
  const [mgrs, setMgrs] = useUrlState('managers', listParam([]));
  const [type, setType] = useUrlState('type', stringParam(''));
  const [depts, setDepts] = useUrlState('dept', listParam([]));
  // Отдел сохраняется на аккаунте (владелец 29.10, users.ui_prefs): нет ?dept= в ссылке — подставляем сохранённый,
  // доску грузим после этого (иначе сначала прилетит вся зона, потом отдел).
  const [prefsReady, setPrefsReady] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('dept')) { setPrefsReady(true); return; }
    fetch('/api/me/ui-prefs').then(r => (r.ok ? r.json() : null)).then(j => {
      const saved = j?.prefs?.repeatKanbanDepts;
      if (Array.isArray(saved) && saved.length) setDepts(saved as string[]);
    }).catch(() => {}).finally(() => setPrefsReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const changeDepts = (ids: string[]) => {
    setDepts(ids);
    void fetch('/api/me/ui-prefs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repeatKanbanDepts: ids.length ? ids : null }) }).catch(() => {});
  };
  const [pg, setPg] = useUrlState('pg', stringParam(''));
  // Товарная группа: last — последняя отгрузка (пул), ever — отгружали когда-либо за период (вся доска).
  const [pgm, setPgm] = useUrlState('pgm', stringParam('last'));
  const [pgp, setPgp] = useUrlState('pgp', stringParam('1y'));
  const [pgf, setPgf] = useUrlState('pgf', stringParam(''));
  const [pgt, setPgt] = useUrlState('pgt', stringParam(''));
  const ever = pgm === 'ever';
  const [taskF, setTaskF] = useUrlState('tasks', listParam([]));
  const [tagF, setTagF] = useUrlState('tags', listParam([]));
  const [aiF, setAiF] = useUrlState('ai', stringParam(''));
  const [offerF, setOfferF] = useUrlState('offer', stringParam(''));
  const offerGroups = useMemo(() => offerF.split('|').filter(Boolean), [offerF]);
  const [sort, setSort] = useUrlState('sort', stringParam('default'));
  const [outcome, setOutcome] = useUrlState('outcome', stringParam(''));
  const [shipsF, setShipsF] = useUrlState('ships', listParam([]));
  // Дата последней отгрузки (владелец 23.10): диапазон YYYY-MM-DD, пикер с пресетами из отчётов.
  const [shf, setShf] = useUrlState('shf', stringParam(''));
  const [sht, setSht] = useUrlState('sht', stringParam(''));
  const [view, setView] = useUrlState('view', stringParam('board'));
  // Поиск заказчика (владелец 21.10): ввод — сразу, запрос — через 400 мс после паузы.
  const [q, setQ] = useUrlState('q', stringParam(''));
  const [qInput, setQInput] = useState(q);
  useEffect(() => { const t = setTimeout(() => { if (qInput.trim() !== q) { setQ(qInput.trim()); setLimits({}); } }, 400); return () => clearTimeout(t); }, [qInput, q, setQ]);
  const poolGroups = useMemo(() => pg.split('|').filter(Boolean), [pg]);
  const [limits, setLimits] = useState<Partial<Record<ColumnKey, number>>>({});
  // Открытая карточка клиента и её вкладка — в адресе (владелец 23.10: «скопировать ссылку на карточку заказчика в
  // канбане и её состояние — конкретную открытую вкладку»): ?card=<ключ заказчика>&ctab=<вкладка>.
  const [cardKey, setCardKey] = useUrlState('card', stringParam(''));
  const [ctab, setCtab] = useUrlState('ctab', stringParam(''));
  const setOpenCard = (c: KanbanCard | null, tab = '') => { setCardKey(c?.clientKey ?? ''); setCtab(c ? tab : ''); };
  const [taskFor, setTaskFor] = useState<KanbanCard | null>(null);
  const [reviewFor, setReviewFor] = useState<KanbanCard | null>(null);
  const [hideFor, setHideFor] = useState<KanbanCard | null>(null);
  const [brakFor, setBrakFor] = useState<KanbanCard | null>(null);
  const [mergeFor, setMergeFor] = useState<KanbanCard | null>(null);
  const [tagsFor, setTagsFor] = useState<KanbanCard | null>(null);
  const [acceptFor, setAcceptFor] = useState<KanbanCard | null>(null);
  const [checkFor, setCheckFor] = useState<KanbanCard | null>(null);
  // С какой вкладки открыть карточку клиента: значок разбора → сразу «ИИ-анализ».
  const [hideReqFor, setHideReqFor] = useState<KanbanCard | null>(null);
  // Массовая постановка задач (аудит 21.10: «в работе без задачи» — разом): режим выбора.
  const [selectMode, setSelectMode] = useState(false);
  // «Скрыть показатели» (владелец 22.10: на ноутбуке плитки занимают слишком много места) — помним в браузере.
  const [kpiHidden, setKpiHiddenState] = useState(false);
  useEffect(() => { try { setKpiHiddenState(localStorage.getItem('repeatKanban.kpiHidden') === '1'); } catch { /* приватный режим */ } }, []);
  const setKpiHidden = (v: boolean) => { setKpiHiddenState(v); try { localStorage.setItem('repeatKanban.kpiHidden', v ? '1' : '0'); } catch { /* приватный режим */ } };
  const [selected, setSelected] = useState<Map<string, KanbanCard>>(new Map());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBrakOpen, setBulkBrakOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<RepeatBoard, ApiError>({
    queryKey: ['repeat-kanban', mgrs, type, depts, pg, pgm, pgp, pgf, pgt, taskF, tagF, aiF, offerF, sort, outcome, shipsF, shf, sht, q, limits],
    enabled: prefsReady,
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (mgrs.length) qs.set('managers', mgrs.join(','));
      if (type) qs.set('type', type);
      if (depts.length) qs.set('dept', depts.join(','));
      if (pg) qs.set('pg', pg);
      if (ever) {
        qs.set('pgm', 'ever'); qs.set('pgp', pgp);
        if (pgp === 'custom') { if (pgf) qs.set('pgf', pgf); if (pgt) qs.set('pgt', pgt); }
      }
      if (taskF.length) qs.set('tasks', taskF.join(','));
      if (tagF.length) qs.set('tags', tagF.join(','));
      if (aiF) qs.set('ai', aiF);
      if (offerF) qs.set('offer', offerF);
      if (sort !== 'default') qs.set('sort', sort);
      if (outcome) qs.set('outcome', outcome);
      if (shf && sht) { qs.set('shf', shf); qs.set('sht', sht); }
      if (shipsF.length) qs.set('ships', shipsF.join(','));
      if (q) qs.set('q', q);
      for (const [k, v] of Object.entries(limits)) qs.set(`n_${k}`, String(v));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new ApiError(r.status, j.error ?? `Ошибка ${r.status}`);
      return j as RepeatBoard;
    },
    // Общий список заказчиков компании ещё считается (первый запуск) — спрашиваем чаще.
    // Тестировщик 22.10: «закрываю сделки в Битриксе — карточка остаётся, пока не обновлю». Копия
    // Битрикса отстаёт на секунды, а доска брала свежие данные раз в 2 минуты и при возврате на
    // вкладку — только если им больше минуты. Теперь — сразу при возврате и раз в минуту.
    refetchInterval: q => (q.state.data?.warming ? 5_000 : 60_000),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    // Сразу после перезапуска сервера (выкатка) Redis ещё подключается, а пул SA занят —
    // первый запрос может упасть по таймауту соединения. Повторяем 5xx до трёх раз с паузой,
    // вместо красного «Не удалось собрать канбан» (живой случай 20.10).
    retry: (n, e) => e.status >= 500 && n < 3,
    retryDelay: n => 3000 * (n + 1),
    placeholderData: prev => prev,
  });


  const refresh = () => qc.invalidateQueries({ queryKey: ['repeat-kanban'] });
  const byKey = useMemo(() => new Map<string, KanbanColumn>((data?.columns ?? []).map(c => [c.key, c])), [data]);
  const boardRef = useRef<HTMLDivElement>(null);
  const jump = (g: ColumnGroup) => {
    const el = boardRef.current?.querySelector<HTMLElement>(`[data-group="${g}"]`);
    el?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  };
  // Менеджеры для пикера — отдельным лёгким запросом: кнопка видна сразу, а не после
  // сборки доски (иначе «выбор менеджера пропадает», пока доска грузится).
  const { data: meta } = useQuery<{ managers: { id: string; name: string; load?: number }[] }>({
    queryKey: ['repeat-kanban-managers', depts],
    queryFn: async () => {
      const qs = new URLSearchParams({ meta: '1' });
      if (depts.length) qs.set('dept', depts.join(','));
      const r = await fetch(`/api/repeat-kanban?${qs}`);
      return r.ok ? r.json() : { managers: [] };
    },
    staleTime: 5 * 60_000,
  });
  const managerOptions = meta?.managers ?? data?.managers ?? [];
  const taskLimit = data?.taskLimit ?? 10;
  const loadOf = (id: string) => data?.managerLoad?.[id] ?? meta?.managers.find(m => m.id === id)?.load ?? 0;
  // «И сменить менеджера на …» (владелец 21.10): только РОП и только если включено в настройках.
  const reassignOpts: ReassignOpts | null = data?.canManage && data.reassignEnabled
    ? { managers: managerOptions.map(m => ({ id: m.id, name: m.name })), loadOf } : null;

  // Комментарии задач — для всех видимых карточек (доска + «Сегодня»).
  const visibleTaskIds = useMemo(() => {
    const cards = [...(data?.columns ?? []).flatMap(c => c.cards), ...(data?.today ?? []).flatMap(t => t.cards)];
    return [...new Set(cards.map(c => c.task?.id).filter((x): x is number => !!x))].sort((a, b) => a - b);
  }, [data]);
  const { data: notes } = useQuery<Record<string, TaskNote>>({
    queryKey: ['repeat-kanban-notes', visibleTaskIds.join(',')],
    enabled: visibleTaskIds.length > 0,
    queryFn: async () => {
      const out: Record<string, TaskNote> = {};
      // Порциями по 200 — длина адреса.
      for (let i = 0; i < visibleTaskIds.length; i += 200) {
        const r = await fetch(`/api/repeat-kanban/task-notes?ids=${visibleTaskIds.slice(i, i + 200).join(',')}`);
        if (r.ok) Object.assign(out, (await r.json()).notes ?? {});
      }
      return out;
    },
    staleTime: 60_000,
    placeholderData: prev => prev,
  });
  // Проверки звонков по сданным/принятым задачам — только тем, кто видит разборы (data.aiCounts есть только у них).
  const checkTaskIds = useMemo(() => {
    const cards = [...(data?.columns ?? []).flatMap(c => c.cards), ...(data?.today ?? []).flatMap(t => t.cards)];
    return [...new Set(cards.filter(c => c.task && (c.task.state === 'control' || c.task.state === 'done')).map(c => c.task!.id))].sort((a, b) => a - b);
  }, [data]);
  const { data: taskChecks } = useTaskChecks(checkTaskIds, !!data?.aiCounts);
  const todayTotal = (data?.today ?? []).reduce((s, t) => s + t.total, 0);
  const canManage = !!data?.canManage;
  const openCard = cardKey ? [...(data?.columns ?? []).flatMap(x => x.cards), ...(data?.today ?? []).flatMap(t => t.cards)]
    .find(x => x.clientKey === cardKey || x.members.some(m => m.key === cardKey)) ?? null : null;
  const viewerId = data?.viewerBitrixId ?? null;
  const toggleSel = (c: KanbanCard) => setSelected(m => { const n = new Map(m); if (n.has(c.clientKey)) n.delete(c.clientKey); else n.set(c.clientKey, c); return n; });
  const handlers: CardHandlers = {
    canManage, viewerId,
    select: selectMode ? { has: k => selected.has(k), toggle: toggleSel, addAll: cs => setSelected(m => { const n = new Map(m); for (const c of cs) if (canTaskCol(c.column)) n.set(c.clientKey, c); return n; }) } : null,
    onOpen: c => setOpenCard(c), onTask: setTaskFor, onReview: setReviewFor,
    onAct: async (a, c) => {
      if (a === 'hide') setHideFor(c);
      else if (a === 'request_hide') setHideReqFor(c);
      else if (a === 'brak_now') setBrakFor(c);
      else if (a === 'merge') setMergeFor(c);
      else if (a === 'tags') setTagsFor(c);
      else if (a === 'accept_task') setAcceptFor(c);
      else if (a === 'open_ai') setOpenCard(c, 'ai');
      else if (a === 'task_check') setCheckFor(c);
      else if (a === 'accept_hide' || a === 'decline_hide') {
        const ok = a === 'accept_hide'
          ? confirm(`Скрыть «${cardName(c)}» ${fmtHideUntil(c.hideRequest?.until ?? '')}, как предлагает менеджер?${c.deal && !LOST_STAGES.has(c.deal.stageId) && !WON_STAGES.has(c.deal.stageId) ? ` Сделка #${c.deal!.dealId} закроется в «Больше ничего не нужно».` : ''}`)
          : confirm(`Отклонить предложение скрыть «${cardName(c)}»? Заказчик останется в пуле.`);
        // Сделка открыта или в отказе — «Отложить до…» (26.10): открытая закроется, после даты — в пул, не на разбор.
        const hideDeal = c.deal && !WON_STAGES.has(c.deal.stageId) ? c.deal.dealId : undefined;
        if (ok) { await post({ action: 'decide_hide', accept: a === 'accept_hide', clientKey: c.clientKey, managerId: c.managerId, column: c.column, dealId: hideDeal }).catch(e => alert(e.message)); refresh(); }
      }
      else if (confirm(`Вернуть «${cardName(c)}» в пул раньше срока?`)) { await post({ action: 'unhide', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); }
    },
    canMerge: canManage && !!data?.mergeEnabled,
    onUnmerge: async (c, m) => {
      if (!confirm(`Разъединить: «${m.name ?? m.key}» снова станет отдельной карточкой. Продолжить?`)) return;
      await post({ action: 'unmerge', clientKey: c.clientKey, managerId: c.managerId, memberKey: m.key, column: c.column }).catch(e => alert(e.message));
      alert('Готово. Карточки разделятся при обновлении списка заказчиков — меньше минуты.');
      refresh();
    },
    onUnbrak: async c => { if (confirm(`Снять брак с «${cardName(c)}»? Заказчик вернётся в пул.`)) { await post({ action: 'unbrak', clientKey: c.clientKey, managerId: c.managerId, column: c.column }).catch(e => alert(e.message)); refresh(); } },
  };

  // Конвейер — горизонтальный (правка владельца 20.10). Края показывают, что доска
  // продолжается: затухание и стрелки только когда правда есть куда листать.
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, data]);
  const page = (dir: 1 | -1) => boardRef.current?.scrollBy({ left: dir * boardRef.current.clientWidth * 0.8, behavior: 'smooth' });

  if (error?.status === 403) return <AccessDenied reason="Канбан повторных продаж открыт ролям продаж." />;

  const typeChips = [
    { key: '', label: 'Все' },
    ...Object.keys(CLIENT_TYPE_ORDER).sort((a, b) => CLIENT_TYPE_ORDER[a] - CLIENT_TYPE_ORDER[b]).map(k => ({ key: k, label: CLIENT_TYPE_SHORT[k] })),
    { key: 'none', label: 'Тип не указан' },
  ];
  const totalAll = Object.values(data?.typeCounts ?? {}).reduce((s, n) => s + n, 0);
  const activeFilters = Number(!!type) + Number(taskF.length > 0) + Number(tagF.length > 0) + Number(!!aiF) + Number(offerGroups.length > 0) + Number(!!outcome) + Number(!!shf) + Number(shipsF.length > 0) + Number(poolGroups.length > 0 || ever) + Number(sort !== 'default');
  const resetFilters = () => { setType(''); setTaskF([]); setTagF([]); setAiF(''); setOfferF(''); setOutcome(''); setShf(''); setSht(''); setShipsF([]); setPg(''); setPgm('last'); setPgp('1y'); setPgf(''); setPgt(''); setSort('default'); setLimits({}); };
  const groupCounts = (ever ? data?.everGroupCounts : data?.poolGroupCounts) ?? {};
  const tagDefMap = new Map((data?.tagDefs ?? []).map(t => [t.id, t]));

  return (
    // Экран: шапка сверху, конвейер — на всю оставшуюся высоту, колонки скроллятся внутри
    // (как в канбане Битрикса). На телефоне страница скроллится целиком, доске — 75dvh.
    <div className="flex h-full min-w-0 flex-col overflow-y-auto overflow-x-hidden sm:overflow-hidden">
      <div className="flex min-w-0 shrink-0 flex-col gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Шапка в две строки (владелец 21.10: «сгруппировать все кнопки в одну строку, чтобы на
            небольших мониторах рабочей области хватало места»): заголовок + время, ниже — одна
            строка управления; редкие фильтры, тип клиента и переходы — в панели «Фильтры». */}
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold text-[var(--color-text)]"
            title="Карточки двигаются сами — по отгрузкам, стадиям сделки и звонкам. Стадии, звонки и задачи — живые, список заказчиков обновляется раз в 10 минут.">
            Канбан повторных продаж
          </h1>
          {data && (
            <span className="text-xs text-[var(--color-text-muted)]">
              обновлено {fmtDT(data.generatedAt)}{data.dataAt ? ` · заказчики на ${fmtDT(data.dataAt)}` : ''}
            </span>
          )}
        </header>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {data?.canManage && (
            <div className="flex min-w-0 gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Вид">
              <button type="button" role="tab" aria-selected={view !== 'today' && view !== 'queue'} onClick={() => setView('board')}
                className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm ${view !== 'today' && view !== 'queue' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>Доска</button>
              <button type="button" role="tab" aria-selected={view === 'today'} onClick={() => setView('today')}
                title="Что решить сегодня: приёмка задач, просрочки, разбор, окно закрывается"
                className={`inline-flex min-h-10 items-center gap-1 rounded-md px-3 text-sm ${view === 'today' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                Сегодня{data ? <span className={view === 'today' ? 'opacity-80' : 'text-[var(--color-text-muted)]'}>· {rub.format(todayTotal)}</span> : null}
              </button>
              <button type="button" role="tab" aria-selected={view === 'queue'} onClick={() => setView('queue')}
                title="Очередь задач: выдаются менеджерам по срочности, когда освобождается место"
                className={`inline-flex min-h-10 items-center rounded-md px-3 text-sm ${view === 'queue' ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>Очередь</button>
            </div>
          )}
          {/* Отделы и менеджеры работают вместе: отделы сужают список менеджеров, внутри
              можно отметить нескольких; не отмечен никто — все менеджеры отделов/зоны. */}
          <DepartmentPicker departmentIds={depts} onDepartmentIdsChange={ids => { changeDepts(ids); setMgrs([]); setLimits({}); }} triggerClassName={depts.length ? BTN_ACTIVE : BTN_IDLE} />
          {managerOptions.length > 0 && (
            <SearchMultiSelect ariaLabel="Менеджеры" allLabel={depts.length ? 'Все менеджеры отделов' : 'Все менеджеры зоны'}
              unitLabel="менеджеров" searchPlaceholder="Поиск менеджера"
              options={managerOptions.map(m => {
                const n = loadOf(m.id);
                return { value: m.id, label: m.name, hint: `${n} из ${taskLimit} активных задач${n >= taskLimit ? ' — перегружен' : ''}` };
              })}
              value={mgrs} onChange={v => { setMgrs(v); setLimits({}); }}
              className={`${mgrs.length ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs justify-start sm:w-40 min-[112.5rem]:w-56`} />
          )}
          <label className={`${q ? BTN_ACTIVE : BTN_IDLE} w-[60vw] max-w-xs cursor-text sm:w-40 min-[112.5rem]:w-56`}>
            <Search size={16} className="shrink-0 opacity-70" />
            <input type="search" value={qInput} onChange={e => setQInput(e.target.value)} placeholder="Заказчик, ID, группа, тег"
              aria-label="Поиск заказчика: имя, название, тег, товарная группа, номер контакта, компании, сделки или задачи"
              title="Имя, название, тег или товарная группа (все слова), либо номер: ID заказчика (контакт/компания), сделка, задача"
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-current placeholder:opacity-60 sm:text-sm" />
            {qInput && (
              <button type="button" onClick={() => { setQInput(''); setQ(''); setLimits({}); }} aria-label="Очистить поиск" className="tap-target shrink-0 opacity-70 hover:opacity-100"><X size={14} /></button>
            )}
          </label>
          <FiltersButton active={activeFilters} onReset={resetFilters}>
            <FilterField label="Тип клиента">
              <SearchSelect ariaLabel="Тип клиента" value={type} onChange={v => { setType(v); setLimits({}); }}
                options={typeChips.map(t => ({ value: t.key, label: `${t.label} · ${rub.format(t.key ? data?.typeCounts[t.key] ?? 0 : totalAll)}` }))}
                className={`${type ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            {/* Теги (владелец 22.10): любой из отмеченных; «Без тегов» — у кого нет ни одного видимого. */}
            {(data?.tagDefs?.length ?? 0) > 0 && (
              <FilterField label="Теги">
                <SearchMultiSelect ariaLabel="Теги" allLabel="Теги: любые" unitLabel="тегов" searchPlaceholder="Поиск тега"
                  options={[...(data?.tagDefs ?? []).map(t => ({ value: String(t.id), label: t.name, hint: `${rub.format(data?.tagCounts?.[t.id] ?? 0)} заказчиков · ${t.system ? 'базовый' : 'ваш'}` })),
                    { value: NO_TAG, label: 'Без тегов', hint: `${rub.format(data?.tagCounts?.[NO_TAG] ?? 0)} заказчиков` }]}
                  value={tagF} onChange={v => { setTagF(v); setLimits({}); }}
                  className={`${tagF.length ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
              </FilterField>
            )}
            {/* Разбор звонков (владелец 23.10): у кого есть, у кого появились новые звонки, у кого нет — кого разобрать. */}
            {data?.aiCounts && (
              <FilterField label="Разбор звонков">
                <SearchSelect ariaLabel="Разбор звонков" value={aiF} onChange={v => { setAiF(v); setLimits({}); }}
                  options={[
                    { value: '', label: 'Разбор звонков: любой' },
                    { value: 'yes', label: `Есть разбор · ${rub.format((data.aiCounts.yes ?? 0) + (data.aiCounts.new ?? 0))}` },
                    { value: 'new', label: `Есть, и после него новые звонки · ${rub.format(data.aiCounts.new ?? 0)}`, hint: 'можно запустить разбор заново' },
                    { value: 'no', label: `Нет разбора · ${rub.format(data.aiCounts.no ?? 0)}` },
                    // Владелец 23.10: «там, где много расшифрованных звонков, но не было ни одного ИИ-разбора».
                    // Владелец 26.10: менеджер нажал «Запросить разбор» в карточке клиента.
                    { value: 'requested', label: `Просят разбор · ${rub.format(data.aiCounts.requested ?? 0)}`, hint: 'менеджер запросил разбор, готового разбора после запроса нет' },
                    { value: 'candidate', label: `Кандидаты на разбор · ${rub.format(data.aiCounts.candidate ?? 0)}`, hint: `разбора нет, звонков с расшифровкой ${AI_CANDIDATE_MIN} и больше` },
                  ]}
                  className={`${aiF ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
              </FilterField>
            )}
            {/* Фильтр по задачам (владелец 20.10): РОП разбирает задачи прямо на канбане. */}
            <FilterField label="Задачи">
              <SearchMultiSelect ariaLabel="Задачи" allLabel="Задачи: все" unitLabel="состояния задач" searchPlaceholder="Поиск"
                options={TASK_FILTERS.map(f => ({ value: f.value, label: f.label, hint: `${rub.format(data?.taskCounts?.[f.value] ?? 0)} заказчиков · ${f.hint}` }))}
                value={taskF} onChange={v => { setTaskF(v); setLimits({}); }}
                className={`${taskF.length ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            {/* Последняя сделка (владелец 21.10): в приоритете — у кого предыдущая успешная. Пул. */}
            <FilterField label="Последняя сделка">
              <SearchSelect ariaLabel="Последняя сделка" value={outcome} onChange={v => { setOutcome(v); setLimits({}); }}
                options={OUTCOME_OPTIONS.map(o => ({ value: o.value, label: o.value ? `${o.label} · ${rub.format(data?.outcomeCounts?.[o.value] ?? 0)}` : o.label, hint: 'hint' in o ? `${o.hint} (в пуле)` : undefined }))}
                className={`${outcome ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            {/* Количество отгрузок заказчика (владелец 29.10): вся доска, любая из отмеченных корзин. */}
            <FilterField label="Количество отгрузок">
              <SearchMultiSelect ariaLabel="Количество отгрузок" allLabel="Отгрузок: сколько угодно" unitLabel="вариантов" searchPlaceholder="Поиск"
                options={SHIP_BUCKETS.map(b => ({ value: b.value, label: `${b.label} · ${rub.format(data?.shipCountCounts?.[b.value] ?? 0)}` }))}
                value={shipsF} onChange={v => { setShipsF(v); setLimits({}); }}
                className={`${shipsF.length ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            {/* Дата последней отгрузки (владелец 23.10: «пикер с пресетами, как в типовом отчёте»). */}
            <FilterField label="Последняя отгрузка">
              <ShipDateFilter from={shf} to={sht} onChange={(f, t) => { setShf(f); setSht(t); setLimits({}); }} />
            </FilterField>
            {/* Товарная группа (владелец 20.10 и 22.10): «отгружали газобетон, а после ничего» — группа
                ПОСЛЕДНЕЙ отгрузки, только пул; или «отгружали когда-либо за период» — на всю доску. */}
            <FilterField label="Товарная группа">
              <SearchSelect ariaLabel="Как искать товарную группу" value={pgm} onChange={v => { setPgm(v); setLimits({}); }}
                options={[
                  { value: 'last', label: 'Последняя отгрузка', hint: 'группа последней отгрузки — только пул' },
                  { value: 'ever', label: 'Отгружали когда-либо', hint: 'в любой отгрузке за период — вся доска' },
                ]}
                className={`${ever ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
              {ever && (
                <SearchSelect ariaLabel="Период отгрузок" value={pgp} onChange={v => { setPgp(v); setLimits({}); }}
                  options={GROUP_PERIODS.map(p => ({ value: p.value, label: `За период: ${p.label.toLowerCase()}` }))}
                  className={`${BTN_IDLE} w-full justify-start`} />
              )}
              {ever && pgp === 'custom' && (
                <div className="flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="w-6 shrink-0">с</span>
                    <input type="date" value={pgf} max={pgt || undefined} onChange={e => { setPgf(e.target.value); setLimits({}); }} className={`${fieldCls} min-h-11 min-w-0 flex-1`} />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    <span className="w-6 shrink-0">по</span>
                    <input type="date" value={pgt} min={pgf || undefined} onChange={e => { setPgt(e.target.value); setLimits({}); }} className={`${fieldCls} min-h-11 min-w-0 flex-1`} />
                  </label>
                </div>
              )}
              <SearchMultiSelect ariaLabel="Товарные группы" allLabel="Любая товарная группа"
                unitLabel="групп" searchPlaceholder="Поиск товарной группы"
                options={Object.entries(groupCounts).sort((x, y) => y[1] - x[1])
                  .map(([g, n]) => ({ value: g, label: g, hint: ever ? `${rub.format(n)} заказчиков отгружали за период` : `${rub.format(n)} в пуле — последняя отгрузка` }))
                  .concat(poolGroups.filter(g => !groupCounts[g]).map(g => ({ value: g, label: g, hint: ever ? 'за период не отгружали' : 'сейчас 0 в пуле' })))}
                value={poolGroups} onChange={v => { setPg(v.join('|')); setLimits({}); }}
                className={`${poolGroups.length ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            {/* «Что можно предложить» (владелец 23.10): топ-5 потенциальных групп заказчика, вся доска. */}
            <FilterField label="Что можно предложить">
              <SearchMultiSelect ariaLabel="Что можно предложить" allLabel="Любая потенциальная группа"
                unitLabel="групп" searchPlaceholder="Поиск товарной группы"
                options={Object.entries(data?.offerCounts ?? {}).sort((x, y) => y[1] - x[1])
                  .map(([g, n]) => ({ value: g, label: g, hint: `${rub.format(n)} заказчиков — в топ-5 «предложить»` }))
                  .concat(offerGroups.filter(g => !(data?.offerCounts ?? {})[g]).map(g => ({ value: g, label: g, hint: 'сейчас ни у кого в топ-5' })))}
                value={offerGroups} onChange={v => { setOfferF(v.join('|')); setLimits({}); }}
                className={`${offerGroups.length ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
            <FilterField label="Сортировка">
              <SearchSelect ariaLabel="Сортировка" value={sort} onChange={v => { setSort(v); setLimits({}); }}
                options={SORT_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                className={`${sort !== 'default' ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
            </FilterField>
          </FiltersButton>
          {canManage && view !== 'today' && view !== 'queue' && (
            <button type="button" onClick={() => { setSelectMode(v => !v); setSelected(new Map()); }}
              title="Выбрать карточки: отметить галочками и поставить задачи или отправить в брак всем разом" aria-label="Выбрать карточки"
              className={selectMode ? BTN_ACTIVE : BTN_IDLE}>
              <CheckSquare size={16} /> <span className={selectMode ? '' : 'sm:hidden min-[112.5rem]:inline'}>{selectMode ? 'Отменить выбор' : 'Выбрать'}</span>
            </button>
          )}
          {/* Справа — редкие кнопки; на ноутбуке только иконки (подписи — в подсказке). */}
          <div className="flex min-w-0 items-center gap-1.5 sm:ml-auto">
            <Link href="/repeat-kanban/guide" className={BTN_IDLE} title="Инструкция: как работать с канбаном" aria-label="Как работать?">
              <HelpCircle size={16} /> <span className="hidden min-[420px]:inline sm:hidden min-[112.5rem]:inline">Как работать?</span>
            </Link>
            {data?.canSeeAnalytics && (
              <Link href="/repeat-kanban/analytics" className={BTN_IDLE} title="Аналитика: кто что делал, проработанность по отделам, результат задач" aria-label="Аналитика">
                <BarChart3 size={16} /> <span className="hidden min-[112.5rem]:inline">Аналитика</span>
              </Link>
            )}
            {data?.canManageSettings && <RepeatKanbanSettingsButton className={BTN_IDLE} />}
            {data?.kpi && (
              <button type="button" onClick={() => setKpiHidden(!kpiHidden)} aria-pressed={kpiHidden}
                aria-label={kpiHidden ? 'Показать показатели' : 'Скрыть показатели'} title={kpiHidden ? 'Показать показатели' : 'Скрыть показатели — больше места под доску'}
                className={`${BTN_IDLE} min-w-11 px-0`}>
                {kpiHidden ? <ChevronsDown size={16} /> : <ChevronsUp size={16} />}
              </button>
            )}
            <button type="button" onClick={() => refetch()} aria-label="Обновить" title="Обновить"
              className={`${BTN_IDLE} min-w-11 px-0`}>
              <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {data?.kpi && !kpiHidden && <KpiStrip k={data.kpi} activeTask={taskF.length === 1 ? taskF[0] : null}
          onTask={tb => { const on = taskF.length === 1 && taskF[0] === tb; setTaskF(on ? [] : [tb]); setSort(on ? 'default' : 'task'); setLimits({}); }}
          onJump={jump} />}

        {error && error.status !== 403 && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-negative)]">{error.message}</div>}
        {data?.notice && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">{data.notice}</div>}
        {(isLoading || (isFetching && !data && !error)) && <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">Собираю доску — первый раз по команде это до полуминуты…</div>}

      </div>

      <TagDefsCtx.Provider value={tagDefMap}>
      <TaskChecksCtx.Provider value={taskChecks ?? {}}>
      <TaskNotesCtx.Provider value={notes ?? {}}>
      {view === 'queue' && data?.canManage ? (
        <QueueView onChanged={() => refetch()} />
      ) : view === 'today' && data?.canManage ? (
        <TodayView sections={data?.today ?? []} h={handlers} />
      ) : (
      <div className="relative min-h-[75dvh] min-w-0 flex-1 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
          <div ref={boardRef} onScroll={measure} className="scroll-x h-full">
            <div className="flex h-full items-stretch gap-5">
              {GROUPS.map(g => (
                <section key={g.key} data-group={g.key} className="flex h-full shrink-0 flex-col gap-2">
                  <div className="px-1">
                    <div className="text-sm font-semibold text-[var(--color-text)]">{g.title}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">{g.hint}</div>
                  </div>
                  <div className="flex min-h-0 flex-1 items-stretch gap-3">
                    {COLUMNS.filter(c => c.group === g.key).map(def => (
                      <Column key={def.key} def={def} col={byKey.get(def.key)} h={handlers}
                        onMore={() => setLimits(l => ({ ...l, [def.key]: (l[def.key] ?? PAGE) + PAGE }))} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
          {edges.left && (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 left-4 w-10 bg-gradient-to-r from-[var(--color-bg)] to-transparent sm:left-6" />
              <button type="button" onClick={() => page(-1)} aria-label="Листать влево"
                className={`${BTN_IDLE} absolute left-5 top-1/2 hidden min-w-11 -translate-y-1/2 px-0 shadow-md sm:inline-flex`}><ChevronLeft size={18} /></button>
            </>
          )}
          {edges.right && (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 right-4 w-10 bg-gradient-to-l from-[var(--color-bg)] to-transparent sm:right-6" />
              <button type="button" onClick={() => page(1)} aria-label="Листать вправо"
                className={`${BTN_IDLE} absolute right-5 top-1/2 hidden min-w-11 -translate-y-1/2 px-0 shadow-md sm:inline-flex`}><ChevronRight size={18} /></button>
            </>
          )}
        </div>
      )}
      </TaskNotesCtx.Provider>
      </TaskChecksCtx.Provider>
      </TagDefsCtx.Provider>

      {selectMode && selected.size > 0 && (
        <div className="sticky bottom-0 z-20 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2 sm:px-6">
          <span className="text-sm text-[var(--color-text)]">Выбрано {rub.format(selected.size)}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setSelected(new Map())} className={BTN_IDLE}>Снять выбор</button>
            {/* Массовый брак (владелец 28.10): тот же путь, что «Сразу в брак», по каждой отмеченной. */}
            <button type="button" onClick={() => setBulkBrakOpen(true)} className={`${BTN} border-[var(--color-negative)] text-[var(--color-negative)] hover:bg-[var(--color-bg-hover)]`}>В брак · {rub.format(selected.size)}</button>
            <button type="button" onClick={() => setBulkOpen(true)} className={BTN_ACTIVE}><Plus size={14} /> Поставить задачи · {rub.format(selected.size)}</button>
          </div>
        </div>
      )}
      {bulkBrakOpen && <BulkBrakModal cards={[...selected.values()]} onClose={() => setBulkBrakOpen(false)}
        onDone={() => { setSelected(new Map()); setSelectMode(false); refresh(); }} />}
      {bulkOpen && <BulkTaskModal cards={[...selected.values()]} loadOf={loadOf} limit={taskLimit} reassign={reassignOpts}
        onClose={() => setBulkOpen(false)} onDone={() => { setSelected(new Map()); setSelectMode(false); refresh(); }} />}
      {/^[ckx]\d{1,12}$/.test(cardKey) && (
        <CustomerCardLoader initialTab={(CARD_TABS as readonly string[]).includes(ctab) ? ctab as ClientCardTab : undefined}
          onTabChange={t => setCtab(t === 'overview' ? '' : t)}
          shareUrl={() => window.location.href}
          contactId={cardKey.startsWith('k') ? null : cardKey.slice(1)}
          companyId={cardKey.startsWith('k') ? cardKey.slice(1) : null}
          onClose={() => setOpenCard(null)}
          // Свежая версия карточки после действий (доска перезапросилась) — по ключу заказчика.
          // Комментарии задач — тот же контекст, что у доски (панель рисуется вне её дерева).
          // Карточки нет на доске (ссылка из чата, фильтры другие) — открывается только карточка клиента, без канбан-панели.
          sidePrimary={openCard ? <KanbanPrimary c={openCard} h={handlers} /> : undefined}
          sideActions={openCard ? <TagDefsCtx.Provider value={tagDefMap}><TaskChecksCtx.Provider value={taskChecks ?? {}}><TaskNotesCtx.Provider value={notes ?? {}}><KanbanSideActions c={openCard} h={handlers} /></TaskNotesCtx.Provider></TaskChecksCtx.Provider></TagDefsCtx.Provider> : undefined} />
      )}
      {taskFor && <TaskModal card={taskFor} load={loadOf(taskFor.managerId)} limit={taskLimit} reassign={reassignOpts} onClose={() => setTaskFor(null)} onSaved={refresh} />}
      {reviewFor && <ReviewModal card={reviewFor} onClose={() => setReviewFor(null)} onSaved={refresh} />}
      {hideFor && <HideModal card={hideFor} onClose={() => setHideFor(null)} onSaved={refresh} />}
      {hideReqFor && <HideModal card={hideReqFor} request onClose={() => setHideReqFor(null)} onSaved={refresh} />}
      {brakFor && <BrakNowModal card={brakFor} onClose={() => setBrakFor(null)} onSaved={refresh} />}
      {mergeFor && <MergeModal card={mergeFor} onClose={() => setMergeFor(null)} onSaved={refresh} />}
      {checkFor?.task && <TaskCheckModal taskId={checkFor.task.id} title={cardName(checkFor)} state={taskChecks?.[String(checkFor.task.id)]} onClose={() => setCheckFor(null)} />}
      {acceptFor?.task && <AcceptTaskModal card={acceptFor} name={cardName(acceptFor)} note={notes?.[String(acceptFor.task.id)] ?? null}
        checkState={data?.aiCounts ? taskChecks?.[String(acceptFor.task.id)] ?? { hasCall: false, check: null } : null}
        onClose={() => setAcceptFor(null)} onSaved={refresh} />}
      {tagsFor && <TagsModal title={cardName(tagsFor)} clientKey={tagsFor.clientKey} managerId={tagsFor.managerId} column={tagsFor.column}
        current={tagsFor.tags ?? []} defs={data?.tagDefs ?? []} onClose={() => setTagsFor(null)} onSaved={refresh} onDefsChanged={refresh} />}
    </div>
  );
}

/** Карточка канбана рядом с карточкой клиента (владелец 21.10: «давай её целиком тут магнитить»):
 *  та же карточка, что на доске, — со всеми данными, задачей, комментарием и кнопками. На телефоне
 *  (полоса под карточкой клиента) — с ограничением высоты и своей прокруткой. */
function KanbanSideActions({ c, h }: { c: KanbanCard; h: CardHandlers }) {
  const def = COLUMNS.find(x => x.key === c.column);
  return (
    <div className="flex max-h-[calc(100dvh-24px)] flex-col gap-1.5 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-2 shadow-2xl">
      <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-accent)]">Канбан повторных · {def?.title ?? c.column}</div>
      <CardFor c={c} h={h} />
    </div>
  );
}

/** Главное действие карточки канбана — в строке статуса шапки карточки клиента (аудит 23.10): то же, что
 *  главная кнопка на доске; остальное (меню, задача, комментарий) — по «Канбан ▾». */
function KanbanPrimary({ c, h }: { c: KanbanCard; h: CardHandlers }) {
  if (!h.canManage) return null;
  const btn = 'inline-flex min-h-9 items-center gap-1 rounded-md px-2.5 text-[12.5px] font-medium hover:opacity-90 active:scale-[0.98]';
  if (c.task?.state === 'control') return <button type="button" onClick={() => h.onAct('accept_task', c)} className={`${btn} bg-[#38761d] text-white`}><CheckSquare size={13} /> Принять задачу…</button>;
  if (c.column === 'review') return <button type="button" onClick={() => h.onReview(c)} className={`${btn} bg-[var(--color-accent)] text-white`}>{c.dozvonFail ? 'Разобрать: 3 попытки' : 'Разобрать отказ'}</button>;
  if (c.column === 'hidden') return <button type="button" onClick={() => h.onAct('unhide', c)} className={`${btn} border border-[var(--color-border)] text-[var(--color-text-secondary)]`}>Вернуть в пул</button>;
  if (c.column === 'brak') return <button type="button" onClick={() => h.onUnbrak(c)} className={`${btn} border border-[var(--color-border)] text-[var(--color-text-muted)]`}>Снять брак</button>;
  if (!canTaskCol(c.column)) return null;
  const label = c.deal ? 'Задача' : c.lastLost ? 'Вернуть сделку + задача' : 'Сделка + задача';
  return <button type="button" onClick={() => h.onTask(c)} className={`${btn} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}><Plus size={13} /> {label}</button>;
}

/** «Фильтры» — панель с редкими фильтрами (владелец 21.10: всё управление — в одну строку). */
function FiltersButton({ active, onReset, children }: { active: number; onReset: () => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} align="start" className="w-[340px] max-w-[calc(100vw-16px)] p-3"
      trigger={
        <button type="button" className={active ? BTN_ACTIVE : BTN_IDLE} aria-label="Фильтры" title="Фильтры: тип клиента, задачи, последняя сделка, товарная группа, сортировка">
          {/* Слово «Фильтры» — от 1800 px (владелец 22.10: на ноутбуке ~1700 px кнопки уезжали во второй ряд). */}
          <SlidersHorizontal size={16} /> <span className="hidden min-[112.5rem]:inline">Фильтры</span>{active ? <span>{` ${active}`}</span> : null}
        </button>
      }>
      <div className="flex max-h-[70dvh] flex-col gap-3 overflow-y-auto">
        {children}
        {active > 0 && (
          <button type="button" onClick={onReset} className="min-h-11 rounded-lg text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">Сбросить фильтры</button>
        )}
      </div>
    </Popover>
  );
}
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const ruShort = (s: string) => s.split('-').reverse().join('.').replace(/\.20(\d\d)$/, '.$1');
/** Диапазон даты последней отгрузки: тот же DateRangePicker с пресетами, что в отчётах; пусто — любая. */
function ShipDateFilter({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const [open, setOpen] = useState(false);
  const set = !!from && !!to;
  const value = set ? { from: parseISO(from), to: endOfDay(parseISO(to)) } : { from: startOfMonth(new Date()), to: endOfDay(new Date()) };
  return (
    <div className="flex min-w-0 items-stretch gap-1">
      <Popover open={open} onOpenChange={setOpen} className="p-2" trigger={
        <button type="button" className={`${set ? BTN_ACTIVE : BTN_IDLE} w-full min-w-0 justify-start`}>
          <CalendarDays size={14} className="shrink-0" />
          <span className="truncate">{set ? (from === to ? ruShort(from) : `${ruShort(from)} — ${ruShort(to)}`) : 'Последняя отгрузка: любая'}</span>
        </button>
      }>
        <DateRangePicker value={value} title="Дата последней отгрузки"
          onChange={r => { onChange(ymd(r.from), ymd(r.to)); setOpen(false); }} onClose={() => setOpen(false)} />
      </Popover>
      {set && (
        <button type="button" onClick={() => onChange('', '')} aria-label="Сбросить дату отгрузки" title="Сбросить"
          className="min-h-11 shrink-0 rounded-lg border border-[var(--color-border)] px-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-[var(--color-text-muted)]">{label}</span>
      {children}
    </div>
  );
}

/** Колонки, где у карточки есть кнопка задачи (и куда можно поставить массово). */
const canTaskCol = (col: ColumnKey) => col !== 'review' && col !== 'brak' && col !== 'st_sold' && col !== 'hidden';

interface CardHandlers {
  canManage: boolean; viewerId: string | null;
  /** Режим выбора карточек для массовой постановки задач. */
  select: { has: (clientKey: string) => boolean; toggle: (c: KanbanCard) => void; addAll: (cs: KanbanCard[]) => void } | null;
  onAct: (a: CardAction, c: KanbanCard) => void;
  /** Склейка заказчиков: РОП и старше, флаг customer_merge. */
  canMerge: boolean; onUnmerge: (c: KanbanCard, m: KanbanCard['members'][number]) => void;
  onOpen: (c: KanbanCard) => void; onTask: (c: KanbanCard) => void;
  onReview: (c: KanbanCard) => void; onUnbrak: (c: KanbanCard) => void;
}

function CardFor({ c, h }: { c: KanbanCard; h: CardHandlers }) {
  const sel = h.select && canTaskCol(c.column) ? h.select : null;
  return (
    <Card c={c} col={c.column} canManage={h.canManage} canMerge={h.canMerge} onUnmerge={m => h.onUnmerge(c, m)}
      selected={sel ? sel.has(c.clientKey) : null} onSelect={sel ? () => sel.toggle(c) : undefined}
      onOpen={() => h.onOpen(c)} onTask={() => h.onTask(c)} onReview={() => h.onReview(c)} onUnbrak={() => h.onUnbrak(c)}
      isOwn={!!h.viewerId && c.managerId === h.viewerId} onAct={a => h.onAct(a, c)} />
  );
}

/** «Сегодня» (аудит 21.10): одна лента того, что РОПу решить сегодня, вместо 20 тыс. карточек. */
function TodayView({ sections, h }: { sections: TodaySection[]; h: CardHandlers }) {
  // Горизонтально, как доска (владелец 21.10: «"Сегодня" стал вертикальным — сделай как доску»):
  // секция = колонка на всю высоту, карточки листаются внутри; пустые секции не показываем.
  const filled = sections.filter(s => s.total > 0);
  const TONE: Record<string, string> = { control: '#e69138', overdue: 'var(--color-negative)', hide_request: '#bf9000', wrong_funnel: 'var(--color-negative)', review: '#e69138', closing: 'var(--color-accent)' };
  return (
    <div className="relative min-h-[75dvh] min-w-0 flex-1 px-4 pb-4 pt-3 sm:min-h-0 sm:px-6">
      {filled.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-4 text-sm text-[var(--color-text-muted)]">На сегодня решать нечего — всё разобрано.</div>
      ) : (
        <div className="scroll-x h-full">
          <div className="flex h-full items-stretch gap-3">
            {filled.map(sec => (
              <section key={sec.key} className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
                <div className="rounded-lg px-2 py-1.5" style={{ borderLeft: `3px solid ${TONE[sec.key] ?? 'var(--color-accent)'}` }} title={sec.hint}>
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="text-sm font-semibold text-[var(--color-text)]">{sec.title}</h2>
                    <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{rub.format(sec.total)}</span>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{sec.hint}</div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                  {sec.cards.map(c => <CardFor key={`${sec.key}:${c.clientKey}`} c={c} h={h} />)}
                  {sec.total > sec.cards.length && (
                    <div className="px-2 py-2 text-xs text-[var(--color-text-muted)]">Показаны первые {sec.cards.length} из {rub.format(sec.total)} — остальные на доске через «Фильтры»</div>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Column({ def, col, h, onMore }: { def: ColumnDef; col: KanbanColumn | undefined; h: CardHandlers; onMore: () => void }) {
  const tone = def.key === 'brak' ? 'var(--color-negative)' : def.key === 'review' ? '#e69138' : def.key === 'touch_3' ? '#6aa84f' : 'var(--color-accent)';
  // В воронке итог — сумма сделок (реальные деньги), в пуле и попытках — потенциал (ожидание).
  const moneyLine = def.group === 'stage' ? (col && col.sum > 0 ? `сделки ${money(col.sum)}` : null)
    : col && col.potential > 0 ? `потенциал ${moneyShort(col.potential)}` : null;
  return (
    <div className="flex h-full w-80 max-w-[85vw] shrink-0 flex-col gap-2 rounded-xl bg-[var(--color-bg-surface)] p-2">
      <div className="rounded-lg px-2 py-1.5" style={{ borderLeft: `3px solid ${tone}` }} title={def.hint}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-[var(--color-text)]">{def.title}</span>
          <span className="text-sm tabular-nums text-[var(--color-text-muted)]">{col ? rub.format(col.total) : '…'}</span>
        </div>
        {moneyLine && <div className="text-xs text-[var(--color-text-muted)]" title={def.group === 'stage' ? 'Сумма открытых сделок колонки' : 'Сумма потенциалов (12 мес.) всех заказчиков колонки — как считается, видно по наведению на потенциал карточки'}>{moneyLine}</div>}
        {h.select && canTaskCol(def.key) && col && col.cards.length > 0 && (
          <button type="button" onClick={() => h.select!.addAll(col.cards)} className="mt-1 min-h-8 text-xs text-[var(--color-accent)] hover:underline">
            Выбрать показанные · {rub.format(col.cards.length)}
          </button>
        )}
      </div>
      {/* Карточки скроллятся внутри колонки — колонка на всю высоту экрана. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {col?.cards.map(c => <CardFor key={c.clientKey} c={c} h={h} />)}
        {col && col.total > col.cards.length && (
          <button type="button" onClick={onMore}
            className="min-h-11 shrink-0 rounded-lg text-sm text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)]">
            Показать ещё · осталось {rub.format(col.total - col.cards.length)}
          </button>
        )}
        {col && col.total === 0 && <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">Пусто</div>}
      </div>
      {/* «Итого» под колонкой (владелец 20.10): одна строка в одном порядке у всех колонок. */}
      {col && col.total > 0 && (
        <div className="shrink-0 rounded-lg border-t border-[var(--color-border)] px-2 pt-1.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
          <span className="font-semibold text-[var(--color-text)]">Итого {rub.format(col.total)}</span>
          {moneyLine && <> · {moneyLine}</>}
          {col.avgAgeDays !== null && <> · ср. {col.avgAgeDays} дн.</>}
          {col.overdue > 0 && <> · <span className="text-[var(--color-negative)]">просрочено {col.overdue}</span></>}
          {col.noTask > 0 && <> · без задачи {col.noTask}</>}
          {col.sleeping > 0 && <> · спит {col.sleeping}</>}
        </div>
      )}
    </div>
  );
}

/** Показатели канбана для РОПа — снимок текущей доски (аудит Fable 20.10). Исторические
 *  (скорость взятия из пула, конверсия пул → продано за 90 дн.) — в BACKLOG. */
/** Проработанность (владелец 21.10). Проработан = РОП поставил задачу в проекте «Повторные
 *  продажи» (сделки роботов/менеджеров без задачи не в счёт — первая версия давала 78 % «ни за
 *  что»). Знаменатель — они плюс заказчики с открытым окном без сделки: каждая поставленная задача
 *  двигает кольцо; 100 % — ни один «горячий» заказчик не висит без задачи. */
function WorkedRing({ k }: { k: BoardKpi }) {
  const worked = k.workedByTask;
  const total = worked + k.hot;
  const share = total ? worked / total : 0;
  const r = 14, c = 2 * Math.PI * r;
  return (
    <span className="inline-flex shrink-0 items-center"
      title={`Проработано ${rub.format(worked)} из ${rub.format(total)}: по ${worked} заказчикам поставлена задача (в дозвоне, воронке или на разборе), у ${k.hot} окно открыто, а сделки и задачи нет. Сделки без задачи (${k.noTaskInWork}) не в счёт. 100% — ни один заказчик с открытым окном не висит без задачи.`}>
      <svg width="36" height="36" viewBox="0 0 36 36" aria-label={`Проработано ${Math.round(share * 100)}%`}>
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="4" />
        <circle cx="18" cy="18" r={r} fill="none" stroke="#ffffff" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 18 18)" />
        <text x="18" y="21.5" textAnchor="middle" fill="#ffffff" fontSize="9.5" fontWeight="700">{Math.round(share * 100)}%</text>
      </svg>
    </span>
  );
}

function KpiStrip({ k, activeTask, onTask, onJump }: {
  k: BoardKpi; activeTask: string | null;
  /** Клик по плитке задач — фильтр этого состояния + сортировка «по задачам» (владелец 20.10). */
  onTask: (tb: 'control' | 'none' | 'overdue') => void;
  /** Клик по плитке группы — перемотка доски к ней. */
  onJump: (g: ColumnGroup) => void;
}) {
  // Одна плитка — одна цифра крупно + подпись мелко (владелец 20.10: «показатели с
  // диапазонами — хуета»: «414 · 36,8 млн» читалось как диапазон).
  const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const tiles: { label: string; value: string; sub?: string; hint: string; tone?: 'neg' | 'warn'; task?: 'control' | 'none' | 'overdue'; jump?: ColumnGroup }[] = [
    { label: 'В пуле', jump: 'pool', value: rub.format(k.pool), sub: 'заказчиков', hint: 'Без открытой повторной сделки — кого можно брать в работу' },
    { label: 'В дозвоне', jump: 'touch', value: rub.format(k.inWork), sub: `на ${moneyShort(k.inWorkPotential)}`, hint: 'Взяты в работу и в попытках связаться' },
    { label: 'Дозвон', jump: 'touch', value: pctOf(k.reached, k.inWork), sub: `${rub.format(k.reached)} из ${rub.format(k.inWork)}`, hint: 'Среди тех, кто в дозвоне: был разговор дольше 20 с или ручной контакт' },
    { label: 'В воронке', jump: 'stage', value: rub.format(k.funnel), sub: `на ${moneyShort(k.funnelSum)}`, hint: 'Повторные сделки в работе и их сумма' },
    { label: 'Просрочено', task: 'overdue', value: rub.format(k.tasksOverdue), sub: 'задач', hint: 'Открытые задачи проекта «Повторные продажи» с прошедшим сроком', tone: k.tasksOverdue ? 'neg' : undefined },
    { label: 'Ждут приёмки', task: 'control', value: rub.format(k.tasksControl), sub: 'задач', hint: 'Менеджер сдал задачу, постановщик не принял', tone: k.tasksControl ? 'warn' : undefined },
    { label: 'Без задачи', task: 'none', value: rub.format(k.noTaskInWork), sub: 'сделок', hint: 'В дозвоне и воронке, по которым нет открытой задачи', tone: k.noTaskInWork ? 'warn' : undefined },
    { label: 'Отказы', jump: 'review', value: rub.format(k.review), sub: k.reviewEarly ? `${k.reviewEarly} рано закрыты` : 'на проверке', hint: 'Ждут решения РОПа; «до 3 попыток» — закрыты, не дозвонившись и не сделав трёх попыток', tone: k.reviewEarly ? 'neg' : undefined },
  ];
  // Компактно (владелец 22.10: «на экране ноута потенциал и прочие показатели занимают слишком дохуя
  // места», «в 1 строчку без лишних подписей, допинфа по наведению»): синяя плитка — одна строка,
  // плитки — подпись и цифра, пояснение — в title; от 1440 px всё в один ряд ~48 px (было ~190).
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-stretch">
      {/* Главная цифра — сколько денег лежит в пуле, если вернуть заказчиков. */}
      {/* Одна строка (владелец 22.10: «потенциал и кольцо в 1 строчку без лишних подписей, допинфа по
          наведению»): «в пуле» и «под риском» — в подсказке; клик — к пулу. Потенциал ВСЕЙ базы, кроме
          брака, — не тает от работы (владелец 20.10). */}
      <button type="button" onClick={() => onJump('pool')}
        title={`Потенциал за год, если работать с повторкой: ${moneyShort(k.totalPotential)} — сумма потенциалов всех заказчиков, кроме брака (средняя годовая выручка вернувшихся таких же заказчиков).\nВ пуле, не тронуто: ${moneyShort(k.poolPotential)}.\nПод риском: ${moneyShort(k.hotPotential)} — у ${rub.format(k.hot)} заказчиков открыто окно повторной продажи (отгрузка ≤ 22 дней назад, сделки нет), у ${rub.format(k.hotClosing)} закрывается в ближайшие 3 дня.\nНажмите — перейти к пулу.`}
        className="brand-chevrons flex min-h-11 shrink-0 items-center justify-between gap-2 rounded-xl bg-[var(--color-accent)] px-3 py-1 text-left text-white hover:opacity-95 lg:w-[250px]">
        <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
          <span className="text-[12px] opacity-85">Потенциал</span>
          <span className="text-[19px] font-bold tabular-nums">{moneyShort(k.totalPotential)}</span>
        </span>
        <WorkedRing k={k} />
      </button>
      {/* Восемь в ряд — от 1440 px; уже — два ряда по четыре (на 1280 плитка выходила бы ~72 px). */}
      <div className="grid min-w-0 flex-1 auto-rows-fr grid-cols-2 gap-1.5 sm:grid-cols-4 min-[90rem]:grid-cols-8">
        {tiles.map(t => (
          // Жёсткая сетка из трёх строк — цифры всех плиток на одной линии (правка 20.10: «все цифры
          // прыгают»). Подпись и пояснение — в одну строку с многоточием, полный текст в title.
          <button type="button" key={t.label} title={`${t.label}: ${t.hint}${t.sub ? `\n${t.sub}` : ''}\n${t.task ? (activeTask === t.task ? 'Нажмите, чтобы снять фильтр' : 'Нажмите — показать только их') : 'Нажмите — перейти к колонкам'}`}
            onClick={() => (t.task ? onTask(t.task) : t.jump && onJump(t.jump))}
            className={`grid min-w-0 grid-rows-[14px_22px] content-center items-center justify-items-center rounded-xl border px-1.5 py-1 text-center transition-colors hover:bg-[var(--color-bg-hover)] ${t.task && activeTask === t.task ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] bg-[var(--color-bg-surface)]'}`}>
            <div className="w-full truncate text-[11px] font-medium leading-[14px] text-[var(--color-text-muted)]">{t.label}</div>
            <div className="text-[18px] font-bold leading-[22px] tabular-nums" style={t.tone === 'neg' ? { color: 'var(--color-negative)' } : t.tone === 'warn' ? { color: '#b45f06' } : undefined}>{t.value}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// Неразрывные пробелы: «127 тыс. ₽» не рвётся по строкам (правка владельца 20.10).
// От миллиарда — «млрд» (владелец 21.10: «5057,1 млн» → «5,1 млрд»).
const moneyShort = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1).replace('.', ',')}\u00a0млрд\u00a0₽` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')}\u00a0млн\u00a0₽` : n >= 1000 ? `${Math.round(n / 1000)}\u00a0тыс.\u00a0₽` : `${rub.format(n)}\u00a0₽`);

const TASK_STATE: Record<RepeatTask['state'], { label: string; bg: string; fg: string }> = {
  unread: { label: 'не просмотрена', bg: '#f4cccc', fg: '#990000' },
  pending: { label: 'не начата', bg: '#efefef', fg: '#434343' },
  in_progress: { label: 'в работе', bg: '#cfe2f3', fg: '#0b5394' },
  control: { label: 'ждёт контроля', bg: '#fce5cd', fg: '#b45f06' },
  done: { label: 'принята', bg: '#d9ead3', fg: '#38761d' },
  deferred: { label: 'отложена', bg: '#efefef', fg: '#666666' },
};

const BUCKET_LABEL: Record<string, string> = { '1': '1 покупкой', '2': '2 покупками', '3': '3 покупками', '4-5': '4–5 покупками', '6+': '6 и более покупками' };

/** Потенциал с объяснением (владелец 20.10: «наводя на потенциал — понятно, как считается»).
 *  На компьютере — по наведению, на телефоне — по нажатию (Popover, не голый title). */
function PotentialBadge({ c }: { c: KanbanCard }) {
  const [open, setOpen] = useState(false);
  const p = c.potentialInfo!;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <Popover open={open} onOpenChange={setOpen} side="top" align="start" className="w-[320px] max-w-[calc(100vw-16px)] p-3 text-[12.5px] leading-snug"
      trigger={
        // Клик только ОТКРЫВАЕТ (preventDefault глушит переключатель Radix): иначе наведение
        // открывало, а клик тут же закрывал. Закрытие — уход мыши, клик мимо, Esc.
        <button type="button" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          onClick={e => { e.preventDefault(); setOpen(true); }}
          className="font-semibold text-[var(--color-text)] underline decoration-dotted underline-offset-2">
          потенциал {moneyShort(p.value)}
        </button>
      }>
      <div className="flex flex-col gap-1.5 text-[var(--color-text)]">
        <div className="text-[15px] font-bold">Потенциал ≈ {money(p.value)} за год</div>
        <div className="text-[var(--color-text-secondary)]">
          Столько в среднем приносят за год заказчики с {BUCKET_LABEL[p.bucket] ?? `${p.bucket} покупками`} ({p.b2b ? 'юрлица' : 'физлица'}), <b>когда возвращаются</b>. Посчитано по всей истории продаж — {rub.format(p.n)} таких заказчиков.
        </div>
        <div className="rounded-md bg-[var(--color-accent-soft)] px-2 py-1.5 text-[var(--color-accent)]">
          Сейчас возвращается {pct(p.conv)} — каждый возвращённый сверх этого даёт +{moneyShort(p.value)} выручки за год.
        </div>
        <div className="text-[11.5px] text-[var(--color-text-muted)]">
          Покупки склеены по правилу повторной продажи, крупные выбросы срезаны по 95-му перцентилю.
        </div>
      </div>
    </Popover>
  );
}

function TypeChip({ type }: { type: string | null }) {
  const key = type ?? 'none';
  const st = CLIENT_TYPE_STYLE[key] ?? CLIENT_TYPE_STYLE.none;
  return (
    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
      style={{ background: st.bg, color: st.fg, border: `1px ${st.dashed ? 'dashed' : 'solid'} ${st.border}` }}
      title={type ? undefined : 'Тип клиента не указан — заполните в карточке клиента'}>
      {type ? CLIENT_TYPE_SHORT[type] ?? type : 'Тип?'}
    </span>
  );
}

/** Тревоги карточки — одна зона, максимум два чипа (аудит Fable 20.10). С 23.10 (Fable, «наведите красоту и порядок»)
 *  здесь только то, что требует действия и не видно в других зонах: просрочка и приёмка — в блоке задачи, окно — в строке
 *  отгрузки, «спит» — иконкой, «сделка без задачи» — самой кнопкой «+ Задача» (стояла на 80 % карточек — шум). */
function alertsOf(c: KanbanCard, col: ColumnKey): { text: string; red: boolean }[] {
  const a: { text: string; red: boolean }[] = [];
  const t = c.task;
  if (col === 'review' && c.lostEarly) a.push({ text: `Отказ после ${c.attempts?.count ?? 0} из ${TOUCHES} попыток`, red: true });
  if (col === 'review' && c.dozvonFail) a.push({ text: `${TOUCHES} попытки без дозвона`, red: true });
  if (c.returned) a.unshift({ text: `Вернулся сам: ${c.returned.missed ? 'пропущенный' : 'звонил'} ${fmtDT(c.returned.at)} — перезвоните`, red: true });
  if (c.openDealInBrak) a.unshift({ text: `Сделка #${c.openDealInBrak} открыта в Битриксе — закройте`, red: true });
  if (c.wrongFunnel) a.unshift({ text: `Сделка в «${c.wrongFunnel.funnelName ?? 'первичной'}» — не в повторной`, red: true });
  if (col === 'touch_3' && !c.attempts?.reached) a.push({ text: '3 попытки без дозвона', red: true });
  if (t?.state === 'unread') a.push({ text: 'Задача не просмотрена', red: true });
  const callAfter = t && c.calls.some(x => !x.missed && x.sec > 20 && x.at > t.createdAt);
  if (t && (t.state === 'control' || t.state === 'done') && !callAfter) a.push({ text: 'Выполнено без звонка', red: true });
  if (c.attempts?.reached && col.startsWith('touch')) a.push({ text: 'Дозвонились — переведите стадию', red: false });
  return a;
}

/** «433 дн.» → «1 г. 2 мес.» (Fable 23.10: в «Золотых рыбках» трёхзначные дни — шум). */
const ageLabel = (d: number) => (d > 365 ? `${Math.floor(d / 365)} г.${Math.floor((d % 365) / 30.4) ? ` ${Math.floor((d % 365) / 30.4)} мес.` : ''}` : `${d} дн.`);

type CardAction = 'hide' | 'request_hide' | 'accept_hide' | 'decline_hide' | 'brak_now' | 'unhide' | 'merge' | 'tags' | 'accept_task' | 'open_ai' | 'task_check' | 'new_task';

/** Редкие действия карточки — в меню «⋯» (владелец 20.10: «глупо, когда висят прямо на лице»). */
function CardMenu({ items, onAct }: { items: { label: string; act: CardAction; danger?: boolean }[]; onAct: (a: CardAction) => void }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return (
    <Popover open={open} onOpenChange={setOpen} align="end" className="w-48 p-1"
      trigger={
        <button type="button" aria-label="Ещё действия" title="Ещё действия"
          className={`hover-reveal tap-target inline-flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text)] data-[state=open]:opacity-100 ${FOCUS}`}>
          <MoreHorizontal size={16} />
        </button>
      }>
      {items.map(i => (
        <button key={i.act} type="button" onClick={() => { setOpen(false); onAct(i.act); }}
          className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm hover:bg-[var(--color-bg-hover)] ${i.danger ? 'text-[#990000]' : 'text-[var(--color-text)]'}`}>
          {i.label}
        </button>
      ))}
    </Popover>
  );
}

/** Теги на карточке (миграция 245) — плашки в цветах тегов, перенос строкой. */
function CardTags({ ids }: { ids: number[] }) {
  const defs = useContext(TagDefsCtx);
  const tags = ids.map(id => defs.get(id)).filter((t): t is TagDef => !!t);
  if (!tags.length) return null;
  return <div className="flex min-w-0 flex-wrap gap-1">{tags.map(t => <TagChip key={t.id} tag={t} />)}</div>;
}

/** Значок разбора звонков (владелец 23.10): Монолитик, как на вкладке браузера; бледный — разбору больше
 *  14 дней; красный кружок — расшифрованные звонки после разбора (есть что доразобрать). Клик — карточка
 *  клиента сразу на вкладке «ИИ-анализ». Видят только РОПы (право ИИ-анализа). */
/** Запрос менеджера (26.10): синий «?» в углу значка + строка в подсказке. */
const requestTitle = (r: NonNullable<KanbanCard['aiRequest']>) => `\nЗапросил разбор: ${r.by}, ${fmtDay(r.at)}${r.comment ? ` — «${r.comment}»` : ''}`;
function RequestDot() {
  return <span className="absolute -bottom-1.5 -right-1.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-[#1155cc] px-[3px] text-[9.5px] font-bold leading-none text-white ring-2 ring-[var(--color-bg)]">?</span>;
}

function AiBadge({ ai, request, onClick }: { ai: NonNullable<KanbanCard['ai']>; request: KanbanCard['aiRequest'] | null; onClick: () => void }) {
  const title = `Разбор звонков от ${fmtDay(ai.at)}${ai.fresh ? '' : ' — старше 14 дней, памятка в задачу уже не подставится'}`
    + (ai.newCalls ? `\nПосле него ${ai.newCalls} ${plural(ai.newCalls, 'новый звонок', 'новых звонка', 'новых звонков')} с расшифровкой — можно запустить разбор заново` : '')
    + (request ? requestTitle(request) : '')
    + '\nНажмите — открыть разбор';
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className={`${FOCUS} tap-target relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:scale-110`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- фавикон 32px, оптимизация не нужна */}
      <img src="/icon.png" alt="" width={18} height={18} className={`h-[18px] w-[18px] rounded-[4px] ${ai.fresh ? '' : 'opacity-45 grayscale'}`} />
      {ai.newCalls > 0 && (
        <span className="absolute -right-1.5 -top-1.5 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-[#cc0000] px-[3px] text-[9.5px] font-bold leading-none text-white ring-2 ring-[var(--color-bg)]">
          {ai.newCalls > 99 ? '99+' : ai.newCalls}
        </span>
      )}
      {request && <RequestDot />}
    </button>
  );
}

/** Кандидат на разбор: разбора нет, а звонков с расшифровкой много — бледный Монолитик с пунктиром и числом звонков. */
function AiCandidate({ calls, request, onClick }: { calls: number; request: KanbanCard['aiRequest'] | null; onClick: () => void }) {
  const title = `Разбора звонков ещё не было${calls ? `, а звонков с расшифровкой — ${calls}. Кандидат на ИИ-разбор.` : '.'}${request ? requestTitle(request) : ''}\nНажмите — открыть вкладку «ИИ-анализ»`;
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className={`${FOCUS} tap-target relative inline-flex h-5 shrink-0 items-center gap-0.5 rounded border border-dashed pl-0.5 pr-1 text-[10px] font-semibold tabular-nums transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${request ? 'border-[#1155cc] text-[#1155cc]' : 'border-[var(--color-border-strong)] text-[var(--color-text-muted)]'}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- фавикон 32px */}
      <img src="/icon.png" alt="" width={14} height={14} className={`h-[14px] w-[14px] rounded-[3px] ${request ? '' : 'opacity-45 grayscale'}`} />
      {calls ? (calls > 99 ? '99+' : calls) : ''}
      {request && <RequestDot />}
    </button>
  );
}

const OFFER_SOURCE: Record<string, string> = { request: 'просил сам', priority: 'приоритет «Что предложить»', chain: 'по ходу стройки', history: 'статистика: следующей покупкой' };
/** «Предложить: Окна и двери · Кровля +3» — топ-5 потенциальных групп, полный список с источником — по наведению/тапу. */
function OfferLine({ offer }: { offer: NonNullable<KanbanCard['offer']> }) {
  const text = offer.map((o, i) => `${i + 1}. ${o.group} — ${OFFER_SOURCE[o.source] ?? o.source}${o.after ? ` (после «${o.after}»)` : ''}`).join('\n');
  return (
    <div className="flex min-w-0 items-baseline gap-1 text-[11.5px]">
      <span className="shrink-0 text-[var(--color-text-muted)]">Предложить:</span>
      <TapTip label="Что можно предложить" text={text}>
        <span className="min-w-0 truncate text-left font-medium text-[var(--color-text)] decoration-dotted underline-offset-2 hover:underline">
          {offer.slice(0, 2).map(o => o.group).join(' · ')}
        </span>
        {offer.length > 2 && <span className="shrink-0 text-[var(--color-text-muted)]">+{offer.length - 2}</span>}
      </TapTip>
    </div>
  );
}

/** Пометка «есть звонок — проверить» / итог проверки (владелец 23.10: «есть уведомление»). Только РОПу. */
function TaskCheckChip({ taskId, onOpen }: { taskId: number; onOpen: () => void }) {
  const st = useContext(TaskChecksCtx)[String(taskId)];
  if (!st || (!st.hasCall && !st.check)) return null;
  const v = st.check?.status === 'done' && st.check.verdict ? VERDICT[st.check.verdict] : null;
  const pending = st.check && (st.check.status === 'queued' || st.check.status === 'running');
  return (
    <button type="button" onClick={onOpen}
      title={v ? 'Звонок проверен на соответствие задаче — нажмите, чтобы посмотреть' : 'После задачи был звонок с расшифровкой — проверьте, выполнил ли менеджер задачу'}
      className={`${FOCUS} inline-flex min-h-7 items-center gap-1 self-start rounded px-1.5 text-[11px] font-semibold transition hover:opacity-85 active:scale-[0.98]`}
      style={v ? { background: v.bg, color: v.fg } : { background: '#fce5cd', color: '#b45f06' }}>
      <PhoneCall size={11} />
      {v ? `Звонок: ${v.label}` : pending ? 'Звонок проверяется…' : (<><span className="relative mr-0.5 inline-flex h-1.5 w-1.5 rounded-full bg-[#cc0000]" />Есть звонок — проверить</>)}
    </button>
  );
}

/** Подсказка, которая работает и на таче (владелец 23.10: hover-only title на телефоне не увидеть):
 *  на компьютере — по наведению, на телефоне — по нажатию (как «потенциал»). */
function TapTip({ label, text, children }: { label: string; text: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} side="top" align="start" className="w-max max-w-[min(280px,calc(100vw-16px))] whitespace-pre-line p-2 text-[12px] leading-snug text-[var(--color-text)]"
      trigger={
        <button type="button" aria-label={label} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
          onClick={e => { e.preventDefault(); setOpen(true); }}
          className={`${FOCUS} inline-flex min-w-0 max-w-full cursor-help items-center gap-1`}>
          {children}
        </button>
      }>
      {text}
    </Popover>
  );
}

/** Последний комментарий по задаче — внутри блока задачи: 3 строки, длинный — «Показать целиком». */
function NoteBlock({ note }: { note: TaskNote }) {
  const [full, setFull] = useState(false);
  const long = note.text.length > 140 || note.text.split('\n').length > 3;
  return (
    <div className="border-l-2 border-[var(--color-accent)] pl-2 text-[11.5px] leading-snug">
      <div className="text-[var(--color-text-muted)]">{note.isResult ? 'Результат · ' : ''}{shortName(note.author)} · {fmtDT(note.at)}</div>
      <div className={`${full ? '' : 'line-clamp-3'} whitespace-pre-line text-[var(--color-text)]`}>{note.text}</div>
      {long && (
        <button type="button" onClick={() => setFull(v => !v)} className={`${FOCUS} mt-0.5 text-[11px] text-[var(--color-accent)] hover:underline`}>
          {full ? 'Свернуть' : 'Показать целиком'}
        </button>
      )}
    </div>
  );
}

function Card({ c, col, canManage, canMerge, onUnmerge, isOwn, selected, onSelect, onOpen, onTask, onReview, onUnbrak, onAct }: {
  c: KanbanCard; col: ColumnKey; canManage: boolean;
  canMerge: boolean; onUnmerge: (m: KanbanCard['members'][number]) => void;
  /** null — не в режиме выбора (или карточку нельзя выбрать). */
  selected: boolean | null; onSelect?: () => void;
  /** Заказчик смотрящего менеджера: «Скрыть» — только РОП, менеджер ПРЕДЛАГАЕТ (владелец 21.10). */
  isOwn: boolean;
  onAct: (a: CardAction) => void;
  onOpen: () => void; onTask: () => void; onReview: () => void; onUnbrak: () => void;
}) {
  // Раскладка по зонам — спецификация Fable 23.10 (владелец: «наведите красоту и порядок»): шапка → признаки → факты
  // → сделка → контакт → задача → тревоги → ОДНА кнопка. Повторы и сигналы «есть у всех» убраны.
  const isPool = col.startsWith('pool') || col === 'brak' || col === 'hidden';
  const isStage = col.startsWith('st_');
  const good = c.calls.filter(x => !x.missed && x.sec > 20);
  const alerts = alertsOf(c, col);
  const shownAlerts = alerts.slice(0, 2);
  const old = c.lastDeliveredAt ? daysAgo(c.lastDeliveredAt) : null;
  const t = c.task;
  const openTask = !!t && t.state !== 'done' && t.state !== 'deferred';
  const dealLabel = c.deal ? 'Задача' : c.lastLost ? 'Вернуть сделку + задача' : 'Сделка + задача';
  const note = useContext(TaskNotesCtx)[String(t?.id ?? '')];
  const now = Date.now();
  const taskLate = openTask && t!.state !== 'control' && t!.deadlineAt && new Date(t!.deadlineAt).getTime() < now;
  // Полоса слева (Fable): красная тревога — красная, задача ждёт приёмки — жёлтая; иначе прозрачная (ширина не прыгает).
  const stripe = alerts.some(a => a.red) || taskLate ? 'border-l-[var(--color-negative)]' : t?.state === 'control' ? 'border-l-[var(--color-warning)]' : 'border-l-transparent';
  const windowLeft = col === 'pool_hot' && c.freshDays !== null ? Math.max(0, 22 - c.freshDays) : null;
  const act = (a: CardAction) => (a === 'new_task' ? onTask() : onAct(a));

  return (
    <article className={`group relative flex shrink-0 flex-col gap-1.5 rounded-lg border border-l-[3px] bg-[var(--color-bg)] p-3 text-[12px] leading-snug tabular-nums transition-[border-color,box-shadow] ${stripe} ${selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] ring-2 ring-[var(--color-accent)]' : 'border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:shadow-sm'}`}>
      {/* A. Шапка: имя · значок разбора · тип · спит · меню; менеджер и номер заказчика. */}
      <div>
        <div className="flex items-start gap-2">
          {selected !== null && (
            <label className="tap-target -ml-0.5 mt-0.5 inline-flex shrink-0 cursor-pointer items-center" aria-label="Выбрать заказчика">
              <input type="checkbox" checked={selected} onChange={onSelect} className="h-4 w-4 accent-[var(--color-accent)]" />
            </label>
          )}
          <button type="button" onClick={onOpen} title="Открыть карточку клиента"
            className={`${FOCUS} min-w-0 flex-1 text-left text-[13.5px] font-semibold leading-tight text-[var(--color-text)] decoration-dotted underline-offset-2 hover:text-[var(--color-accent)] hover:underline`}>
            <span className="line-clamp-2">{cardName(c)}</span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {c.ai && <AiBadge ai={c.ai} request={c.aiRequest ?? null} onClick={() => onAct('open_ai')} />}
            {!c.ai && (c.aiRequest || (c.aiCalls ?? 0) >= AI_CANDIDATE_MIN) && <AiCandidate calls={c.aiCalls ?? 0} request={c.aiRequest ?? null} onClick={() => onAct('open_ai')} />}
            {c.sleeping && col.startsWith('pool') && <TapTip label="Спит" text="Спит: давно нет движений по заказчику"><Moon size={12} className="text-[var(--color-text-muted)]" /></TapTip>}
            {c.profileType ? <TypeChip type={c.profileType} /> : (
              <span className="shrink-0 rounded border border-dashed border-[var(--color-border-strong)] px-1 text-[10.5px] text-[var(--color-text-muted)]" title="Тип клиента не указан — заполните в карточке клиента">Тип?</span>
            )}
            <CardMenu items={[
              ...(canManage && openTask && canTaskCol(col) ? [{ label: 'Ещё задача…', act: 'new_task' as const }] : []),
              ...(col.startsWith('pool') && canManage ? [{ label: 'Скрыть из пула', act: 'hide' as const }] : []),
              // Менеджер — из любой колонки (26.10: «буду строиться весной» при открытой сделке), кроме скрытых/брака/«Продано».
              ...(!canManage && isOwn && !c.hideRequest && col !== 'hidden' && col !== 'brak' && col !== 'st_sold' ? [{ label: 'Предложить скрыть', act: 'request_hide' as const }] : []),
              ...(canManage || isOwn ? [{ label: 'Теги…', act: 'tags' as const }] : []),
              ...(canMerge ? [{ label: 'Объединить с…', act: 'merge' as const }] : []),
              ...(canManage && (col.startsWith('pool') || col.startsWith('touch') || (isStage && col !== 'st_sold')) ? [{ label: 'Сразу в брак', act: 'brak_now' as const, danger: true }] : []),
            ]} onAct={act} />
          </div>
        </div>
        {/* Номер заказчика — идентификатор, не действие: цветом текста, ↗ по наведению (на таче виден всегда). */}
        <div className="mt-0.5 flex min-w-0 items-baseline justify-between gap-2 text-[11.5px] text-[var(--color-text-muted)]">
          <span className="min-w-0 truncate">{c.managerName}</span>
          <a href={c.clientType === 'company' ? `https://td.monolit-crm.ru/crm/company/details/${c.clientId}/` : `https://td.monolit-crm.ru/crm/contact/details/${c.clientId}/`}
            target="_blank" rel="noreferrer" className={`${FOCUS} inline-flex shrink-0 items-center gap-0.5 hover:text-[var(--color-text)] hover:underline`}
            title={`${c.clientType === 'company' ? 'Компания' : 'Контакт'} #${c.clientId} в Битриксе${c.members.length ? ` (склеен с ${c.members.map(m => `#${m.key.slice(1)}`).join(', ')})` : ''} — по этому номеру заказчик ищется в канбане`}>
            #{c.clientId}<ExternalLink size={10} className="hover-reveal shrink-0" />
          </a>
        </div>
      </div>

      {/* B. Признаки — только если есть. */}
      {(c.tags?.length > 0 || c.members.length > 0 || c.queued) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {c.tags?.length > 0 && <CardTags ids={c.tags} />}
          {c.members.length > 0 && <MembersBadge c={c} canMerge={canMerge} onUnmerge={onUnmerge} />}
          {c.queued && (
            <span className="rounded bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
              title={`Задача выдастся автоматически, когда у менеджера освободится место (вкладка «Очередь»)${c.queued.by ? `. Поставил ${c.queued.by}` : ''}`}>
              В очереди · {fmtDay(c.queued.at)}
            </span>
          )}
        </div>
      )}

      {/* C. Факты: деньги — главное число; последняя отгрузка; группа; что предложить. */}
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--color-text)]">
          <b className="font-semibold">{c.purchases}</b> {plural(c.purchases, 'отгрузка', 'отгрузки', 'отгрузок')} · <b className="font-semibold">{moneyShort(c.sumDelivered)}</b>
        </div>
        {c.lastDeliveredAt ? (
          <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-1 text-[11.5px] text-[var(--color-text-secondary)]">
            {c.lastDeliveredDealId ? (
              <a href={dealUrl(c.lastDeliveredDealId)} target="_blank" rel="noreferrer" className={`${FOCUS} hover:text-[var(--color-accent)] hover:underline`} title={`Сделка последней отгрузки #${c.lastDeliveredDealId} в Битриксе`}>
                Отгрузка {fmtDayYear(c.lastDeliveredAt)}
              </a>
            ) : <span>Отгрузка {fmtDayYear(c.lastDeliveredAt)}</span>}
            {/* Старая отгрузка подсвечивается там, где это сигнал (пул «Срочно» и «1 отгрузка»), а не у всех «рыбок». */}
            <span style={old !== null && old > 120 && (col === 'pool_1' || col === 'pool_hot') ? { color: 'var(--color-warning)' } : undefined}>· {old !== null ? ageLabel(old) : ''}</span>
            {windowLeft !== null && (
              <span className={windowLeft <= 3 ? 'font-semibold text-[var(--color-negative)]' : 'text-[var(--color-warning)]'}>· окно {windowLeft} дн.</span>
            )}
          </div>
        ) : <div className="text-[11.5px] text-[var(--color-text-muted)]">Отгрузок не было</div>}
        {c.lastDeliveredGroup && <div className="truncate text-[11.5px] text-[var(--color-text-muted)]" title={c.lastDeliveredGroup}>{c.lastDeliveredGroup}</div>}
        {(isPool || col.startsWith('touch')) && c.offer?.length > 0 && <div className="mt-0.5"><OfferLine offer={c.offer} /></div>}
      </div>

      {/* D. Сделка: в пуле «нет активной» — норма, не пишем; в стадиях стадия = колонка, не повторяем. */}
      {c.wrongFunnel && !c.deal ? (
        <a href={dealUrl(c.wrongFunnel.dealId)} target="_blank" rel="noreferrer" title="Повторная сделка заведена в первичной воронке — перенесите её в «Повторные» в Битриксе, тогда канбан её увидит"
          className={`${FOCUS} inline-flex max-w-full items-center gap-1 text-[11.5px] font-semibold text-[var(--color-negative)] hover:underline`}>
          <span className="truncate">#{c.wrongFunnel.dealId} · {c.wrongFunnel.stageName ?? ''} · {c.wrongFunnel.funnelName ?? 'первичная воронка'}</span><ExternalLink size={10} className="shrink-0" />
        </a>
      ) : c.deal ? (
        <a href={dealUrl(c.deal.dealId)} target="_blank" rel="noreferrer" title="Сделка в Битриксе"
          className={`${FOCUS} inline-flex max-w-full items-center gap-1 text-[11.5px] text-[var(--color-accent)] hover:underline`}>
          <span className="truncate">
            {col === 'review' && c.deal.lostAt ? `Отказ ${fmtDay(c.deal.lostAt)} · ${c.deal.stageName ?? ''}`
              : isStage ? `Сделка #${c.deal.dealId}${c.deal.amount ? ` · ${moneyShort(c.deal.amount)}` : ''}`
              : `#${c.deal.dealId} · ${c.deal.stageName ?? c.deal.stageId}`}
          </span>
          <ExternalLink size={10} className="hover-reveal shrink-0" />
        </a>
      ) : c.lastLost ? (
        <a href={dealUrl(c.lastLost.dealId)} target="_blank" rel="noreferrer" title="Последняя отказная повторная сделка в Битриксе"
          className={`${FOCUS} inline-flex max-w-full items-center gap-1 text-[11.5px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:underline`}>
          <span className="truncate">Отказ {fmtDay(c.lastLost.lostAt)} · {c.lastLost.stageName}</span><ExternalLink size={10} className="hover-reveal shrink-0" />
        </a>
      ) : null}

      {/* E. Контакт (дозвон, воронка, разбор): попытки ●●○, последний разговор, недозвоны. */}
      {!isPool && (c.attempts || good[0] || c.missedCalls > 0) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[var(--color-text-secondary)]">
          {c.attempts && (
            <TapTip label="Попытки связаться" text={c.attempts.days.map((d, i) => `${i + 1}-я попытка: ${d.split('-').reverse().slice(0, 2).join('.')}`).join('\n') || 'Попыток ещё не было'}>
              <span className="inline-flex gap-0.5">
                {[0, 1, 2].map(i => (
                  <span key={i} className={`inline-block h-2 w-2 rounded-full ${i < Math.min(c.attempts!.count, TOUCHES) ? (c.attempts!.reached ? 'bg-[var(--color-positive)]' : 'bg-[var(--color-accent)]') : 'border border-[var(--color-border-strong)]'}`} />
                ))}
              </span>
              <span>{Math.min(c.attempts.count, TOUCHES)}/{TOUCHES}</span>
              {c.attempts.reached && <span className="font-semibold text-[var(--color-positive)]">дозвон</span>}
            </TapTip>
          )}
          {good[0] && <span className="inline-flex items-center gap-0.5" title="Последний разговор"><Phone size={11} /> {fmtDT(good[0].at)} · {fmtSec(good[0].sec)}</span>}
          {c.missedCalls > 0 && <span className="inline-flex items-center gap-0.5 text-[var(--color-text-muted)]" title={`${c.missedCalls} недозвонов`}><PhoneMissed size={11} /> {c.missedCalls}</span>}
        </div>
      )}

      {/* F. Задача — свой блок: статус и срок, кто → кому (целиком, без обрезки чипа), проверка звонка, комментарий. */}
      {t && (
        <div className="flex min-w-0 flex-col gap-1 rounded-md bg-[var(--color-bg-surface)] px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: TASK_STATE[t.state].bg, color: TASK_STATE[t.state].fg }}>{TASK_STATE[t.state].label}</span>
            <span className="ml-auto shrink-0 text-[11px]">
              {taskLate ? <span className="font-semibold text-[var(--color-negative)]">просрочена {daysAgo(t.deadlineAt!)} дн.</span>
                : t.state === 'control' ? <span className="text-[var(--color-warning)]">ждёт приёмки{t.changedAt && daysAgo(t.changedAt) >= 1 ? ` ${daysAgo(t.changedAt)} дн.` : ''}</span>
                : openTask && t.deadlineAt ? <span className="text-[var(--color-text-muted)]">до {fmtDay(t.deadlineAt)}</span> : null}
            </span>
          </div>
          <a href={taskUrl(t.id)} target="_blank" rel="noreferrer" className={`${FOCUS} group/task flex min-w-0 items-center gap-1 text-[11.5px] text-[var(--color-text-muted)]`}
            title={`Задача #${t.id} в Битриксе — от ${fmtDT(t.createdAt)}${t.deadlineAt ? `, срок ${fmtDay(t.deadlineAt)}` : ''}`}>
            <span className="min-w-0 truncate group-hover/task:text-[var(--color-accent)] group-hover/task:underline">{shortName(t.createdByName)} → {shortName(t.responsibleName)}</span>
            <ExternalLink size={10} className="hover-reveal shrink-0" />
          </a>
          <TaskCheckChip taskId={t.id} onOpen={() => onAct('task_check')} />
          {note && <NoteBlock note={note} />}
        </div>
      )}

      {/* G. Тревоги — только требующие действия. */}
      {shownAlerts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {shownAlerts.map(a => (
            <span key={a.text} className="rounded px-1.5 py-0.5 text-[11px] font-semibold"
              style={a.red ? { background: 'var(--color-negative-soft)', color: 'var(--color-negative)' } : { background: 'color-mix(in srgb, var(--color-warning) 18%, transparent)', color: 'var(--color-warning)' }}>
              {a.red && <AlertTriangle size={10} className="mr-0.5 inline" />}{a.text}
            </span>
          ))}
          {alerts.length > 2 && <TapTip label="Ещё тревоги" text={alerts.slice(2).map(a => a.text).join('\n')}><span className="text-[11px] font-semibold text-[var(--color-text-muted)]">+{alerts.length - 2}</span></TapTip>}
        </div>
      )}

      {/* H. Служебные состояния: разбор, брак, скрыт, предложение скрыть. */}
      {c.review?.decision === 'return' && col === 'review' && (
        <div className="text-[11px] text-[var(--color-text-muted)]">Возвращено менеджеру {fmtDay(c.review.decidedAt)} · {c.review.decidedBy}</div>
      )}
      {c.brak && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          <span className="font-semibold text-[var(--color-negative)]">Брак</span> · {c.brak.by}, {fmtDay(c.brak.at)}
          {c.brak.comment && <span className="line-clamp-2 text-[var(--color-text-secondary)]">{c.brak.comment}</span>}
        </div>
      )}
      {c.hidden && (
        <div className="rounded-md bg-[var(--color-bg-surface)] px-2 py-1 text-[11.5px]">
          <div className="font-semibold text-[var(--color-text)]">Скрыт {fmtHideUntil(c.hidden.until)}</div>
          {c.hidden.comment && <div className="text-[var(--color-text-secondary)]">«{c.hidden.comment}»</div>}
          <div className="text-[var(--color-text-muted)]">{c.hidden.by}, {fmtDay(c.hidden.at)}</div>
        </div>
      )}
      {c.woke && (
        <div className="rounded-md bg-[var(--color-bg-surface)] px-2 py-1 text-[11.5px]">
          <div className="font-semibold text-[var(--color-text)]">Вернулся из скрытых · был скрыт до {c.woke.until.split('-').reverse().join('.')}</div>
          {c.woke.comment && <div className="text-[var(--color-text-secondary)]">«{c.woke.comment}»</div>}
          <div className="text-[var(--color-text-muted)]">{c.woke.by}</div>
        </div>
      )}
      {c.hideRequest && (
        <div className="rounded-md px-2 py-1 text-[11.5px]" style={{ background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)' }}>
          <div className="font-semibold text-[var(--color-text)]">Предлагает скрыть {fmtHideUntil(c.hideRequest.until)}</div>
          <div className="text-[var(--color-text-secondary)]">«{c.hideRequest.comment}»</div>
          <div className="text-[var(--color-text-muted)]">{c.hideRequest.by}, {fmtDay(c.hideRequest.at)}</div>
          {canManage && (
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => onAct('accept_hide')} className={`${CARD_BTN} min-h-10 rounded-md bg-[var(--color-warning)] px-2 text-xs font-medium text-white hover:opacity-90`}>Скрыть</button>
              <button type="button" onClick={() => onAct('decline_hide')} className={`${CARD_BTN} min-h-10 rounded-md border border-[var(--color-border)] px-2 text-xs font-medium hover:bg-[var(--color-bg-hover)]`}>Отклонить</button>
            </div>
          )}
        </div>
      )}

      {/* I. ОДНО действие (Fable): «Принять задачу…» важнее «+ Задача»; при открытой задаче кнопки нет («Ещё задача…» — в ⋯). */}
      {canManage && (() => {
        const btn = `${CARD_BTN} inline-flex min-h-11 w-full items-center justify-center gap-1 rounded-md px-2.5 text-xs font-medium hover:opacity-90`;
        if (t?.state === 'control') return <button type="button" onClick={() => onAct('accept_task')} className={`${btn} bg-[var(--color-positive)] text-white`}><CheckSquare size={13} /> Принять задачу…</button>;
        if (col === 'review') return <button type="button" onClick={onReview} className={`${btn} bg-[var(--color-accent)] text-white`}>{c.dozvonFail ? 'Разобрать: 3 попытки без дозвона' : 'Разобрать отказ'}</button>;
        if (col === 'hidden') return <button type="button" onClick={() => onAct('unhide')} className={`${btn} border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]`}>Вернуть в пул</button>;
        if (col === 'brak') return <button type="button" onClick={onUnbrak} className={`${btn} border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]`}>Снять брак</button>;
        if (canTaskCol(col) && !openTask) return <button type="button" onClick={onTask} className={`${btn} bg-[var(--color-accent-soft)] text-[var(--color-accent)]`}><Plus size={13} /> {dealLabel}</button>;
        return null;
      })()}
    </article>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
};
const shortName = (full: string | null) => {
  if (!full) return '—';
  const parts = full.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : full;
};

const fieldCls = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base text-[var(--color-text)] sm:text-sm';

/** Дата по Москве (YYYY-MM-DD) через n дней от ms. */
const mskYmd = (ms: number, plusDays = 0) => new Date(ms + 3 * 3600_000 + plusDays * 86_400_000).toISOString().slice(0, 10);
/** Срок «до конца окна» (владелец 21.10): окно открыто — последняя отгрузка + 22 дня (не раньше
 *  чем через 2 дня); закрыто — новое окно с сегодняшнего дня, +22 дня. */
function windowEnd(c: KanbanCard): string {
  const now = Date.now();
  if (c.lastDeliveredAt) {
    const end = new Date(c.lastDeliveredAt).getTime() + WINDOW_DAYS * 86_400_000;
    if (end >= now + 2 * 86_400_000) return mskYmd(end);
  }
  return mskYmd(now, WINDOW_DAYS);
}
const fmtYmd = (ymd: string) => ymd.split('-').reverse().join('.');

function DeadlinePicker({ card, value, onChange, time, onTime }: {
  card: KanbanCard; value: string; onChange: (v: string) => void; time: string; onTime: (t: string) => void;
}) {
  // Владелец 21.10: «задачу должно быть можно поставить на сегодня; время по умолчанию 19:00».
  const presets = [
    { label: 'Сегодня', v: mskYmd(Date.now()) },
    { label: 'До конца окна', v: windowEnd(card) },
    { label: '+3 дня', v: mskYmd(Date.now(), 3) },
    { label: '+7 дней', v: mskYmd(Date.now(), 7) },
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[var(--color-text-secondary)]">Срок задачи</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {presets.map(p => (
          <button key={p.label} type="button" onClick={() => onChange(p.v)} className={`${value === p.v ? BTN_ACTIVE : BTN_IDLE} whitespace-nowrap px-2`}>
            {p.label} <span className="opacity-75">· {fmtYmd(p.v).slice(0, 5)}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-2">
        <input type="date" value={value} min={mskYmd(Date.now())} onChange={e => e.target.value && onChange(e.target.value)} aria-label="Дата срока" className={`${fieldCls} min-h-11`} />
        <input type="time" value={time} step={900} onChange={e => e.target.value && onTime(e.target.value)} aria-label="Время срока (МСК)" className={`${fieldCls} min-h-11`} />
      </div>
    </div>
  );
}

function OverloadNote({ name, load, limit }: { name: string; load: number; limit: number }) {
  if (load < limit) return <p className="text-xs text-[var(--color-text-muted)]">У {shortName(name)} {load} из {limit} активных задач.</p>;
  return (
    <p className="rounded-lg bg-[#fff2cc] p-2 text-[#7f6000]">
      <AlertTriangle size={13} className="mr-1 inline" />У {shortName(name)} уже {load} активных задач при норме {limit} — менеджер перегружен. Поставить всё равно можно.
    </p>
  );
}

interface ReassignOpts { managers: { id: string; name: string }[]; loadOf: (id: string) => number }

/** «И сменить менеджера на …» — смена ответственного бизнес-процессом Битрикса «Сменить
 *  ответственного» (он перепривязывает сделку, контакт, почту); задача — уже новому менеджеру. */
function ReassignPicker({ opts, currentId, value, onChange }: { opts: ReassignOpts; currentId: string | null; value: string; onChange: (v: string) => void }) {
  const [on, setOn] = useState(!!value);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[var(--color-text-secondary)]">
        <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); if (!e.target.checked) onChange(''); }} className="h-4 w-4" />
        И сменить менеджера на…
      </label>
      {on && (
        <>
          <SearchSelect ariaLabel="Новый менеджер" value={value} onChange={onChange} searchable
            options={[{ value: '', label: 'Выберите менеджера' }, ...opts.managers.filter(m => m.id !== currentId)
              .map(m => ({ value: m.id, label: m.name, hint: `${opts.loadOf(m.id)} активных задач` }))]}
            className={`${value ? BTN_ACTIVE : BTN_IDLE} w-full justify-start`} />
          <p className="text-xs text-[var(--color-text-muted)]">
            Ответственный сменится бизнес-процессом Битрикса «Сменить ответственного» (сделка, контакт, почта), задача уйдёт новому менеджеру.
          </p>
        </>
      )}
    </div>
  );
}

// ── Очередь (миграция 237): «Сразу» или «В очередь» в окнах задачи ──────────────────────────
type TaskMode = 'now' | 'queue';
function useTemplates() {
  const { data } = useQuery<{ templates: { id: number; name: string; isDefault: boolean }[]; settings?: { queueDailyLimit?: number; managerTaskLimit?: number } }>({
    queryKey: ['repeat-kanban-templates'],
    queryFn: async () => { const r = await fetch('/api/repeat-kanban/settings'); return r.ok ? r.json() : { templates: [] }; },
    staleTime: 60_000,
  });
  return { templates: data?.templates ?? [], dailyLimit: data?.settings?.queueDailyLimit ?? 3 };
}
function ModeToggle({ mode, onChange }: { mode: TaskMode; onChange: (m: TaskMode) => void }) {
  const tab = (m: TaskMode, label: string, hint: string) => (
    <button type="button" role="tab" aria-selected={mode === m} onClick={() => onChange(m)} title={hint}
      className={`inline-flex min-h-10 flex-1 items-center justify-center rounded-md px-3 text-sm ${mode === m ? 'bg-[var(--color-accent)] text-white' : 'text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>{label}</button>
  );
  return (
    <div className="flex gap-1 rounded-lg border border-[var(--color-border)] p-0.5" role="tablist" aria-label="Когда ставить">
      {tab('now', 'Сразу', 'Сделка и задача — прямо сейчас')}
      {tab('queue', 'В очередь', 'Задача выдастся менеджеру, когда у него освободится место — по срочности')}
    </div>
  );
}
function QueueRuleFields({ rule, onRule, time, onTime }: { rule: 'today' | 'window' | '3' | '7'; onRule: (r: 'today' | 'window' | '3' | '7') => void; time: string; onTime: (t: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[var(--color-text-secondary)]">Срок — считается в момент выдачи</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['today', 'В день выдачи'], ['window', 'До конца окна'], ['3', '+3 дня'], ['7', '+7 дней']] as const).map(([v, l]) => (
          <button key={v} type="button" onClick={() => onRule(v)} className={rule === v ? BTN_ACTIVE : BTN_IDLE}>{l}</button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-[var(--color-text-secondary)]">
        Время
        <input type="time" value={time} step={900} onChange={e => e.target.value && onTime(e.target.value)} aria-label="Время срока (МСК)" className={`${fieldCls} min-h-11 w-32`} />
      </label>
    </div>
  );
}

function TaskModal({ card, load, limit, reassign, onClose, onSaved }: { card: KanbanCard; load: number; limit: number; reassign: ReassignOpts | null; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [newManager, setNewManager] = useState('');
  const [deadline, setDeadline] = useState(() => windowEnd(card));
  const [deadlineTime, setDeadlineTime] = useState('19:00');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ taskId: number; dealId: number; dealMode: string; chatPosted?: boolean; accomplices?: number[]; auditors?: number[] } | null>(null);
  const [mode, setMode] = useState<TaskMode>('now');
  const { templates, dailyLimit } = useTemplates();
  const [qTemplate, setQTemplate] = useState('');
  const qTid = qTemplate || String(templates.find(t => t.isDefault)?.id ?? templates[0]?.id ?? '');
  const [qComment, setQComment] = useState('');
  const [qRule, setQRule] = useState<'today' | 'window' | '3' | '7'>('window');
  const [queued, setQueued] = useState<{ added: number; updated: number } | null>(null);
  // Участники (владелец 23.10): по умолчанию соисполнитель — РОП менеджера.
  const [parts, setParts] = useState(initialParticipants);
  const att = useAttachments();
  const submitQueue = async () => {
    setBusy(true); setErr(null);
    try {
      const j = await post({ action: 'queue_add', items: [{ clientKey: card.clientKey, managerId: card.managerId }], templateId: qTid ? Number(qTid) : undefined,
        comment: qComment, deadlineRule: qRule, deadlineTime, newManagerId: newManager || undefined, participants: participantsPayload(parts) });
      if (!j.added && !j.updated) throw new Error('Не удалось поставить в очередь');
      setQueued(j); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  // Что произойдёт со сделкой — по правилам ТЗ (engine/createDeal.ts), заранее и честно.
  // Последняя сделка отгружена — новая сделка (а не «задача в отгруженную»: владелец 23.10 увидел именно это).
  const cur = card.deal;
  const what = cur && WON_STAGES.has(cur.stageId) ? `Сделка #${cur.dealId} отгружена — будет создана новая повторная сделка «ПОСМОТРИ ЗАДАЧУ …».`
    : cur && LOST_STAGES.has(cur.stageId) ? `Сделка #${cur.dealId} вернётся из отказа в первую стадию, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : cur ? `Задача в сделку #${cur.dealId}, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : card.lastLost ? `Сделка #${card.lastLost.dealId} вернётся из отказа в первую стадию, в название — «ПОСМОТРИ ЗАДАЧУ».`
    : 'Будет создана новая повторная сделка «ПОСМОТРИ ЗАДАЧУ …» (как из контакта).';

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const attachments = await att.upload();
      const j = await post({ action: 'create_task', clientKey: card.clientKey, managerId: card.managerId, column: card.column, text, deadline, deadlineTime, newManagerId: newManager || undefined, participants: participantsPayload(parts), attachments });
      setResult(j); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Задача · ${cardName(card)}`} desktopWidth="sm:max-w-4xl">
      {queued ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">
            {queued.updated ? 'Позиция в очереди обновлена.' : 'Поставлено в очередь.'} Задача выдастся {newManager ? shortName(reassign?.managers.find(m => m.id === newManager)?.name ?? '') : shortName(card.managerName)},
            когда у него активных задач станет меньше {limit}, — не больше {dailyLimit} в день, по будням с 9 до 18. Порядок — по срочности. Следить — вкладка «Очередь».
          </p>
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Готово</button>
        </div>
      ) : result ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">
            {result.dealMode === 'created' ? `Создана сделка #${result.dealId}` : result.dealMode === 'reopened' ? `Сделка #${result.dealId} возвращена из отказа` : `Сделка #${result.dealId}`}
            {' '}и задача в проекте «Повторные продажи», срок {fmtYmd(deadline)} {deadlineTime}.{text.trim() ? (result.chatPosted ? ' Сообщение — в описании и первым сообщением в чате задачи.' : ' Сообщение — в описании задачи (в чат задачи отправить не удалось).') : ''}
            {(result.accomplices?.length || result.auditors?.length) ? ` Участники: соисполнителей ${result.accomplices?.length ?? 0}, наблюдателей ${result.auditors?.length ?? 0}.` : ''}
          </p>
          <div className="flex flex-wrap gap-3">
            <a href={taskUrl(result.taskId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"><ExternalLink size={13} /> Задача #{result.taskId}</a>
            <a href={dealUrl(result.dealId)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"><ExternalLink size={13} /> Сделка #{result.dealId}</a>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Готово</button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p className="rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text-secondary)]">
            {what} Исполнитель — ответственный за сделку, закрыть задачу может только постановщик.
            В описание сами добавятся отгрузки заказчика со ссылками и анкета последней отгрузки; сообщение ниже уйдёт и первым сообщением в чат задачи.
          </p>
          <OverloadNote name={newManager ? reassign?.managers.find(m => m.id === newManager)?.name ?? card.managerName : card.managerName}
            load={newManager && reassign ? reassign.loadOf(newManager) : load} limit={limit} />
          <ModeToggle mode={mode} onChange={setMode} />
          {reassign && <ReassignPicker opts={reassign} currentId={card.managerId} value={newManager} onChange={setNewManager} />}
          <ParticipantsPicker value={parts} onChange={setParts} managerIds={[newManager || card.managerId]} />
          {mode === 'now' ? (
            <>
              {/* Шаблон (настройки канбана): по умолчанию подставляется отмеченный «по умолчанию»,
                  уже заполненный данными заказчика; текст можно править. */}
              <TemplatePicker clientKey={card.clientKey} managerId={card.managerId} value={text} onChange={setText} />
              <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
                Сообщение менеджеру
                {/* Крупно (владелец 23.10: «сделай окно крупно, чтобы сообщение было видно целиком»):
                    шаблон + памятка «Перед звонком» — 15–25 строк. */}
                <textarea value={text} onChange={e => setText(e.target.value)} onPaste={att.onPaste} rows={20} {...att.dropZone}
                  placeholder="У тебя дом без крыши — будет капать дождь — предложи металлочерепицу!" className={`${fieldCls} min-h-[45dvh] resize-y leading-relaxed sm:min-h-[420px] ${att.dragOver ? 'outline outline-2 outline-[var(--color-accent)]' : ''}`} />
              </label>
              {/* Файлы и картинки — к первому сообщению в чате задачи (владелец 23.10). */}
              <AttachmentsRow a={att} />
              <DeadlinePicker card={card} value={deadline} onChange={setDeadline} time={deadlineTime} onTime={setDeadlineTime} />
            </>
          ) : (
            <>
              <p className="text-xs text-[var(--color-text-muted)]">Сообщение соберётся по шаблону в момент выдачи — с актуальными данными заказчика.</p>
              <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
                Шаблон сообщения
                <SearchSelect ariaLabel="Шаблон сообщения" value={qTid} onChange={setQTemplate}
                  options={templates.length ? templates.map(t => ({ value: String(t.id), label: `${t.name}${t.isDefault ? ' · по умолчанию' : ''}` })) : [{ value: '', label: 'Шаблонов нет — без сообщения' }]}
                  className="w-full justify-start bg-[var(--color-bg)]" />
              </label>
              <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
                Добавка от РОПа (необязательно)
                <textarea value={qComment} onChange={e => setQComment(e.target.value)} rows={4} placeholder="Добавится в конце сообщения" className={fieldCls} />
              </label>
              <QueueRuleFields rule={qRule} onRule={setQRule} time={deadlineTime} onTime={setDeadlineTime} />
            </>
          )}
          {err && <p className="text-[var(--color-negative)]">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
            <button type="button" disabled={busy} onClick={mode === 'queue' ? submitQueue : submit}
              className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
              {busy ? 'Сохраняю…' : mode === 'queue' ? 'Поставить в очередь' : 'Поставить задачу'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Массовая постановка (аудит 21.10): одна задача на каждого выбранного заказчика, сообщение —
 *  выбранный шаблон, заполненный по каждому заказчику на сервере. По одной, с прогрессом: каждая
 *  задача — несколько вызовов Битрикса, пачкой запрос упёрся бы в таймаут прокси. */
function BulkTaskModal({ cards, loadOf, limit, reassign, onClose, onDone }: {
  cards: KanbanCard[]; loadOf: (managerId: string) => number; limit: number; reassign: ReassignOpts | null; onClose: () => void; onDone: () => void;
}) {
  const [newManager, setNewManager] = useState('');
  const { templates, dailyLimit } = useTemplates();
  // «В очередь» по умолчанию для пачки (владелец 22.10: «чтобы задачи не сыпались на менеджера»).
  const [mode, setMode] = useState<TaskMode>(cards.length > 3 ? 'queue' : 'now');
  const [qComment, setQComment] = useState('');
  const [queued, setQueued] = useState<{ added: number; updated: number; skipped: number } | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const tid = templateId || String(templates.find(t => t.isDefault)?.id ?? templates[0]?.id ?? '');
  const [deadlineMode, setDeadlineMode] = useState<'today' | 'window' | '3' | '7'>('window');
  const [deadlineTime, setDeadlineTime] = useState('19:00');
  const [results, setResults] = useState<Map<string, { ok: boolean; text: string }>>(new Map());
  const [running, setRunning] = useState(false);
  const [parts, setParts] = useState(initialParticipants);
  const stop = useRef(false);

  // Перегрузка: сколько задач у менеджера станет после постановки.
  const perMgr = new Map<string, { name: string; n: number }>();
  for (const c of cards) { const m = perMgr.get(c.managerId) ?? { name: c.managerName, n: 0 }; m.n++; perMgr.set(c.managerId, m); }
  const over = [...perMgr].filter(([id, m]) => loadOf(id) + m.n > limit);
  const done = results.size;

  const runQueue = async () => {
    setRunning(true);
    try {
      const j = await post({ action: 'queue_add', items: cards.map(c => ({ clientKey: c.clientKey, managerId: c.managerId })),
        templateId: tid ? Number(tid) : undefined, comment: qComment, deadlineRule: deadlineMode, deadlineTime, newManagerId: newManager || undefined,
        participants: participantsPayload(parts) });
      setQueued(j);
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    setRunning(false);
  };
  const run = async () => {
    if (mode === 'queue') return runQueue();
    setRunning(true); stop.current = false;
    for (const c of cards) {
      if (stop.current) break;
      if (results.get(c.clientKey)?.ok) continue;
      const deadline = deadlineMode === 'window' ? windowEnd(c) : deadlineMode === 'today' ? mskYmd(Date.now()) : mskYmd(Date.now(), Number(deadlineMode));
      try {
        const j = await post({ action: 'create_task', clientKey: c.clientKey, managerId: c.managerId, column: c.column, text: '', templateId: tid ? Number(tid) : undefined, deadline, deadlineTime, newManagerId: newManager && newManager !== c.managerId ? newManager : undefined, participants: participantsPayload(parts) });
        setResults(m => new Map(m).set(c.clientKey, { ok: true, text: `задача #${j.taskId}` }));
      } catch (e) {
        setResults(m => new Map(m).set(c.clientKey, { ok: false, text: e instanceof Error ? e.message : String(e) }));
      }
    }
    setRunning(false);
  };
  const okCount = [...results.values()].filter(r => r.ok).length;
  const finished = !running && done > 0;

  return (
    <Modal open onOpenChange={o => { if (!o && !running) { if (okCount || queued) onDone(); onClose(); } }} title={`Задачи · ${rub.format(cards.length)} заказчиков`} desktopWidth="sm:max-w-2xl">
      {queued ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">
            В очередь: новых {rub.format(queued.added)}, обновлено {rub.format(queued.updated)}{queued.skipped ? `, пропущено ${queued.skipped} (не у этих менеджеров)` : ''}.
            Задачи будут выдаваться менеджерам по срочности, пока у них активных меньше {limit}, — не больше {dailyLimit} в день каждому, по будням с 9 до 18.
            Прогноз и порядок — во вкладке «Очередь».
          </p>
          <button type="button" onClick={() => { onDone(); onClose(); }} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Готово</button>
        </div>
      ) : (
      <div className="flex flex-col gap-3 text-sm">
        <ModeToggle mode={mode} onChange={setMode} />
        <p className="rounded-lg bg-[var(--color-bg-surface)] p-3 text-[var(--color-text-secondary)]">
          Каждому заказчику — своя задача в проекте «Повторные продажи» по тем же правилам, что у кнопки на карточке
          (сделка создаётся, возвращается из отказа или берётся текущая). Сообщение — шаблон, заполненный данными каждого заказчика.
        </p>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Шаблон сообщения
          <SearchSelect ariaLabel="Шаблон сообщения" value={tid} onChange={setTemplateId}
            options={templates.length ? templates.map(t => ({ value: String(t.id), label: `${t.name}${t.isDefault ? ' · по умолчанию' : ''}` })) : [{ value: '', label: 'Шаблонов нет — задачи без сообщения' }]}
            className="w-full justify-start bg-[var(--color-bg)]" />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[var(--color-text-secondary)]">Срок задач</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {([['today', 'Сегодня'], ['window', 'До конца окна — у каждого свой'], ['3', '+3 дня'], ['7', '+7 дней']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setDeadlineMode(v)} className={deadlineMode === v ? BTN_ACTIVE : BTN_IDLE}>{l}</button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[var(--color-text-secondary)]">
            Время
            <input type="time" value={deadlineTime} step={900} onChange={e => e.target.value && setDeadlineTime(e.target.value)} aria-label="Время срока (МСК)" className={`${fieldCls} min-h-11 w-32`} />
          </label>
        </div>
        {reassign && <ReassignPicker opts={reassign} currentId={null} value={newManager} onChange={setNewManager} />}
        <ParticipantsPicker value={parts} onChange={setParts} managerIds={newManager ? [newManager] : [...new Set(cards.map(c => c.managerId))]} />
        {mode === 'queue' && (
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Добавка от РОПа ко всем (необязательно)
            <textarea value={qComment} onChange={e => setQComment(e.target.value)} rows={3} placeholder="Добавится в конце каждого сообщения" className={fieldCls} />
          </label>
        )}
        {mode === 'now' && over.length > 0 && (
          <div className="rounded-lg bg-[#fff2cc] p-2 text-[#7f6000]">
            <AlertTriangle size={13} className="mr-1 inline" />Станут перегружены (норма {limit}):{' '}
            {over.map(([id, m]) => `${shortName(m.name)} — ${loadOf(id) + m.n}`).join(', ')}. Поставить всё равно можно.
          </div>
        )}
        {done > 0 && (
          <div className="flex flex-col gap-1">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--color-bg-surface)]">
              <div className="h-full bg-[var(--color-accent)] transition-all" style={{ width: `${(done / cards.length) * 100}%` }} />
            </div>
            <div className="text-xs text-[var(--color-text-muted)]">Готово {done} из {cards.length}{okCount < done ? ` · с ошибкой ${done - okCount}` : ''}</div>
            <ul className="max-h-48 overflow-y-auto text-xs">
              {cards.filter(c => results.has(c.clientKey)).map(c => {
                const r = results.get(c.clientKey)!;
                return <li key={c.clientKey} className={r.ok ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-negative)]'}>{cardName(c)} — {r.text}</li>;
              })}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {running ? (
            <button type="button" onClick={() => { stop.current = true; }} className="min-h-11 rounded-lg border border-[var(--color-border)] px-4">Остановить</button>
          ) : (
            <>
              <button type="button" onClick={() => { if (okCount) onDone(); onClose(); }} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">{finished ? 'Закрыть' : 'Отмена'}</button>
              {(!finished || okCount < cards.length) && (
                <button type="button" onClick={run} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">
                  {finished ? 'Повторить ошибочные' : mode === 'queue' ? `В очередь · ${rub.format(cards.length)}` : `Поставить ${rub.format(cards.length)} ${plural(cards.length, 'задачу', 'задачи', 'задач')}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </Modal>
  );
}

function HideModal({ card, request = false, onClose, onSaved }: { card: KanbanCard; request?: boolean; onClose: () => void; onSaved: () => void }) {
  const plus = (m: number) => { const d = new Date(Date.now() + 3 * 3600_000); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
  const nextMarch = () => { const d = new Date(Date.now() + 3 * 3600_000); const y = d.getUTCMonth() >= 2 ? d.getUTCFullYear() + 1 : d.getUTCFullYear(); return `${y}-03-01`; };
  const presets = [
    { label: '1 месяц', v: plus(1) }, { label: '3 месяца', v: plus(3) },
    { label: 'До марта', v: nextMarch() }, { label: 'Полгода', v: plus(6) },
    // Навсегда (владелец 22.10): без срока — вернётся только кнопкой «Вернуть в пул».
    { label: 'Навсегда', v: HIDE_FOREVER },
  ];
  const [until, setUntil] = useState(presets[1].v);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await post({ action: request ? 'request_hide' : 'hide', clientKey: card.clientKey, managerId: card.managerId, column: card.column, until, comment }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`${request ? 'Предложить скрыть' : 'Скрыть из пула'} · ${cardName(card)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-[var(--color-text-secondary)]">{request
          ? 'Предложение уйдёт РОПу: если он согласится, заказчик уйдёт в «Скрытые» и сам вернётся в пул в выбранный день (или останется там навсегда).'
          : 'Заказчик уйдёт в колонку «Скрытые» и сам вернётся в пул в выбранный день (или останется там навсегда).'}</div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[var(--color-text-secondary)]">До какого числа</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {presets.map(p => (
              <button key={p.label} type="button" onClick={() => setUntil(p.v)}
                className={until === p.v ? BTN_ACTIVE : BTN_IDLE}>{p.label}</button>
            ))}
          </div>
          {until === HIDE_FOREVER
            ? <p className="text-[var(--color-text-secondary)]">Без срока: сам в пул не вернётся — только кнопкой «Вернуть в пул» на карточке в «Скрытых».</p>
            : <input type="date" value={until} min={plus(0)} onChange={e => setUntil(e.target.value)} className={`${fieldCls} min-h-11`} />}
        </div>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Почему скрываем (обязательно)
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} autoFocus
            placeholder="Вернётся к стройке в следующем году" className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || comment.trim().length < 3 || !until} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : request ? 'Предложить' : 'Скрыть'}</button>
        </div>
      </div>
    </Modal>
  );
}

const MERGE_SOURCE: Record<string, string> = { auto_contact: 'авто: тот же контакт', auto_company: 'авто: контакт компании', manual: 'вручную' };
const keyLabel = (k: string) => `${k.startsWith('k') ? 'Компания' : k.startsWith('x') ? 'Контакт (юр.)' : 'Контакт'} #${k.slice(1)}`;

/** «Объединено: N карточки» — из каких карточек Битрикса собран заказчик; РОП может разъединить. */
function MembersBadge({ c, canMerge, onUnmerge }: { c: KanbanCard; canMerge: boolean; onUnmerge: (m: KanbanCard['members'][number]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} align="start" className="w-[320px] max-w-[calc(100vw-16px)] p-3 text-[12.5px]"
      trigger={
        <button type="button" className="self-start rounded bg-[var(--color-bg-surface)] px-1.5 py-0.5 text-[11.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          title="Один человек — несколько карточек в Битриксе: отгрузки и потенциал посчитаны вместе">
          Объединено: {c.members.length + 1} {plural(c.members.length + 1, 'карточка', 'карточки', 'карточек')}
        </button>
      }>
      <div className="flex flex-col gap-2">
        <div className="font-semibold text-[var(--color-text)]">Один заказчик из нескольких карточек Битрикса</div>
        <div className="text-[var(--color-text-secondary)]">Главная: {cardName(c)} · {keyLabel(c.clientKey)}</div>
        {c.members.map(m => (
          <div key={m.key} className="flex items-center gap-2 border-t border-[var(--color-border)] pt-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[var(--color-text)]">{m.name ?? keyLabel(m.key)}</div>
              <div className="text-[11.5px] text-[var(--color-text-muted)]">{keyLabel(m.key)} · {MERGE_SOURCE[m.source] ?? m.source}</div>
            </div>
            {canMerge && (
              <button type="button" onClick={() => { setOpen(false); onUnmerge(m); }}
                className="min-h-9 shrink-0 rounded-md border border-[var(--color-border)] px-2 text-[12px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Разъединить</button>
            )}
          </div>
        ))}
      </div>
    </Popover>
  );
}

/** «Объединить с…» (РОП и старше): найти вторую карточку того же человека, выбрать главную. */
function MergeModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<KanbanCard[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [other, setOther] = useState<KanbanCard | null>(null);
  const [primary, setPrimary] = useState<'self' | 'other'>('self');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound(null); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/repeat-kanban?q=${encodeURIComponent(term)}`);
        const j = await r.json() as RepeatBoard;
        const seen = new Set<string>([card.clientKey]);
        setFound((j.columns ?? []).flatMap(c => c.cards).filter(c => !seen.has(c.clientKey) && seen.add(c.clientKey)).slice(0, 30));
      } catch { setFound([]); }
      setSearching(false);
    }, 400);
    return () => clearTimeout(t);
  }, [q, card.clientKey]);
  const submit = async () => {
    if (!other) return;
    setBusy(true); setErr(null);
    try {
      await post({ action: 'merge', clientKey: card.clientKey, managerId: card.managerId, otherKey: other.clientKey, otherManagerId: other.managerId, primary, comment, column: card.column });
      setDone(true); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  const pill = (on: boolean) => `min-h-11 flex-1 rounded-lg border px-3 text-left text-sm ${on ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`;
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Объединить · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      {done ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-[var(--color-text)]">Готово. Карточки станут одним заказчиком при обновлении списка — меньше минуты: отгрузки, потенциал и сделки посчитаются вместе. Разъединить — плашка «Объединено» на карточке.</p>
          <div className="flex justify-end"><button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Закрыть</button></div>
        </div>
      ) : (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-[var(--color-text-secondary)]">Один человек в Битриксе бывает несколькими карточками (контакт, юр-сделки, компания). Найдите вторую карточку — дальше это будет один заказчик.</p>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Вторая карточка — имя, номер контакта/компании или сделки
          <input value={q} onChange={e => { setQ(e.target.value); setOther(null); }} placeholder="Хорев или 15105" className={fieldCls} autoFocus />
        </label>
        {searching && <p className="text-[var(--color-text-muted)]">Ищу…</p>}
        {!other && found && (
          found.length === 0 ? <p className="text-[var(--color-text-muted)]">Ничего не нашлось в вашей зоне.</p> : (
            <div className="flex max-h-64 flex-col divide-y divide-[var(--color-border)] overflow-y-auto rounded-lg border border-[var(--color-border)]">
              {found.map(f => (
                <button key={f.clientKey} type="button" onClick={() => setOther(f)} className="flex min-h-11 flex-col items-start px-3 py-1.5 text-left hover:bg-[var(--color-bg-hover)]">
                  <span className="text-[var(--color-text)]">{cardName(f)}</span>
                  <span className="text-[11.5px] text-[var(--color-text-muted)]">{keyLabel(f.clientKey)} · {f.managerName} · {f.purchases} {plural(f.purchases, 'отгрузка', 'отгрузки', 'отгрузок')}</span>
                </button>
              ))}
            </div>
          )
        )}
        {other && (
          <>
            <div className="text-[var(--color-text-secondary)]">Какая карточка главная — на неё ставятся сделки и задачи:</div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button type="button" onClick={() => setPrimary('self')} className={pill(primary === 'self')}>{cardName(card)}<br /><span className="text-[11.5px] opacity-80">{keyLabel(card.clientKey)} · {card.managerName}</span></button>
              <button type="button" onClick={() => setPrimary('other')} className={pill(primary === 'other')}>{cardName(other)}<br /><span className="text-[11.5px] opacity-80">{keyLabel(other.clientKey)} · {other.managerName}</span></button>
            </div>
            {other.managerId !== card.managerId && (
              <p className="text-[#b45f06]">Менеджеры разные: заказчик останется у менеджера последней сделки, второй увидит его в «ранее работал с».</p>
            )}
            <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
              Комментарий (необязательно)
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Один человек: ИП и физлицо" className={fieldCls} />
            </label>
          </>
        )}
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || !other} onClick={submit} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">{busy ? 'Объединяю…' : 'Объединить'}</button>
        </div>
      </div>
      )}
    </Modal>
  );
}

/** Массовый брак (владелец 28.10): общие причина и комментарий; по каждой карточке — «Сразу в брак» (отметка брака,
 *  открытая повторная сделка закрывается в Битриксе в стадию по причине). По одной, с прогрессом и ошибками. */
function BulkBrakModal({ cards: initial, onClose, onDone }: { cards: KanbanCard[]; onClose: () => void; onDone: () => void }) {
  // Список фиксируем при открытии: onDone снимает выбор, а окно с итогом ещё открыто.
  const [cards] = useState(initial);
  const [reason, setReason] = useState<string>('nothing_needed');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [errors, setErrors] = useState<{ name: string; error: string }[]>([]);
  const [finished, setFinished] = useState(false);
  const withDeal = cards.filter(c => c.deal && !LOST_STAGES.has(c.deal.stageId) && !WON_STAGES.has(c.deal.stageId)).length;
  const submit = async () => {
    if (!confirm(`Отправить в брак ${cards.length} ${plural(cards.length, 'заказчика', 'заказчиков', 'заказчиков')}?${withDeal ? ` Открытые сделки (${withDeal}) закроются в Битриксе.` : ''}`)) return;
    setBusy(true); setDone(0); setErrors([]);
    const errs: { name: string; error: string }[] = [];
    for (const c of cards) {
      try {
        await post({ action: 'brak_now', clientKey: c.clientKey, managerId: c.managerId, column: c.column, reason, comment, dealId: c.deal?.dealId ?? c.openDealInBrak ?? undefined });
      } catch (e) { errs.push({ name: cardName(c), error: e instanceof Error ? e.message : String(e) }); }
      setDone(n => n + 1);
    }
    setErrors(errs); setBusy(false); setFinished(true);
    onDone();
  };
  return (
    <Modal open onOpenChange={o => { if (!o && !busy) onClose(); }} title={`В брак · ${cards.length} ${plural(cards.length, 'заказчик', 'заказчика', 'заказчиков')}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        {finished ? (
          <>
            <p className="text-[var(--color-text)]">Готово: в брак {cards.length - errors.length} из {cards.length}.</p>
            {errors.length > 0 && (
              <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[12.5px]">
                {errors.map((e, i) => <li key={i}><b>{e.name}</b>: <span className="text-[var(--color-negative)]">{e.error}</span></li>)}
              </ul>
            )}
            <div className="flex justify-end"><button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white">Закрыть</button></div>
          </>
        ) : (
          <>
            <div className="text-[var(--color-text-secondary)]">
              Все отмеченные заказчики уйдут в «Брак» без разбора отказа — с одной причиной и комментарием.
              {withDeal ? ` У ${withDeal} открыта повторная сделка — она закроется в Битриксе в отказную стадию по причине, комментарий — в ленту сделки.` : ''}
              {' '}Вернуть можно кнопкой «Снять брак».
            </div>
            <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
              Причина
              <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason}
                options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))} className="w-full justify-start bg-[var(--color-bg)]" />
            </label>
            <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
              Комментарий (всем)
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Разовые покупки, повторов не будет" className={fieldCls} />
            </label>
            {busy && (
              <div className="flex flex-col gap-1">
                <div className="h-2 overflow-hidden rounded bg-[var(--color-bg-hover)]"><div className="h-full bg-[var(--color-negative)]" style={{ width: `${(done / cards.length) * 100}%` }} /></div>
                <span className="text-[12px] text-[var(--color-text-muted)]">{done} из {cards.length}…</span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50">Отмена</button>
              <button type="button" disabled={busy} onClick={submit}
                className="min-h-11 rounded-lg bg-[var(--color-negative)] px-4 text-white disabled:opacity-50">{busy ? 'Отправляю…' : `В брак · ${cards.length}`}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function BrakNowModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState<string>('nothing_needed');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setErr(null);
    try { await post({ action: 'brak_now', clientKey: card.clientKey, managerId: card.managerId, column: card.column, reason, comment, dealId: card.deal?.dealId ?? card.openDealInBrak ?? undefined }); onSaved(); onClose(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`Сразу в брак · ${cardName(card)}`} desktopWidth="sm:max-w-md">
      <div className="flex flex-col gap-3 text-sm">
        <div className="text-[var(--color-text-secondary)]">Заказчик уйдёт в «Брак» без разбора отказа. Вернуть можно кнопкой «Снять брак».
          {card.deal ? ` Сделка #${card.deal.dealId} закроется в Битриксе в отказную стадию по выбранной причине, комментарий — в ленту сделки.` : ''}</div>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Причина
          <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason}
            options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))} className="w-full justify-start bg-[var(--color-bg)]" />
        </label>
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          Комментарий
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} placeholder="Подвели с отгрузкой, разовая штукатурка на 10 тыс." className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-negative)] px-4 text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'В брак'}</button>
        </div>
      </div>
    </Modal>
  );
}

function ReviewModal({ card, onClose, onSaved }: { card: KanbanCard; onClose: () => void; onSaved: () => void }) {
  // Менеджер просил скрыть (26.10) — по умолчанию согласиться с ним: «Отложить до» его даты; брак — переключением.
  const hr = card.hideRequest;
  const [decision, setDecision] = useState<'brak' | 'no_answer' | 'return' | 'postpone'>(hr ? 'postpone' : 'brak');
  const [reason, setReason] = useState<string>('nothing_needed');
  const [comment, setComment] = useState(hr ? `${hr.comment} (предложил ${hr.by})` : '');
  const [until, setUntil] = useState(hr?.until ?? postponePresets()[0].value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Правило: брак без дозвона и до трёх попыток — только с комментарием РОПа.
  const done = card.attempts?.reached ? TOUCHES : Math.min(card.attempts?.count ?? 0, TOUCHES);
  const needComment = decision === 'brak' && done < TOUCHES;

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await post({ action: 'review', clientKey: card.clientKey, managerId: card.managerId, column: card.column, dealId: card.deal?.dealId,
        decision, reason: decision === 'brak' ? reason : null, comment, touchesDone: done, until: decision === 'postpone' ? until : undefined });
      onSaved(); onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };

  const POSTPONE = { v: 'postpone' as const, label: hr ? `Отложить до ${fmtHideUntil(hr.until).replace(/^до /, '')}, как просит менеджер` : 'Отложить до…',
    hint: 'Не брак: «позже», «весной». Сделка — «Больше ничего не нужно», заказчик в «Скрытых» до даты, потом вернётся в пул' };
  const options = card.dozvonFail ? [
    // Выход из дозвона: сделка ещё открыта — «недозвон» оставляет её в дозвоне (ещё попытки).
    { v: 'brak' as const, label: 'Брак', hint: 'Не дозвониться — заказчик уходит из пула, сделка закроется в Битриксе по причине' },
    { v: 'no_answer' as const, label: 'Ещё попытки', hint: 'Оставить в дозвоне — менеджер звонит дальше' },
    { v: 'return' as const, label: 'Вернуть менеджеру', hint: 'Попытки формальные — менеджеру уйдёт задача с вашим сообщением' },
    POSTPONE,
  ] : [
    { v: 'brak' as const, label: 'Брак', hint: 'Отказ подтверждён — заказчик уходит из пула' },
    { v: 'no_answer' as const, label: 'Недозвон', hint: 'Не брак — вернуть в пул' },
    { v: 'return' as const, label: 'Вернуть менеджеру', hint: 'Отработано плохо — сделка вернётся в первую стадию, менеджеру — задача с вашим сообщением' },
    POSTPONE,
  ];
  if (hr) options.sort((a, b) => Number(b.v === 'postpone') - Number(a.v === 'postpone'));

  return (
    <Modal open onOpenChange={o => { if (!o) onClose(); }} title={`${card.dozvonFail ? 'Разбор дозвона' : 'Разбор отказа'} · ${cardName(card)}`} desktopWidth="sm:max-w-lg">
      <div className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg bg-[var(--color-bg-surface)] p-3">
          {card.deal && (
            <a href={dealUrl(card.deal.dealId)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[var(--color-accent)] hover:underline">
              <ExternalLink size={13} /> Сделка #{card.deal.dealId} · {card.deal.stageName}
            </a>
          )}
          <div className="mt-1 text-[var(--color-text-secondary)]">{card.managerName} · {card.dozvonFail ? `${TOUCHES} попытки в разные дни, дозвона нет` : `закрыта ${fmtDay(card.deal?.lostAt ?? null)}`}</div>
          {card.attempts && <div className="mt-2">Попыток связаться: <b>{card.attempts.count}</b>{card.attempts.reached ? ' · дозвонились' : ' · не дозвонились'}{card.attempts.days.length ? ` (${card.attempts.days.map(d => d.split('-').reverse().slice(0, 2).join('.')).join(', ')})` : ''}</div>}
          <div className="mt-2 text-xs text-[var(--color-text-muted)]">Звонки по сделке:</div>
          {card.calls.length === 0 ? <div className="text-[var(--color-negative)]">Звонков нет</div> : (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs">
              {card.calls.map((x, i) => (
                <li key={i} className={x.missed ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text)]'}>
                  {fmtDT(x.at)} · {x.missed ? 'недозвон' : fmtSec(x.sec)}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-2" role="radiogroup">
          {options.map(o => (
            <label key={o.v} className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-lg border p-2 ${decision === o.v ? 'border-[var(--color-accent)]' : 'border-[var(--color-border)]'}`}>
              <input type="radio" name="decision" checked={decision === o.v} onChange={() => setDecision(o.v)} className="mt-0.5 h-4 w-4" />
              <span><span className="font-medium text-[var(--color-text)]">{o.label}</span><br /><span className="text-xs text-[var(--color-text-muted)]">{o.hint}</span></span>
            </label>
          ))}
        </div>
        {decision === 'postpone' && <PostponePicker value={until} onChange={setUntil} />}
        {decision === 'brak' && (
          <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
            Причина
            <SearchSelect ariaLabel="Причина брака" value={reason} onChange={setReason}
              options={BRAK_REASONS.map(r => ({ value: r.value, label: r.label }))}
              className="w-full justify-start bg-[var(--color-bg)]" />
          </label>
        )}
        <label className="flex flex-col gap-1 text-[var(--color-text-secondary)]">
          {decision === 'return' ? 'Сообщение менеджеру — уйдёт в задачу (обязательно)' : decision === 'postpone' ? 'Почему откладываем (обязательно)' : needComment ? `Комментарий (обязательно: попыток ${done} из ${TOUCHES}, без дозвона)` : 'Комментарий'}
          <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} className={fieldCls} />
        </label>
        {err && <p className="text-[var(--color-negative)]">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-lg px-4 text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Отмена</button>
          <button type="button" disabled={busy || ((needComment || decision === 'return' || decision === 'postpone') && comment.trim().length < 3) || (decision === 'postpone' && !until)} onClick={submit}
            className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-white disabled:opacity-50">
            {busy ? 'Сохраняю…' : 'Сохранить решение'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
