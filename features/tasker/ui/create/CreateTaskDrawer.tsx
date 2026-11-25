'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, Info, Users } from 'lucide-react';
import { Drawer } from '@/components/ui/Drawer';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/SearchSelect';
import { SearchMultiSelect } from '@/components/ui/SearchMultiSelect';
import type {
  Snapshot, TaskerCreateRequest, TaskerCreateResponse, TaskerMetric, TaskerSession, TaskerTaskKind,
} from '@/features/tasker/types';
import {
  createTasks, fetchAssignableManagers, fetchProductGroups, fetchCreators, fetchCustomers, fetchMetrics, fetchSessions, fetchSnapshot,
  fetchTemplates, fetchUpcomingTrainings, TaskerApiError,
} from './api';
// Проверка наложения времени у слота сессии (сессия A).
import { AvailabilityWarning } from '../shared/AvailabilityWarning';
import { renderTemplateBody, templateToBitrix } from '../templates/templateBody';
import { TASKER_METRIC_GROUP_LABELS, type TaskerAvailabilityRequest } from '@/features/tasker/types';
import { aboveDept, aboveDeptLabel, defaultGoal, goalWorseThanCurrent } from '@/features/tasker/goal';

/**
 * Форма постановки задачи «подтянуть показатель» (Задачник, сессия C; ТЗ —
 * ai_docs/fresh_docs/TASKER_SPEC.md, «Сценарий» п.1–2). Входы: строка отчёта «По
 * менеджерам», шапка карточки менеджера, кнопка «Новая задача» в /tasker (сессия B).
 *
 * Drawer: на десктопе — панель справа, на телефоне — на весь экран (components/ui/Drawer).
 * Состояние формы живёт во внутреннем компоненте: Radix размонтирует содержимое при
 * закрытии, поэтому каждое открытие начинается с чистого листа и свежих пропсов.
 */
export interface CreateTaskDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Предвыбранные менеджеры (Bitrix user id строкой, как dimensionId в отчёте). */
  managerIds?: string[];
  /** Предвыбранный показатель — применяется, только если он в белом списке. */
  metricId?: string;
  /** Период снимка (YYYY-MM-DD или Date). Нет — текущий месяц по сегодня. */
  period?: { from: string | Date; to: string | Date };
  onCreated?: (res: TaskerCreateResponse) => void;
  /** Варианты для поля «Менеджеры» сверх серверного списка (строки отчёта, сам менеджер карточки). */
  managerOptions?: SearchSelectOption[];
  /** Запасные кандидаты на показатель (колонки отчёта по порядку), если metricId не в белом списке. */
  metricCandidates?: string[];
  /** Тип задачи при открытии: 'theory' — «Отправить на обучение» (исполнитель — тренер). Нет — «Практика». */
  kind?: TaskerTaskKind;
}

export function CreateTaskDrawer(props: CreateTaskDrawerProps) {
  return (
    <Drawer
      open={props.open}
      onOpenChange={o => { if (!o) props.onClose(); }}
      title="Поставить задачу"
      desktopWidth="sm:max-w-[640px]"
      bodyClassName="p-0"
    >
      <CreateTaskForm {...props} />
    </Drawer>
  );
}

// ── даты ────────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toYmd = (v: string | Date) => (typeof v === 'string' ? v.slice(0, 10) : ymd(v));
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const fmtSlot = (iso: string) => new Date(iso).toLocaleString('ru-RU', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

// ── формат значений ────────────────────────────────────────────────────────

function fmtValue(v: number | null | undefined, format: TaskerMetric['format'] | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (format === 'percent') return `${v.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  if (format === 'money') return `${Math.round(v).toLocaleString('ru-RU')} ₽`;
  return v.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}
const unitOf = (format: TaskerMetric['format'] | undefined) =>
  format === 'percent' ? '%' : format === 'money' ? '₽' : '';
const roundForInput = (v: number, format: TaskerMetric['format'] | undefined) =>
  String(format === 'money' ? Math.round(v) : Math.round(v * 10) / 10).replace('.', ',');

// ── стили ───────────────────────────────────────────────────────────────────

const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-surface)] px-3 text-base text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] disabled:opacity-50 sm:text-sm';

function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ''}`}>
      <span className="text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}

const DURATIONS = [15, 30, 45, 60, 90];

// ── форма ───────────────────────────────────────────────────────────────────

function CreateTaskForm({ onClose, managerIds: initialManagers, metricId: initialMetric, period, onCreated, managerOptions: extraManagers, metricCandidates, kind: initialKind }: CreateTaskDrawerProps) {
  const today = ymd(new Date());

  const metricsQ = useQuery({ queryKey: ['tasker', 'metrics'], queryFn: fetchMetrics, staleTime: 5 * 60_000 });
  const managersQ = useQuery({ queryKey: ['tasker', 'managers'], queryFn: fetchAssignableManagers, staleTime: 5 * 60_000, retry: false });
  const trainingsQ = useQuery({ queryKey: ['tasker', 'trainings-upcoming'], queryFn: fetchUpcomingTrainings, staleTime: 60_000, retry: false });

  // Архивные темы (миграция 282) в форме не предлагаются.
  const metrics = useMemo(() => (metricsQ.data?.metrics ?? []).filter(m => m.active !== false && m.kind !== 'deal'), [metricsQ.data]);

  const [managerIds, setManagerIds] = useState<string[]>(initialManagers ?? []);
  const [metricId, setMetricId] = useState('');
  const [periodFrom, setPeriodFrom] = useState(period ? toYmd(period.from) : `${today.slice(0, 8)}01`);
  const [periodTo, setPeriodTo] = useState(period ? toYmd(period.to) : today);

  const [target, setTarget] = useState('');
  const [targetTouched, setTargetTouched] = useState(false);
  // Рекомендации (правки собрания 23.11): вариант шаблона по показателю (конструктор «Шаблоны») + «дописать своё».
  // templateChoice: '' — ещё не выбран (подставится первый вариант), 'none' — без шаблона, иначе id варианта.
  const [templateChoice, setTemplateChoice] = useState('');
  const [extra, setExtra] = useState('');
  const [templateOpen, setTemplateOpen] = useState(false);

  const [withCustomers, setWithCustomers] = useState(false);
  const [uncheckedCustomers, setUncheckedCustomers] = useState<Set<string>>(new Set());

  const [deadline, setDeadline] = useState(addDays(today, 7));
  const [durationMin, setDurationMin] = useState(30);
  const [slot, setSlot] = useState('');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [newSession, setNewSession] = useState(true);
  const [controlDate, setControlDate] = useState(addDays(addDays(today, 7), 7));
  const [controlTouched, setControlTouched] = useState(false);
  const [trainingId, setTrainingId] = useState('');
  const [creatorId, setCreatorId] = useState(''); // '' = сам пользователь
  // Теория / Практика (сессия A, правка 23.11): исполнитель — тренер из настроек или постановщик (РОП).
  const [kind, setKind] = useState<TaskerTaskKind>(initialKind ?? 'practice');

  // «Теория» — можно отправить на продуктовое обучение: к темам добавляются товарные группы, у которых темы ещё нет
  // (id pg_<id>_amount — замер по сумме продаж группы; тема заводится сервером при постановке, engine/topics.ts).
  const pgQ = useQuery({ queryKey: ['tasker', 'product-groups'], queryFn: fetchProductGroups, enabled: kind === 'theory', staleTime: 30 * 60_000 });
  const topicList = useMemo<TaskerMetric[]>(() => {
    const own = [...metrics].sort((a, b) => Number(a.kind === 'product_group') - Number(b.kind === 'product_group'));
    if (kind !== 'theory') return own;
    const taken = new Set((metricsQ.data?.metrics ?? []).filter(m => m.kind === 'product_group' && m.active !== false).map(m => m.productGroupId));
    const extra: TaskerMetric[] = (pgQ.data ?? []).filter(g => !taken.has(g.id)).map(g => ({
      id: `pg_${g.id}_amount`, label: g.name, group: 'product', higherIsBetter: true, format: 'money', tag: g.name.slice(0, 40),
      sortOrder: 9999, kind: 'product_group', productGroupId: g.id, pgMeasure: 'amount', active: true,
    }));
    return [...own, ...extra];
  }, [metrics, metricsQ.data, pgQ.data, kind]);
  // Ушли с «Теории» с выбранной группой без темы — выбор сбрасывается (в «Практике» таких пунктов нет).
  useEffect(() => {
    if (metricId && metrics.length && !topicList.some(m => m.id === metricId)) setMetricId('');
  }, [topicList, metricId, metrics.length]);

  const [result, setResult] = useState<TaskerCreateResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Показатель по умолчанию — колонка, у которой нажали (если в белом списке), иначе
  // первая колонка отчёта из белого списка; ничего не подошло — выбирает человек.
  useEffect(() => {
    if (metricId || metrics.length === 0) return;
    const ids = new Set(metrics.map(m => m.id));
    const pick = [initialMetric, ...(metricCandidates ?? [])].find(id => id && ids.has(id));
    if (pick) setMetricId(pick);
  }, [metrics, metricId, initialMetric, metricCandidates]);

  const metric = topicList.find(m => m.id === metricId);
  const managerIdNums = useMemo(() => managerIds.map(Number).filter(Number.isFinite), [managerIds]);

  // Варианты менеджеров: серверный список (кому можно ставить) + переданные входом +
  // предвыбранные (SearchMultiSelect выкидывает значения, которых нет в options).
  const managerOptions = useMemo<SearchSelectOption[]>(() => {
    const map = new Map<string, SearchSelectOption>();
    for (const m of managersQ.data ?? []) map.set(String(m.id), { value: String(m.id), label: m.name, hint: m.deptName ?? null });
    for (const o of extraManagers ?? []) if (!map.has(o.value)) map.set(o.value, o);
    for (const id of initialManagers ?? []) if (!map.has(id)) map.set(id, { value: id, label: `#${id}` });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
  }, [managersQ.data, extraManagers, initialManagers]);
  const managerName = (id: string) => managerOptions.find(o => o.value === id)?.label ?? `#${id}`;

  // ── постановщик (правка директора по продажам 23.11) ──
  // Список зависит от выбранных менеджеров (их РОПы/директора); выбор, выпавший из списка, — назад к себе.
  const creatorsQ = useQuery({
    queryKey: ['tasker', 'creators', managerIdNums.join(',')],
    queryFn: () => fetchCreators(managerIdNums),
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: prev => prev,
  });
  const creatorOptions = useMemo<SearchSelectOption[]>(
    () => (creatorsQ.data?.creators ?? []).map(c => ({
      value: c.role === 'self' ? '' : String(c.id),
      label: c.role === 'self' ? `${c.name} (вы)` : c.name,
      hint: c.role === 'self' ? null : c.hint,
    })),
    [creatorsQ.data],
  );
  useEffect(() => {
    if (creatorId && creatorsQ.data && !creatorOptions.some(o => o.value === creatorId)) setCreatorId('');
  }, [creatorId, creatorsQ.data, creatorOptions]);

  // ── снимок ──
  const periodOk = !!periodFrom && !!periodTo && periodFrom <= periodTo;
  const snapshotQ = useQuery({
    queryKey: ['tasker', 'snapshot', managerIdNums.join(','), metricId, periodFrom, periodTo],
    queryFn: () => fetchSnapshot(managerIdNums, metricId, { from: periodFrom, to: periodTo }),
    enabled: managerIdNums.length > 0 && !!metricId && periodOk,
    staleTime: 60_000,
    retry: false,
  });
  const snapshot = snapshotQ.data;

  // Цель по умолчанию — features/tasker/goal.ts (то же правило на сервере): лучшее из (среднее отдела,
  // своё за 6 мес); кто уже не хуже — текущее +10 %. Один менеджер — подставляем число; несколько —
  // у каждого своя цель (видна в снимке), поле пустое (= сервер посчитает по каждому).
  const goals = useMemo(() => {
    const out: Record<string, ReturnType<typeof defaultGoal>> = {};
    if (metric && snapshot) for (const id of managerIdNums) out[String(id)] = defaultGoal(metric, snapshot[String(id)]);
    return out;
  }, [metric, snapshot, managerIdNums]);
  const singleGoal = managerIdNums.length === 1 ? goals[String(managerIdNums[0])] : undefined;
  useEffect(() => {
    if (targetTouched) return;
    if (managerIdNums.length === 1 && singleGoal?.target != null) setTarget(roundForInput(singleGoal.target, metric?.format));
    else setTarget('');
  }, [singleGoal, managerIdNums, targetTouched, metric?.format]);
  const manualTarget = useMemo(() => {
    const t = target.trim().replace(/\s/g, '').replace(',', '.');
    return targetTouched && t !== '' && Number.isFinite(Number(t)) ? Number(t) : null;
  }, [target, targetTouched]);
  // Ручная цель хуже текущего (кроме «мало данных») — сервер вернёт 400, предупреждаем заранее.
  const worseFor = metric && snapshot && manualTarget !== null
    ? managerIdNums.filter(id => goalWorseThanCurrent(metric, manualTarget, snapshot[String(id)])) : [];

  // ── шаблоны ──
  const templatesQ = useQuery({
    queryKey: ['tasker', 'templates', metricId],
    queryFn: () => fetchTemplates(metricId),
    enabled: !!metricId,
    staleTime: 5 * 60_000,
  });
  const templates = useMemo(() => templatesQ.data?.templates ?? [], [templatesQ.data]);
  useEffect(() => { setTemplateChoice(''); setTemplateOpen(false); }, [metricId]);
  // Не выбран явно — первый вариант показателя (порядок задают в «Шаблонах»), чтобы форма не открывалась пустой.
  const template = templateChoice === 'none' ? null
    : templates.find(t => String(t.id) === templateChoice) ?? (templateChoice === '' ? templates[0] ?? null : null);
  const templateId = template?.id ?? null;
  const body = [template ? templateToBitrix(template.body) : '', extra.trim()].filter(Boolean).join('\n\n');

  // ── заказчики из повторки ──
  const customerQs = useQueries({
    queries: managerIdNums.map(id => ({
      queryKey: ['tasker', 'customers', id],
      queryFn: () => fetchCustomers(id),
      enabled: withCustomers,
      staleTime: 60_000,
      retry: false,
    })),
  });
  const customerGroups = managerIdNums.map((id, i) => ({
    managerId: id,
    loading: customerQs[i]?.isLoading ?? false,
    error: customerQs[i]?.error as Error | null,
    customers: customerQs[i]?.data?.customers ?? [],
  }));
  const checkedCustomers = withCustomers
    ? [...new Set(customerGroups.flatMap(g => g.customers.map(c => c.clientKey)))].filter(k => !uncheckedCustomers.has(k))
    : [];

  // ── сессии ──
  const sessionsQ = useQuery({
    queryKey: ['tasker', 'sessions', metricId, today],
    queryFn: () => fetchSessions(metricId, today, addDays(today, 21)),
    enabled: !!metricId,
    staleTime: 60_000,
    retry: false,
  });
  // Исполнитель задачи: «Теория» — тренер, «Практика» — постановщик (выбранный или сам пользователь).
  const trainer = metricsQ.data?.trainer ?? null;
  const executorId = kind === 'theory' ? trainer?.id ?? null : creatorId ? Number(creatorId) : creatorsQ.data?.selfId ?? null;
  // Сессии — только этого исполнителя: сессия = его встреча с несколькими менеджерами.
  const sessions: TaskerSession[] = useMemo(
    () => (sessionsQ.data?.sessions ?? [])
      .filter(s => new Date(s.slotStart).getTime() > Date.now() && (executorId == null || s.rop.id === executorId))
      .slice(0, 3),
    [sessionsQ.data, executorId],
  );
  useEffect(() => { setSessionId(null); }, [metricId, executorId]);

  // Контрольная дата следует за сроком (+7: «показатели смотрим неделя через неделю»), пока её не правили руками.
  useEffect(() => { if (!controlTouched && deadline) setControlDate(addDays(deadline, 7)); }, [deadline, controlTouched]);

  const trainings = trainingsQ.data;
  const trainingOptions = useMemo<SearchSelectOption[]>(
    () => (trainings ?? []).map(t => ({ value: String(t.id), label: t.title, hint: [fmtSlot(t.startsAt), t.place].filter(Boolean).join(' · ') })),
    [trainings],
  );

  // ── отправка ──
  const buildRequest = (ids: number[], overrideLimits = false): TaskerCreateRequest => {
    const t = target.trim().replace(/\s/g, '').replace(',', '.');
    return {
      managerIds: ids,
      metricId,
      period: { from: periodFrom, to: periodTo },
      target: targetTouched && t !== '' && Number.isFinite(Number(t)) ? Number(t) : undefined,
      body: body.trim(),
      templateId,
      deadline,
      durationMin,
      // Записан на занятие — время задачи = время занятия (сервер берёт его сам); своё время/сессия не шлются.
      // Иначе у задачи два времени: Пуртиков 25.11 — «Теория» на 15:00 и запись на групповое в 16:15.
      slot: trainingId || sessionId ? null : slot ? { start: new Date(slot).toISOString() } : null,
      sessionId: trainingId ? null : sessionId,
      newSession: !trainingId && !sessionId && !!slot && newSession,
      controlDate,
      customersChecklist: checkedCustomers.length ? checkedCustomers : undefined,
      trainingEventId: trainingId ? Number(trainingId) : null,
      ...(overrideLimits ? { overrideLimits: true } : {}),
      creatorBitrixId: creatorId ? Number(creatorId) : null,
      kind,
    };
  };

  const mutation = useMutation({
    mutationFn: (req: TaskerCreateRequest) => createTasks(req),
    onMutate: () => setSubmitError(null),
    onSuccess: res => {
      setResult(prev => prev
        ? { created: [...prev.created, ...res.created], warnings: res.warnings }
        : res);
      if (res.created.length) onCreated?.(res);
    },
    onError: (e: unknown) => {
      setSubmitError(e instanceof TaskerApiError && e.code === 'not_configured'
        ? 'Проект «Задачник» в Битриксе ещё не настроен — задачу поставить нельзя.'
        : e instanceof Error ? e.message : 'Не удалось поставить задачу');
    },
  });

  const problems: string[] = [];
  if (managerIdNums.length === 0) problems.push('выберите менеджера');
  if (!metricId) problems.push('выберите тему');
  if (!periodOk) problems.push('проверьте период');
  if (!body.trim()) problems.push('заполните рекомендации');
  if (!deadline) problems.push('укажите срок');
  if (!controlDate) problems.push('укажите контрольную дату');
  const canSubmit = problems.length === 0 && !mutation.isPending;

  if (result) {
    return <ResultView result={result} pending={mutation.isPending} error={submitError} managerName={id => managerName(String(id))}
      onClose={onClose}
      onOverride={ids => mutation.mutate(buildRequest(ids, true))} />;
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-col gap-4 p-4">
        {metricsQ.data && !metricsQ.data.bitrixConfigured && (
          <Banner tone="warn">Проект «Задачник» в Битриксе ещё не настроен (ждём ID группы) — создание задачи вернёт ошибку.</Banner>
        )}
        {metricsQ.error && <Banner tone="error">Не загрузился список тем: {(metricsQ.error as Error).message}</Banner>}

        <KindSwitch kind={kind} onKind={setKind} trainerName={trainer?.name ?? null} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Менеджеры" hint="Несколько — у каждого своя задача и свой снимок">
            <SearchMultiSelect options={managerOptions} value={managerIds} onChange={setManagerIds}
              allLabel="Выберите менеджеров" unitLabel="менеджеров" ariaLabel="Менеджеры" className="w-full" />
          </Field>
          <Field label="Тема" hint={metric ? `${metric.kind === 'product_group' ? (metric.pgMeasure === 'share' ? 'Товарная группа: доля в продажах · ' : 'Товарная группа: сумма продаж · ') : ''}${metric.higherIsBetter ? 'Больше — лучше' : 'Меньше — лучше'}` : undefined}>
            {/* Темы — из конструктора «Задачник → Шаблоны» (миграция 282): показатель каталога или товарная группа. */}
            <SearchSelect
              searchable
              options={topicList.map(m => m.kind === 'product_group'
                ? { value: m.id, label: m.label, group: 'Товарные группы', hint: m.pgMeasure === 'share' ? 'Доля в продажах' : 'Сумма продаж группы' }
                : { value: m.id, label: m.label, group: 'Показатели', hint: TASKER_METRIC_GROUP_LABELS[m.group] })}
              value={metricId} onChange={setMetricId}
              placeholder={metricsQ.isLoading ? 'Загрузка…' : 'Выберите тему'}
              ariaLabel="Тема" className="w-full" disabled={metricsQ.isLoading}
            />
          </Field>
        </div>

        {creatorOptions.length > 1 && (
          <Field label="Постановщик" hint={`${creatorId ? 'Задача — от его имени, вы останетесь в ней наблюдателем' : 'По умолчанию — вы'}${kind === 'practice' ? '. Он же исполнитель' : ''}`}>
            <SearchSelect options={creatorOptions} value={creatorId} onChange={setCreatorId}
              placeholder="Вы" ariaLabel="Постановщик" className="w-full sm:max-w-[calc(50%-8px)]" />
          </Field>
        )}

        {/* Период снимка нужен редко — свёрнут в строку под заголовком блока цифр (аудит 23.11: два поля дат
            перед цифрами выглядели как обязательный технический шаг). */}
        <details className="-mb-2 text-[13px] text-[var(--color-text-secondary)]">
          <summary className="min-h-11 cursor-pointer content-center">
            Цифры за {fmtPeriod(periodFrom)} – {fmtPeriod(periodTo)} · <span className="text-[var(--color-accent)]">изменить период</span>
          </summary>
          <div className="grid grid-cols-2 gap-3 pb-2">
            <Field label="С">
              <input type="date" value={periodFrom} max={periodTo} onChange={e => setPeriodFrom(e.target.value)} className={INPUT} />
            </Field>
            <Field label="По">
              <input type="date" value={periodTo} min={periodFrom} onChange={e => setPeriodTo(e.target.value)} className={INPUT} />
            </Field>
          </div>
        </details>

        <SnapshotBlock
          managerIds={managerIds} managerName={managerName} metric={metric}
          loading={snapshotQ.isFetching} error={snapshotQ.error as Error | null} data={snapshot}
          ready={managerIdNums.length > 0 && !!metricId}
          goals={goals} manualTarget={manualTarget}
        />

        <Field label={`Цель${unitOf(metric?.format) ? `, ${unitOf(metric?.format)}` : ''}`}
          hint={targetTouched
            ? (manualTarget !== null ? 'Своя цель — одна на всех выбранных' : managerIdNums.length > 1 ? 'Пусто — у каждого своя цель (см. снимок)' : 'Пусто — цель посчитается сама')
            : managerIdNums.length > 1 ? 'Пусто — у каждого своя цель (см. снимок): лучшее из средних, а кто уже выше — +10 % к текущему'
            : singleGoal?.reason ?? 'По умолчанию — лучшее из (среднее по отделу, своё за 6 мес)'}>
          <input inputMode="decimal" value={target} placeholder={managerIdNums.length > 1 ? 'У каждого своя' : '—'}
            onChange={e => { setTarget(e.target.value); setTargetTouched(true); }} className={`${INPUT} sm:max-w-[200px]`} />
          {worseFor.length > 0 && (
            <span className="flex items-start gap-1.5 text-[12px] leading-snug text-[var(--color-warning,#b45309)]">
              <AlertTriangle size={14} className="mt-px shrink-0" />
              <span>
                Цель {metric?.higherIsBetter ? 'ниже' : 'выше'} текущего{managerIdNums.length > 1 ? ` у ${worseFor.map(id => managerName(String(id))).join(', ')}` : ''} — задача на ухудшение?
                Такую цель сервер не примет: поставьте не хуже текущего или очистите поле.
              </span>
            </span>
          )}
        </Field>

        <Field label="Рекомендации" hint="Вариант инструкции и ваш текст уходят в описание задачи Битрикса вместе с целью и снимком. Варианты правят в «Задачник → Шаблоны»">
          {templates.length > 0 && (
            <SearchSelect
              options={[
                ...templates.map(t => ({ value: String(t.id), label: t.title })),
                { value: 'none', label: 'Без шаблона — только своё' },
              ]}
              value={template ? String(template.id) : 'none'}
              onChange={v => { setTemplateChoice(v); setTemplateOpen(false); }}
              placeholder="Вариант инструкции" ariaLabel="Вариант инструкции" className="w-full"
            />
          )}
          {template && (
            <div className="min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-hover)]/40 p-3">
              <div className={`whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--color-text)] ${templateOpen ? '' : 'line-clamp-5'}`}>
                {renderTemplateBody(template.body)}
              </div>
              {(template.body.length > 240 || template.body.split('\n').length > 5) && (
                <button type="button" onClick={() => setTemplateOpen(o => !o)} className="mt-1 min-h-8 text-xs text-[var(--color-accent)] hover:underline">
                  {templateOpen ? 'Свернуть' : 'Показать целиком'}
                </button>
              )}
            </div>
          )}
          {metricId && !templatesQ.isLoading && templates.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">Для этой темы вариантов инструкции пока нет — напишите своё.</p>
          )}
          <textarea value={extra} rows={template ? 3 : 6}
            onChange={e => setExtra(e.target.value)}
            aria-label={template ? 'Дописать своё' : 'Рекомендации'}
            placeholder={!metricId ? 'Сначала выберите тему' : template ? 'Дописать своё (необязательно)…' : 'Что сделать…'}
            className={`${INPUT} ${template ? 'min-h-[80px]' : 'min-h-[120px]'} resize-y py-2 leading-snug`} />
        </Field>

        <CustomersBlock
          enabled={withCustomers} onToggle={setWithCustomers}
          groups={customerGroups} managerName={id => managerName(String(id))} multi={managerIdNums.length > 1}
          unchecked={uncheckedCustomers}
          onToggleCustomer={key => setUncheckedCustomers(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          disabled={managerIdNums.length === 0}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Срок">
            <input type="date" value={deadline} min={today} onChange={e => setDeadline(e.target.value)} className={INPUT} />
          </Field>
          <Field label="Контрольная дата замера" hint="Автозамер показателя и вердикт. По умолчанию срок + 7 дней (неделя после работы) — можно поменять">
            <input type="date" value={controlDate} min={deadline || today}
              onChange={e => { setControlDate(e.target.value); setControlTouched(true); }} className={INPUT} />
          </Field>
        </div>

        <Field label="Длительность">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Длительность">
            {DURATIONS.map(d => (
              <button key={d} type="button" role="radio" aria-checked={durationMin === d} onClick={() => setDurationMin(d)}
                className={`min-h-11 min-w-14 rounded-lg border px-3 text-sm font-medium transition-colors ${durationMin === d
                  ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]'
                  : 'border-[var(--color-border)] text-[var(--color-text)] hover:bg-[var(--color-bg-hover)]'}`}>
                {d} мин
              </button>
            ))}
          </div>
        </Field>

        {/* Сначала — на какое занятие, потом — время. Записан на занятие → время занятия, своё не выбирается
            (иначе два времени у одной задачи). Не записан → своё время: для «Теории» это занятие один на один. */}
        {trainings && trainings.length > 0 && (
          <Field label={kind === 'theory' ? 'Групповое занятие тренера' : 'Записать на обучение'}
            hint={trainingId
              ? `Время задачи — время занятия: ${trainingOptions.find(o => o.value === trainingId)?.hint ?? ''}. Своё время не нужно`
              : kind === 'theory' ? 'Не записываете — ниже выберите время: занятие будет один на один' : 'Ссылка на обучение попадёт в описание задачи'}>
            <SearchSelect options={trainingOptions} value={trainingId} onChange={setTrainingId}
              allLabel={kind === 'theory' ? 'Нет — один на один, своё время' : 'Не записывать'} ariaLabel="Записать на обучение" className="w-full" />
          </Field>
        )}

        {!trainingId && (
        <SessionBlock
          sessions={sessions} sessionId={sessionId} onSession={setSessionId}
          slot={slot} onSlot={setSlot} newSession={newSession} onNewSession={setNewSession}
          metricLabel={metric?.label}
          availability={slotAvailability(sessions, sessionId, slot, durationMin, managerIdNums, kind === 'theory' ? trainer?.id ?? null : creatorId ? Number(creatorId) : null)}
        />
        )}

        {submitError && <Banner tone="error">{submitError}</Banner>}
      </div>

      <div className="sticky bottom-0 mt-auto flex flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-bg-overlay)] p-4 [backdrop-filter:var(--glass-blur)] sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-xs text-[var(--color-text-muted)]">
          {problems.length ? `Осталось: ${problems.join(', ')}` : managerIdNums.length > 1 ? `Будет создано задач: ${managerIdNums.length}` : 'Задача уйдёт в Битрикс, проект «Задачник»'}
        </span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose}
            className="min-h-11 flex-1 rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] sm:flex-none">
            Отмена
          </button>
          <button type="button" disabled={!canSubmit} onClick={() => mutation.mutate(buildRequest(managerIdNums))}
            className="min-h-11 flex-1 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white disabled:opacity-50 sm:flex-none">
            {mutation.isPending ? 'Ставлю…' : 'Поставить задачу'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── блоки ───────────────────────────────────────────────────────────────────

export function Banner({ tone, children }: { tone: 'warn' | 'error' | 'info'; children: React.ReactNode }) {
  const color = tone === 'error' ? 'var(--color-negative)' : tone === 'warn' ? 'var(--color-warning, #b45309)' : 'var(--color-accent)';
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] leading-snug text-[var(--color-text)]"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)` }}>
      <Icon size={15} className="mt-0.5 shrink-0" style={{ color }} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** «2026-11-01» → «01.11» */
const fmtPeriod = (ymd: string) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(8)}.${ymd.slice(5, 7)}` : ymd || '…');

function SnapshotBlock({ managerIds, managerName, metric, loading, error, data, ready, goals, manualTarget }: {
  managerIds: string[]; managerName: (id: string) => string; metric: TaskerMetric | undefined;
  loading: boolean; error: Error | null; data: Record<string, Snapshot> | undefined; ready: boolean;
  goals: Record<string, ReturnType<typeof defaultGoal>>; manualTarget: number | null;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-surface)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-text-muted)]">Снимок цифр</span>
        {loading && <span className="text-[11px] text-[var(--color-text-muted)]">считаю…</span>}
      </div>
      {!ready && <span className="text-[13px] text-[var(--color-text-muted)]">Выберите менеджера и тему — цифры посчитаются сами.</span>}
      {ready && error && <span className="text-[13px] text-[var(--color-negative)]">Снимок не посчитался: {error.message}</span>}
      {ready && !error && managerIds.map(id => {
        const s = data?.[id];
        const worse = s && s.value !== null && s.deptAvg !== null && metric
          ? (metric.higherIsBetter ? s.value < s.deptAvg : s.value > s.deptAvg) : false;
        return (
          <div key={id} className="flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2 first:border-t-0 first:pt-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">{managerName(id)}</span>
              {s?.deptName && <span className="truncate text-[11px] text-[var(--color-text-muted)]">{s.deptName}</span>}
              {s && !s.enoughData && (
                <span className="rounded-full bg-[color-mix(in_srgb,var(--color-text-muted)_15%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]"
                  title={s.denominator !== null && s.denominator !== undefined ? `В знаменателе ${s.denominator} — меньше 5` : 'Меньше 5 в знаменателе'}>
                  мало данных
                </span>
              )}
              {metric && aboveDept(metric, s) && (
                <span className="rounded-full bg-[color-mix(in_srgb,var(--color-positive,#16a34a)_15%,transparent)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-positive,#16a34a)]">
                  {aboveDeptLabel(metric)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SnapCell label="Менеджер" value={s ? fmtValue(s.value, metric?.format) : '…'} accent={worse ? 'neg' : undefined} />
              <SnapCell label="Среднее отдела" value={s ? fmtValue(s.deptAvg, metric?.format) : '…'} />
              <SnapCell label="Свое за 6 мес" value={s ? fmtValue(s.ownAvg6m, metric?.format) : '…'} />
              <SnapCell label={manualTarget !== null ? 'Цель (ваша)' : 'Цель'}
                value={s ? fmtValue(manualTarget ?? goals[id]?.target ?? null, metric?.format) : '…'}
                title={manualTarget === null ? goals[id]?.reason : undefined} />
            </div>
            {s && manualTarget === null && managerIds.length > 1 && goals[id] && (
              <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">Цель: {goals[id].reason.charAt(0).toLowerCase() + goals[id].reason.slice(1)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SnapCell({ label, value, accent, title }: { label: string; value: string; accent?: 'neg'; title?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--color-bg)] px-2 py-1.5" title={title}>
      <div className="truncate text-[10px] text-[var(--color-text-muted)]">{label}</div>
      <div className={`truncate text-sm font-semibold tabular-nums ${accent === 'neg' ? 'text-[var(--color-negative)]' : 'text-[var(--color-text)]'}`}>{value}</div>
    </div>
  );
}

function CustomersBlock({ enabled, onToggle, groups, managerName, multi, unchecked, onToggleCustomer, disabled }: {
  enabled: boolean; onToggle: (v: boolean) => void;
  groups: { managerId: number; loading: boolean; error: Error | null; customers: { clientKey: string; title: string; daysLeft: number | null; shippedAt: string | null }[] }[];
  managerName: (id: number) => string; multi: boolean;
  unchecked: Set<string>; onToggleCustomer: (key: string) => void; disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className={`flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-text)] ${disabled ? 'opacity-50' : ''}`}>
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={e => onToggle(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
        <Users size={15} className="shrink-0 text-[var(--color-text-muted)]" />
        <span>Заказчики из повторки <span className="text-[var(--color-text-muted)]">— окно открыто, 1 отгрузка; уйдут чек-листом</span></span>
      </label>
      {enabled && (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto rounded-xl border border-[var(--color-border)] p-2">
          {groups.map(g => (
            <div key={g.managerId} className="flex flex-col">
              {multi && <div className="px-1 pb-1 text-[11px] font-semibold text-[var(--color-text-muted)]">{managerName(g.managerId)}</div>}
              {g.loading && <div className="px-1 py-2 text-xs text-[var(--color-text-muted)]">Загрузка…</div>}
              {g.error && <div className="px-1 py-2 text-xs text-[var(--color-negative)]">{g.error.message}</div>}
              {!g.loading && !g.error && g.customers.length === 0 && (
                <div className="px-1 py-2 text-xs text-[var(--color-text-muted)]">Подходящих заказчиков нет</div>
              )}
              {g.customers.map(c => (
                <label key={c.clientKey} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1 hover:bg-[var(--color-bg-hover)]">
                  <input type="checkbox" checked={!unchecked.has(c.clientKey)} onChange={() => onToggleCustomer(c.clientKey)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
                  <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">{c.title}</span>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">
                    {c.daysLeft !== null ? `ещё ${c.daysLeft} дн.` : c.shippedAt ? fmtDay(c.shippedAt) : ''}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Проверка наложения для слота (предупреждение, не запрет): менеджеры + постановщик; выбранная сессия — её время,
 *  сама сессия не конфликтует сама с собой. */
/** Две кнопки вверху формы вместо поля исполнителя (собрание 23.11: «не надо никого выбирать»). */
function KindSwitch({ kind, onKind, trainerName }: { kind: TaskerTaskKind; onKind: (k: TaskerTaskKind) => void; trainerName: string | null }) {
  const opts: { k: TaskerTaskKind; title: string; sub: string }[] = [
    { k: 'theory', title: `Теория — ${trainerName && !trainerName.startsWith('#') ? trainerName.split(' ')[0] : 'тренер'}`, sub: 'Исполнитель — тренер, он соберёт менеджеров на занятие' },
    { k: 'practice', title: 'Практика — работаю сам', sub: 'Исполнитель — постановщик (РОП), разбор с менеджером' },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Кто исполняет задачу">
      {opts.map(o => {
        const on = kind === o.k;
        return (
          <button key={o.k} type="button" role="radio" aria-checked={on} onClick={() => onKind(o.k)}
            className={`flex min-h-11 min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors ${on
              ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
              : 'border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'}`}>
            <span className={`text-sm font-semibold ${on ? 'text-[var(--color-accent)]' : 'text-[var(--color-text)]'}`}>{o.title}</span>
            <span className="text-[11px] leading-snug text-[var(--color-text-muted)]">{o.sub}</span>
          </button>
        );
      })}
    </div>
  );
}

function slotAvailability(sessions: TaskerSession[], sessionId: number | null, slot: string, durationMin: number, managerIds: number[], creatorId: number | null): TaskerAvailabilityRequest | null {
  const s = sessionId ? sessions.find(x => x.id === sessionId) : null;
  const start = s ? s.slotStart : slot ? new Date(slot).toISOString() : null;
  if (!start || Number.isNaN(Date.parse(start)) || !managerIds.length) return null;
  const dur = (s ? s.durationMin : durationMin) * 60_000;
  return {
    // Постановщик — выбранный в поле «Постановщик» или сам пользователь.
    bitrixIds: creatorId ? [...managerIds, creatorId] : managerIds, includeSelf: !creatorId,
    slots: [{ start, end: new Date(Date.parse(start) + dur).toISOString() }],
    exclude: s ? { sessionId: s.id } : undefined,
  };
}

function SessionBlock({ sessions, sessionId, onSession, slot, onSlot, newSession, onNewSession, metricLabel, availability }: {
  sessions: TaskerSession[]; sessionId: number | null; onSession: (id: number | null) => void;
  slot: string; onSlot: (v: string) => void; newSession: boolean; onNewSession: (v: boolean) => void;
  metricLabel?: string; availability: TaskerAvailabilityRequest | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      {sessions.map(s => {
        const on = sessionId === s.id;
        return (
          <div key={s.id} className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center ${on ? 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]' : 'border-[var(--color-border)]'}`}>
            <CalendarClock size={16} className="hidden shrink-0 text-[var(--color-accent)] sm:block" />
            <span className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--color-text)]">
              У вас уже есть сессия по <b>{s.metricLabel || metricLabel}</b> · {fmtSlot(s.slotStart)}
              {s.managers.length > 0 && <span className="text-[var(--color-text-muted)]"> · {s.managers.length} чел.</span>}
              {' '}— добавить туда?
            </span>
            <button type="button" onClick={() => onSession(on ? null : s.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold ${on ? 'bg-[var(--color-accent)] text-white' : 'border border-[var(--color-accent)] text-[var(--color-accent)]'}`}>
              {on ? 'Добавлено ✓' : 'Добавить'}
            </button>
          </div>
        );
      })}
      {!sessionId && (
        <Field label="Слот сессии" hint="Дата и время встречи с менеджером — плановые даты задачи в Битриксе. Можно не указывать">
          <input type="datetime-local" value={slot} onChange={e => onSlot(e.target.value)} className={`${INPUT} sm:max-w-[260px]`} />
          {slot && (
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-[var(--color-text)]">
              <input type="checkbox" checked={newSession} onChange={e => onNewSession(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-accent)]" />
              Новая сессия по теме — сюда потом можно добавлять однотипные задачи
            </label>
          )}
        </Field>
      )}
      <AvailabilityWarning req={availability} />
    </div>
  );
}

function ResultView({ result, pending, error, managerName, onClose, onOverride }: {
  result: TaskerCreateResponse; pending: boolean; error: string | null;
  managerName: (id: number) => string; onClose: () => void; onOverride: (managerIds: number[]) => void;
}) {
  const limitIds = [...new Set(result.warnings.filter(w => w.code === 'limit_open_tasks' && w.managerId !== null).map(w => w.managerId as number))]
    .filter(id => !result.created.some(t => t.manager.id === id));
  return (
    <div className="flex flex-col gap-4 p-4">
      {result.created.length > 0 ? (
        <div className="flex items-start gap-2.5">
          <CheckCircle2 size={22} className="shrink-0 text-[var(--color-positive,#16a34a)]" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">Поставлено задач: {result.created.length}</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {result.created.map(t => (
                <li key={t.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-[13px] text-[var(--color-text)]">
                  <span className="min-w-0 truncate">{t.manager.name} — {t.metricLabel}</span>
                  {t.bitrixUrl ? (
                    <a href={t.bitrixUrl} target="_blank" rel="noreferrer" className="tap-target inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
                      в Битриксе <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="text-[11px] text-[var(--color-text-muted)]">{t.syncState === 'failed' ? `не ушла в Битрикс: ${t.syncError ?? 'ошибка'}` : 'уходит в Битрикс…'}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <Banner tone="warn">Задачи не поставлены.</Banner>
      )}
      {result.warnings.length > 0 && (
        <div className="flex flex-col gap-2">
          {result.warnings.map((w, i) => (
            <Banner key={i} tone={w.code === 'not_enough_data' ? 'info' : 'warn'}>
              {w.managerId !== null && <b>{managerName(w.managerId)}: </b>}{w.message}
            </Banner>
          ))}
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {limitIds.length > 0 && (
          <button type="button" disabled={pending} onClick={() => onOverride(limitIds)}
            className="min-h-11 rounded-lg border border-[var(--color-border)] px-4 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            title="Лимит «не больше 3 открытых задач» может обойти директор или админ">
            {pending ? 'Ставлю…' : `Поставить сверх лимита (${limitIds.length})`}
          </button>
        )}
        <button type="button" onClick={onClose} className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white">
          Готово
        </button>
      </div>
    </div>
  );
}
